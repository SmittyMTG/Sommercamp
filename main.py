import json
import re
import secrets
import time
import uuid
from datetime import date, datetime as dt
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Request, Depends, Form, UploadFile, File, Body
from fastapi.responses import HTMLResponse, RedirectResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, and_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import (
    User,
    UserSession,
    Ausgabe,
    ActivityLog,
    pwd_context,
    get_db,
)
from auth import login, logout, get_current_user, verify_password
import uvicorn

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
AVATAR_DIR = STATIC_DIR / "uploads" / "avatars"
AVATAR_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

templates = Jinja2Templates(directory=BASE_DIR / "templates")


def static_version(filename: str) -> int:
    """mtime of a static file, used as a cache-busting query param."""
    return int((STATIC_DIR / filename).stat().st_mtime)


# Server-Start-Zeitpunkt: erfasst Backend-Deploys (main.py etc. ändern sich nur
# durch einen Neustart des Prozesses), kombiniert mit den mtimes der Frontend-
# Dateien (die OHNE Neustart wirksam werden) ergibt das die App-weite Version,
# die das Frontend per /api/version abfragt, um sich bei einem neuen Deploy
# selbstständig neu zu laden — siehe checkAppVersion() in app.js.
SERVER_START_TIME = int(dt.now().timestamp())


def app_version() -> str:
    files = [STATIC_DIR / "app.js", STATIC_DIR / "style.css", BASE_DIR / "templates" / "index.html"]
    parts = [str(int(f.stat().st_mtime)) for f in files if f.exists()]
    parts.append(str(SERVER_START_TIME))
    return "-".join(parts)


templates.env.globals["app_version"] = app_version


templates.env.globals["static_version"] = static_version


# Der Server läuft in UTC, alle Nutzer:innen sind aber in Deutschland unterwegs.
# date.today()/datetime.utcnow() liefern daher rund um Mitternacht das FALSCHE
# Datum (z. B. 00:32 Uhr Berliner Zeit im Sommer = 22:32 UTC am Vortag — "heute"
# wäre dann fälschlich noch "gestern"). Für jede nutzerseitig sichtbare
# "heute"-Berechnung (❗-Schnellaktionen, Ausgaben-Datum, Tilgung) daher immer
# diese Helper statt date.today()/datetime.utcnow() verwenden.
BERLIN_TZ = ZoneInfo("Europe/Berlin")


def today_berlin() -> date:
    return dt.now(BERLIN_TZ).date()


# Aktivitäts-Log: absichtlich sehr eng gehalten (nur die Aktionen, bei denen
# eine ANDERE Person konkret betroffen ist — Ausgabe erfasst/bearbeitet,
# Zahlung gemeldet/bestätigt), nicht jeder Klick in der App.
def log_action(db: Session, actor: str, affected: str | None, action: str, message: str):
    if affected == actor:
        affected = None
    db.add(ActivityLog(actor_username=actor, affected_username=affected, action=action, message=message))


# --- Schemas ---
class ExpenseCreate(BaseModel):
    glaubiger_id: int
    schuldner_ids: list[int]
    cash: float
    betreff: str
    datum: str | None = None
    # Optional: fixer Betrag für einzelne Personen (user_id -> Betrag). Wer hier
    # nicht auftaucht, teilt sich den verbleibenden Rest gleichmäßig auf.
    fixed_amounts: dict[int, float] = {}


class SettleRequest(BaseModel):
    to_id: int
    amount: float | None = None


class UserCreate(BaseModel):
    username: str


class UserColorUpdate(BaseModel):
    color: str


class UsernameUpdate(BaseModel):
    username: str


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


# --- Routes ---
@app.get("/", name="index", response_class=HTMLResponse)
def home(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse("index.html", {"request": request, "user": user})


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})


@app.post("/login")
def login_post(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    redirect = RedirectResponse(url=request.url_for("index"), status_code=303)
    if login(request, redirect, username, password, db):
        return redirect
    return RedirectResponse(url="/login?error=1", status_code=303)


@app.get("/logout")
def logout_route(request: Request, response: Response):
    logout(request, response)
    return RedirectResponse(url="/login", status_code=303)


@app.get("/api/version")
def get_app_version():
    """Kein Login nötig — wird von jeder geöffneten Seite (auch /login) regelmäßig
    abgefragt, damit die App einen neuen Deploy selbstständig erkennt und sich
    neu lädt, statt dass man manuell aktualisieren muss."""
    return {"version": app_version()}


def _is_admin_user(user: User) -> bool:
    return bool(user.role and user.role.strip().lower() == "admin")


def _require_admin(db: Session, username: str) -> User | None:
    user = db.query(User).filter(User.username == username).first()
    if not user or not user.role or user.role.strip().lower() != "admin":
        return None
    return user


# --- User-Übersicht (für die Auswahl in der Ausgaben-Maske) ---

@app.get("/api/me")
def get_me(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return {
        "id": me.id,
        "username": me.username,
        "role": me.role,
        "avatar_path": me.avatar_path,
        "color": me.color,
    }


@app.get("/api/users")
def list_users(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    users = db.query(User).order_by(User.username.asc()).all()
    return [
        {"id": u.id, "username": u.username, "role": u.role, "avatar_path": u.avatar_path, "color": u.color}
        for u in users
    ]


# Feste Palette für neu angelegte User (keine der bisher schon vergebenen
# Handfarben doppelt) — Admins können die Farbe danach über
# PATCH /api/users/{id}/color jederzeit ändern.
_DEFAULT_USER_COLOR_PALETTE = [
    "#ffd400", "#ff9f45", "#ff7a7a", "#c9a3ff", "#4fd8cf",
    "#72a7ff", "#4bd58d", "#ff6ec7", "#ffb26b", "#8fd3ff",
]


def _pick_default_user_color(db: Session) -> str:
    used = {u.color for u in db.query(User).filter(User.color.isnot(None)).all()}
    for color in _DEFAULT_USER_COLOR_PALETTE:
        if color not in used:
            return color
    return secrets.choice(_DEFAULT_USER_COLOR_PALETTE)


# Erzeugt ein zufälliges, ausreichend starkes Passwort für neu angelegte User —
# wird dem Admin nach dem Anlegen EINMALIG im Klartext angezeigt (Kopieren-
# Button im Frontend), danach nur noch als Hash gespeichert und nicht mehr
# abrufbar.
def _generate_password() -> str:
    return secrets.token_urlsafe(9)


@app.post("/api/users")
def create_user(request: Request, payload: UserCreate, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Nutzer anlegen"})

    new_username = payload.username.strip()
    if not new_username:
        return JSONResponse(status_code=400, content={"error": "Nutzername darf nicht leer sein"})
    if db.query(User).filter(User.username == new_username).first():
        return JSONResponse(status_code=400, content={"error": "Diesen Nutzernamen gibt es schon"})

    # Admin-Rolle lässt sich (noch) nicht über die UI vergeben — neue User
    # sind immer normale User, ein Admin muss die Rolle bei Bedarf manuell in
    # der Datenbank ändern.
    generated_password = _generate_password()
    user = User(
        username=new_username,
        hashed_password=pwd_context.hash(generated_password),
        role="user",
        color=_pick_default_user_color(db),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "generated_password": generated_password,
    }


@app.patch("/api/users/{user_id}/color")
def update_user_color(user_id: int, request: Request, payload: UserColorUpdate, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Nutzerfarben ändern"})

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return JSONResponse(status_code=404, content={"error": "not found"})

    color = payload.color.strip().lower()
    if not re.fullmatch(r"#[0-9a-f]{6}", color):
        return JSONResponse(status_code=400, content={"error": "Farbe muss ein Hex-Code sein, z. B. #ffd400"})

    user.color = color
    db.commit()
    return {"id": user.id, "color": user.color}


@app.patch("/api/users/{user_id}/username")
def update_username(user_id: int, request: Request, payload: UsernameUpdate, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Nutzer umbenennen"})

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return JSONResponse(status_code=404, content={"error": "not found"})

    new_username = payload.username.strip()
    if not new_username:
        return JSONResponse(status_code=400, content={"error": "Nutzername darf nicht leer sein"})
    if len(new_username) > 40:
        return JSONResponse(status_code=400, content={"error": "Nutzername darf maximal 40 Zeichen haben"})
    if new_username == user.username:
        return {"id": user.id, "username": user.username}
    if db.query(User).filter(User.username == new_username).first():
        return JSONResponse(status_code=400, content={"error": "Diesen Nutzernamen gibt es schon"})

    old_username = user.username
    user.username = new_username

    # username steht statt einer user_id an vielen weiteren Stellen (siehe
    # database.py) — alle mitziehen, sonst würden aktive Logins ungültig
    # (sessions.username) und Berechtigungsprüfungen wie "nur der:die
    # Ersteller:in darf bearbeiten" (created_by == ...) nach dem Umbenennen
    # plötzlich fehlschlagen. ActivityLog bleibt bewusst unverändert — das
    # ist ein historisches Protokoll, dessen Nachrichtentexte den alten Namen
    # ohnehin schon fest eingebettet haben.
    db.query(UserSession).filter(UserSession.username == old_username).update({"username": new_username})
    db.query(Ausgabe).filter(Ausgabe.created_by == old_username).update({"created_by": new_username})
    db.commit()

    return {"id": user.id, "username": user.username}


def _load_ui_state(user: User) -> dict:
    try:
        state = json.loads(user.ui_state) if user.ui_state else {}
    except (TypeError, ValueError):
        state = {}
    return state if isinstance(state, dict) else {}


@app.get("/api/me/ui-state")
def get_ui_state(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return _load_ui_state(me)


# Pro User frei formbarer UI-Zustand (zuletzt offener Screen/Scroll, aktive
# Filter/Sortierung auf den Kosten, …) — bewusst ein generischer
# Merge-Patch statt einzelner Endpunkte pro Einstellung, damit das Frontend
# neue Zustände speichern kann, ohne dass hier jedes Mal ein neuer Endpunkt
# nötig wird. Eine grobe Größenbremse verhindert versehentlich endlos
# wachsende Payloads (z. B. durch einen Frontend-Bug).
@app.patch("/api/me/ui-state")
def update_ui_state(request: Request, patch: dict = Body(...), db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})

    state = _load_ui_state(me)
    state.update(patch)
    serialized = json.dumps(state)
    if len(serialized) > 20000:
        return JSONResponse(status_code=400, content={"error": "Zustand zu groß"})

    me.ui_state = serialized
    db.commit()
    return state


@app.patch("/api/me/password")
def change_own_password(request: Request, payload: PasswordChangeRequest, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})

    if not verify_password(payload.current_password, me.hashed_password):
        return JSONResponse(status_code=400, content={"error": "Aktuelles Passwort ist falsch"})
    if len(payload.new_password) < 8:
        return JSONResponse(status_code=400, content={"error": "Neues Passwort muss mindestens 8 Zeichen haben"})

    me.hashed_password = pwd_context.hash(payload.new_password)
    db.commit()
    return {"ok": True}


_AVATAR_CONTENT_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_AVATAR_MAX_BYTES = 3 * 1024 * 1024


@app.post("/api/me/avatar")
async def upload_own_avatar(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})

    ext = _AVATAR_CONTENT_TYPES.get(file.content_type)
    if not ext:
        return JSONResponse(status_code=400, content={"error": "Nur PNG, JPEG oder WebP erlaubt"})

    content = await file.read()
    if len(content) > _AVATAR_MAX_BYTES:
        return JSONResponse(status_code=400, content={"error": "Bild darf maximal 3 MB groß sein"})

    # Alte Datei mit ggf. anderer Endung entfernen, damit sich keine Leichen ansammeln.
    for old in AVATAR_DIR.glob(f"{me.id}.*"):
        old.unlink(missing_ok=True)

    (AVATAR_DIR / f"{me.id}.{ext}").write_bytes(content)
    me.avatar_path = f"/static/uploads/avatars/{me.id}.{ext}?v={int(time.time())}"
    db.commit()
    return {"avatar_path": me.avatar_path}


@app.get("/api/activity")
def get_my_activity(request: Request, db: Session = Depends(get_db)):
    """Bis zu 3 aktuelle Log-Einträge, bei denen der eingeloggte User die
    BETROFFENE (nicht auslösende) Person ist — für die Startseite."""
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    rows = (
        db.query(ActivityLog)
        .filter(ActivityLog.affected_username == username)
        .order_by(ActivityLog.created_at.desc())
        .limit(3)
        .all()
    )
    return [
        {
            "id": r.id,
            "created_at": r.created_at.isoformat(),
            "actor": r.actor_username,
            "action": r.action,
            "message": r.message,
        }
        for r in rows
    ]


# --- Kosten & Schulden ---

@app.get("/api/expenses")
def list_expenses(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    # Neben den Ausgaben (status="offen") erscheinen hier auch Tilgungseinträge
    # (Rückzahlungen, status="getilgt") — die entstehen direkt beim Melden einer
    # Zahlung (POST /api/expenses/settle) und sollen in derselben Liste sichtbar
    # sein. ("pending" aus dem früheren Bestätigungs-Workflow kommt nicht mehr
    # vor und bleibt bewusst außen vor.)
    # Sortierung nach "datum" (eingestelltes/vom Nutzer gesetztes Datum), nicht nach
    # created_at — Nutzer wollen die Liste nach dem Datum sehen, das sie der Ausgabe
    # gegeben haben, auch wenn diese später nacherfasst oder bearbeitet wurde.
    rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.status.in_(["offen", "getilgt"]))
        .order_by(Ausgabe.datum.desc(), Ausgabe.created_at.desc())
        .all()
    )
    usernames = {u.id: u.username for u in db.query(User).all()}
    return [
        {
            "id": r.id,
            "batch_id": r.batch_id,
            "glaubiger_id": r.glaubiger_id,
            "glaubiger": usernames.get(r.glaubiger_id, "?"),
            "schuldner_id": r.schuldner_id,
            "schuldner": usernames.get(r.schuldner_id, "?"),
            "cash": float(r.cash),
            "betreff": r.betreff,
            "datum": r.datum.isoformat(),
            "selbst": r.schuldner_id == r.glaubiger_id,
            "fixed": bool(r.fixed),
            "created_by": r.created_by,
            "status": r.status,
        }
        for r in rows
    ]


@app.get("/api/expenses/log")
def get_expense_log(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    # payment_confirmed bleibt bewusst in der Liste: Es entstehen zwar keine
    # neuen Einträge mehr (Bestätigungs-Workflow entfernt), aber ältere Log-
    # Zeilen aus der Zeit davor sind historisches Protokoll und bleiben sichtbar.
    entries = (
        db.query(ActivityLog)
        .filter(ActivityLog.action.in_([
            "expense_created", "expense_edited", "expense_deleted",
            "payment_reported", "payment_confirmed",
        ]))
        .order_by(ActivityLog.created_at.desc())
        .all()
    )
    return [
        {
            "id": e.id,
            "actor": e.actor_username,
            "action": e.action,
            "message": e.message,
            "created_at": e.created_at.isoformat(),
        }
        for e in entries
    ]


@app.get("/api/expenses/balance")
def get_expense_balance(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})

    # Zählt Ausgaben UND getilgte Tilgungseinträge zusammen — ein getilgter
    # Tilgungseintrag ist die Umkehrung der ursprünglichen Schuld und gleicht den
    # Saldo dadurch aus, ganz ohne die ursprünglichen Zeilen zu verändern.
    # Einträge wo man sich selbst als Schuldner eingetragen hat sind keine echte
    # Schuld und zählen nie mit. ("pending" aus dem früheren Bestätigungs-Workflow
    # kommt nicht mehr vor; die Prüfung bleibt als Schutz für Altlasten ohne Effekt.)
    open_others = and_(Ausgabe.schuldner_id != Ausgabe.glaubiger_id, Ausgabe.status != "pending")
    owed_to_me = (
        db.query(func.sum(Ausgabe.cash)).filter(Ausgabe.glaubiger_id == me.id, open_others).scalar()
        or 0
    )
    i_owe = (
        db.query(func.sum(Ausgabe.cash)).filter(Ausgabe.schuldner_id == me.id, open_others).scalar()
        or 0
    )
    return {
        "owed_to_me": float(owed_to_me),
        "i_owe": float(i_owe),
        "net": float(owed_to_me) - float(i_owe),
    }


def _validate_expense_payload(payload: ExpenseCreate, db: Session):
    """Validiert eine Ausgabe für Anlegen UND Bearbeiten. Gibt entweder ein Tupel
    (glaubiger_id, beneficiary_ids, betreff, expense_date, amounts, fixed_ids) oder
    eine fertige JSONResponse mit Fehlermeldung zurück. amounts ist eine dict[user_id,
    Betrag] mit dem finalen Betrag pro Person: fixed_amounts wird 1:1 übernommen,
    alle übrigen ausgewählten Personen teilen sich den Rest gleichmäßig auf.
    fixed_ids sind die user_ids, deren Betrag fest war (Rest war "auto")."""
    betreff = payload.betreff.strip()
    if not betreff:
        return JSONResponse(status_code=400, content={"error": "Betreff darf nicht leer sein"})
    if len(betreff) > 40:
        return JSONResponse(status_code=400, content={"error": "Betreff darf maximal 40 Zeichen haben"})
    if payload.cash <= 0:
        return JSONResponse(status_code=400, content={"error": "Betrag muss positiv sein"})

    beneficiary_ids = sorted(set(payload.schuldner_ids))
    if not beneficiary_ids:
        return JSONResponse(status_code=400, content={"error": "Mindestens eine Person auswählen"})
    # "Nur für mich"-Ausgaben (einzige beteiligte Person = Zahler selbst) sind
    # keine echte Schuld und sollen nicht mehr angelegt werden können — anders
    # als eigene Käufe INNERHALB einer Ausgabe mit mehreren Beteiligten, die
    # weiterhin normal möglich bleiben.
    if beneficiary_ids == [payload.glaubiger_id]:
        return JSONResponse(
            status_code=400,
            content={"error": "Ausgaben nur für dich selbst gibt es nicht mehr — wähle mind. eine weitere Person"},
        )

    valid_ids = {u.id for u in db.query(User).filter(User.id.in_(beneficiary_ids + [payload.glaubiger_id])).all()}
    if payload.glaubiger_id not in valid_ids:
        return JSONResponse(status_code=400, content={"error": "Zahler nicht gefunden"})
    if not set(beneficiary_ids).issubset(valid_ids):
        return JSONResponse(status_code=400, content={"error": "Unbekannte Person ausgewählt"})

    if payload.datum:
        try:
            expense_date = date.fromisoformat(payload.datum)
        except ValueError:
            return JSONResponse(status_code=400, content={"error": "Ungültiges Datum"})
        # Verhindert, dass die Liste (sortiert nach "datum") durch ein frei erfundenes
        # Zukunftsdatum dauerhaft verzerrt wird. Beliebig weit zurückliegende Daten
        # bleiben erlaubt (Nacherfassen älterer Ausgaben).
        if expense_date > today_berlin():
            return JSONResponse(status_code=400, content={"error": "Datum darf nicht in der Zukunft liegen"})
    else:
        expense_date = today_berlin()

    fixed = {uid: round(amt, 2) for uid, amt in (payload.fixed_amounts or {}).items()}
    if set(fixed) - set(beneficiary_ids):
        return JSONResponse(
            status_code=400, content={"error": "Fixierter Betrag für nicht ausgewählte Person"}
        )
    if any(amt <= 0 for amt in fixed.values()):
        return JSONResponse(status_code=400, content={"error": "Fixierte Beträge müssen positiv sein"})

    fixed_total = round(sum(fixed.values()), 2)
    if fixed_total > payload.cash + 0.005:
        return JSONResponse(
            status_code=400, content={"error": "Fixierte Beträge übersteigen den Gesamtbetrag"}
        )

    remaining_ids = [uid for uid in beneficiary_ids if uid not in fixed]
    remaining_total = round(payload.cash - fixed_total, 2)
    if not remaining_ids and remaining_total > 0.005:
        return JSONResponse(
            status_code=400,
            content={"error": "Die fixierten Beträge ergeben nicht den Gesamtbetrag — bitte Rest zuweisen"},
        )

    # Ein Eintrag pro ausgewählter Person, auch für den Zahler selbst (z. B. eigener
    # Snackkauf ohne Beteiligte). schuldner_id == glaubiger_id ist keine echte Schuld
    # und wird in Saldo/Offene-Zahlungen ausgeblendet.
    # Cent-genau aufteilen statt jeden Anteil einzeln zu runden: sonst kann die
    # Summe der gespeicherten Beträge vom tatsächlichen Gesamtbetrag abweichen
    # (z. B. 100 € / 3 Personen -> 33,33 € x 3 = 99,99 €), was Salden schleichend
    # verfälscht. Der Rest-Cent wird deterministisch auf die ersten Personen
    # (nach sortierter user_id) verteilt.
    amounts = dict(fixed)
    if remaining_ids:
        total_cents = round(remaining_total * 100)
        n = len(remaining_ids)
        base_cents, extra_cents = divmod(total_cents, n)
        for idx, uid in enumerate(remaining_ids):
            cents = base_cents + (1 if idx < extra_cents else 0)
            amounts[uid] = cents / 100

    fixed_ids = set(fixed)
    return payload.glaubiger_id, beneficiary_ids, betreff, expense_date, amounts, fixed_ids


@app.post("/api/expenses")
def create_expense(
    request: Request, payload: ExpenseCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    validated = _validate_expense_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    glaubiger_id, beneficiary_ids, betreff, expense_date, amounts, fixed_ids = validated

    batch_id = uuid.uuid4().hex
    created = []
    for uid in beneficiary_ids:
        row = Ausgabe(
            glaubiger_id=glaubiger_id,
            schuldner_id=uid,
            cash=amounts[uid],
            betreff=betreff,
            datum=expense_date,
            batch_id=batch_id,
            fixed=uid in fixed_ids,
            created_by=username,
        )
        db.add(row)
        created.append(row)
    db.commit()

    # Ein Log-Eintrag pro Ausgabe (Gesamtbetrag), nicht mehr einer pro
    # beteiligter Person — im Log geht es nur ums Nachvollziehen von Aktionen
    # (wer hat was angelegt/bearbeitet/gelöscht), die Aufteilung auf einzelne
    # Personen steht bereits in der Ausgaben-Liste selbst.
    names = {u.id: u.username for u in db.query(User).filter(User.id == glaubiger_id).all()}
    payer_name = names.get(glaubiger_id, "?")
    total_str = f"{payload.cash:.2f} €".replace(".", ",")
    log_action(
        db, payer_name, None, "expense_created",
        f"{payer_name} hat {total_str} für „{betreff}“ bezahlt",
    )
    db.commit()

    return {"created": len(created), "amounts": amounts, "betreff": betreff, "batch_id": batch_id}


def _can_manage_expense_batch(user: User, rows: list[Ausgabe]) -> bool:
    if _is_admin_user(user):
        return True
    creator = rows[0].created_by if rows else None
    return creator is not None and creator == user.username


@app.patch("/api/expenses/batch/{batch_id}")
def update_expense_batch(
    batch_id: str, request: Request, payload: ExpenseCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    me = db.query(User).filter(User.username == username).first() if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    existing_rows = (
        db.query(Ausgabe).filter(Ausgabe.batch_id == batch_id, Ausgabe.status == "offen").all()
    )
    if not existing_rows:
        return JSONResponse(status_code=404, content={"error": "Ausgabe nicht gefunden"})
    if not _can_manage_expense_batch(me, existing_rows):
        return JSONResponse(status_code=403, content={"error": "Du kannst nur deine eigenen Ausgaben bearbeiten"})
    original_created_by = existing_rows[0].created_by

    validated = _validate_expense_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    glaubiger_id, beneficiary_ids, betreff, expense_date, amounts, fixed_ids = validated

    # Alte Zeilen des Vorgangs ersetzen statt anzupassen — einfacher und robuster
    # als ein Zeilen-für-Zeilen-Diff, gleiche batch_id bleibt für Kontinuität erhalten.
    for r in existing_rows:
        db.delete(r)
    for uid in beneficiary_ids:
        db.add(
            Ausgabe(
                glaubiger_id=glaubiger_id,
                schuldner_id=uid,
                cash=amounts[uid],
                betreff=betreff,
                datum=expense_date,
                batch_id=batch_id,
                fixed=uid in fixed_ids,
                # Ersteller bleibt beim Bearbeiten unverändert, auch wenn ein
                # Admin die Ausgabe einer anderen Person editiert.
                created_by=original_created_by,
            )
        )
    log_action(db, username, None, "expense_edited", f"{username} hat die Ausgabe „{betreff}“ bearbeitet")
    db.commit()

    return {"batch_id": batch_id, "created": len(beneficiary_ids), "amounts": amounts, "betreff": betreff}


@app.delete("/api/expenses/batch/{batch_id}")
def delete_expense_batch(batch_id: str, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    me = db.query(User).filter(User.username == username).first() if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    existing_rows = (
        db.query(Ausgabe).filter(Ausgabe.batch_id == batch_id, Ausgabe.status == "offen").all()
    )
    if not existing_rows:
        return JSONResponse(status_code=404, content={"error": "Ausgabe nicht gefunden"})
    if not _can_manage_expense_batch(me, existing_rows):
        return JSONResponse(status_code=403, content={"error": "Du kannst nur deine eigenen Ausgaben löschen"})
    betreff = existing_rows[0].betreff

    deleted = (
        db.query(Ausgabe)
        .filter(Ausgabe.batch_id == batch_id, Ausgabe.status == "offen")
        .delete(synchronize_session=False)
    )
    log_action(db, username, None, "expense_deleted", f"{username} hat die Ausgabe „{betreff}“ gelöscht")
    db.commit()
    return {"ok": True, "deleted": deleted}


def _pairwise_raw_breakdown(db: Session) -> list[dict]:
    """Für jedes Personenpaar, das tatsächlich mindestens eine gemeinsame
    Ausgabe hatte: die rohen Summen je Richtung (a->b und b->a, vor der
    Verrechnung) plus den daraus resultierenden Netto-Betrag. Eigenkäufe
    (schuldner_id == glaubiger_id) fließen bewusst nicht ein — Eigenkäufe
    erzeugen kein Schuldverhältnis. ("pending" aus dem früheren Bestätigungs-
    Workflow kommt nicht mehr vor; die Prüfung bleibt als Schutz für Altlasten
    ohne Effekt — getilgte Tilgungen zählen normal mit und reduzieren den
    offenen Betrag sofort.)

    Bewusst PAARWEISE statt global verrechnet (Absprache): jede Person soll nur
    an Personen zahlen, mit denen sie wirklich eine gemeinsame Ausgabe hatte —
    nachvollziehbarer als eine global minimierte Anzahl Überweisungen, auch
    wenn das im Ergebnis mehr einzelne Zahlungen bedeuten kann."""
    rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.schuldner_id != Ausgabe.glaubiger_id, Ausgabe.status != "pending")
        .all()
    )
    directed: dict[tuple[int, int], float] = {}
    for r in rows:
        key = (r.schuldner_id, r.glaubiger_id)
        directed[key] = directed.get(key, 0.0) + float(r.cash)

    seen: set[frozenset] = set()
    pairs: list[dict] = []
    for a, b in directed.keys():
        pair_key = frozenset((a, b))
        if pair_key in seen:
            continue
        seen.add(pair_key)
        a_to_b = round(directed.get((a, b), 0.0), 2)
        b_to_a = round(directed.get((b, a), 0.0), 2)
        pairs.append({"a_id": a, "b_id": b, "a_to_b": a_to_b, "b_to_a": b_to_a, "net": round(a_to_b - b_to_a, 2)})
    pairs.sort(key=lambda p: -abs(p["net"]))
    return pairs


def _pairwise_examples(db: Session) -> list[dict]:
    """Für JEDES Paar mit gemeinsamen Ausgaben die einzelnen zugrundeliegenden
    Ausgaben-Zeilen (nicht nur die Summe) für die Erklär-Animation — zeigt
    anschaulich, wie sich die a_to_b/b_to_a-Werte aus Schritt 1 tatsächlich
    zusammensetzen. Die Summen entsprechen exakt denen aus
    _pairwise_raw_breakdown, nur die Anzeige der Einzelposten ist pro Richtung
    auf ein paar Beispiele begrenzt. Absteigend nach Anzahl Positionen sortiert
    (interessanteste Paare zuerst)."""
    rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.schuldner_id != Ausgabe.glaubiger_id, Ausgabe.status != "pending")
        .order_by(Ausgabe.created_at)
        .all()
    )
    by_pair: dict[frozenset, list[Ausgabe]] = {}
    for r in rows:
        by_pair.setdefault(frozenset((r.schuldner_id, r.glaubiger_id)), []).append(r)
    if not by_pair:
        return []

    usernames = {u.id: u.username for u in db.query(User).all()}

    def summarize(rows_: list[Ausgabe], limit: int = 3) -> dict:
        shown = [{"betreff": r.betreff, "cash": float(r.cash), "tilgung": r.status == "getilgt"} for r in rows_[:limit]]
        return {"items": shown, "more": max(0, len(rows_) - limit), "total": round(sum(float(r.cash) for r in rows_), 2)}

    examples = []
    for pair, pair_rows in sorted(by_pair.items(), key=lambda kv: -len(kv[1])):
        a_id, b_id = tuple(pair)
        a_to_b_rows = [r for r in pair_rows if r.schuldner_id == a_id]
        b_to_a_rows = [r for r in pair_rows if r.schuldner_id == b_id]
        examples.append({
            "a_id": a_id, "a": usernames.get(a_id, "?"),
            "b_id": b_id, "b": usernames.get(b_id, "?"),
            "a_to_b": summarize(a_to_b_rows),
            "b_to_a": summarize(b_to_a_rows),
        })
    return examples


def _compute_pairwise_debts(db: Session) -> list[tuple[int, int, float]]:
    """Netto-Schuld je Personenpaar als (from_id, to_id, amount)-Liste, sortiert
    absteigend nach Betrag — direkt aus _pairwise_raw_breakdown abgeleitet,
    damit /open, /explain und /settle garantiert dieselben Zahlen liefern."""
    result: list[tuple[int, int, float]] = []
    for p in _pairwise_raw_breakdown(db):
        if p["net"] > 0.005:
            result.append((p["a_id"], p["b_id"], p["net"]))
        elif p["net"] < -0.005:
            result.append((p["b_id"], p["a_id"], -p["net"]))
    result.sort(key=lambda x: (-x[2], x[0], x[1]))
    return result


def _resolve_debt_chains(db: Session) -> tuple[list[tuple[int, int, float]], list[dict]]:
    """Löst Ketten in den paarweisen Schulden auf: schuldet A dem B etwas UND B
    wiederum C, wird der überlappende Betrag direkt von A an C verschoben (B
    fällt für genau diesen Betrag als Zwischenstation raus) — reduziert die
    Anzahl der Überweisungen. Arbeitet nur entlang tatsächlich existierender
    Schuld-Kanten (aus _compute_pairwise_debts), nicht global über beliebige
    Personen hinweg wie die frühere Greedy-Minimierung.

    Gibt die reduzierte Kantenliste zurück sowie ein Protokoll der einzelnen
    Verschiebungen (für die animierte Erklärung im Frontend)."""
    edges: dict[tuple[int, int], float] = {
        (from_id, to_id): amount for from_id, to_id, amount in _compute_pairwise_debts(db)
    }

    def find_chain():
        for (u, m), amt_in in edges.items():
            if amt_in <= 0.005:
                continue
            for (m2, v), amt_out in edges.items():
                if m2 != m or v == u or amt_out <= 0.005:
                    continue
                return u, m, v
        return None

    merges: list[dict] = []
    while True:
        chain = find_chain()
        if not chain:
            break
        u, m, v = chain
        amt_in = edges.get((u, m), 0.0)
        amt_out = edges.get((m, v), 0.0)
        shift = round(min(amt_in, amt_out), 2)
        if shift <= 0.005:
            break
        edges[(u, m)] = round(amt_in - shift, 2)
        edges[(m, v)] = round(amt_out - shift, 2)
        fwd = edges.get((u, v), 0.0) + shift
        rev = edges.get((v, u), 0.0)
        net = round(fwd - rev, 2)
        if net >= 0:
            edges[(u, v)] = net
            edges[(v, u)] = 0.0
        else:
            edges[(v, u)] = round(-net, 2)
            edges[(u, v)] = 0.0
        merges.append(
            {
                "u_id": u, "m_id": m, "v_id": v, "amount": shift,
                "amt_in": round(amt_in, 2), "amt_out": round(amt_out, 2),
            }
        )
        edges = {k: val for k, val in edges.items() if val > 0.005}

    result = [(from_id, to_id, amount) for (from_id, to_id), amount in edges.items() if amount > 0.005]
    result.sort(key=lambda x: (-x[2], x[0], x[1]))
    return result, merges


def _compute_settlements(db: Session) -> list[tuple[int, int, float]]:
    settlements, _ = _resolve_debt_chains(db)
    return settlements


def _settlement_ledgers(db: Session) -> list[dict]:
    """Für jede finale Zahlung die vollständige Herleitung: der direkte Betrag aus
    Schritt 2 (falls vorhanden) plus jeder Kettenschritt, der genau diese
    Verbindung entweder ERHÖHT hat (sie war das Ziel einer Kette, also u->v)
    oder VERRINGERT hat (sie wurde selbst als Zwischen-Kante einer anderen,
    späteren Kette verbraucht, also als deren u->m oder m->v) — läuft exakt auf
    den finalen Betrag hinaus, weil es dieselben Werte sind, die
    _resolve_debt_chains ohnehin schon verrechnet hat."""
    usernames = {u.id: u.username for u in db.query(User).all()}
    initial = {(f, t): amt for f, t, amt in _compute_pairwise_debts(db)}
    settlements, merges = _resolve_debt_chains(db)

    ledgers = []
    for from_id, to_id, amount in settlements:
        entries = []
        running = initial.get((from_id, to_id), 0.0)
        if running > 0.005:
            entries.append({"type": "direct", "amount": round(running, 2)})
        for idx, m in enumerate(merges):
            if m["u_id"] == from_id and m["v_id"] == to_id:
                running += m["amount"]
                entries.append(
                    {
                        "type": "chain_add", "step": idx + 1,
                        "u": usernames.get(m["u_id"], "?"), "m": usernames.get(m["m_id"], "?"), "v": usernames.get(m["v_id"], "?"),
                        "amount": round(m["amount"], 2),
                    }
                )
            elif m["u_id"] == from_id and m["m_id"] == to_id:
                running -= m["amount"]
                entries.append(
                    {
                        "type": "chain_consumed", "step": idx + 1,
                        "u": usernames.get(m["u_id"], "?"), "m": usernames.get(m["m_id"], "?"), "v": usernames.get(m["v_id"], "?"),
                        "amount": round(-m["amount"], 2),
                    }
                )
            elif m["m_id"] == from_id and m["v_id"] == to_id:
                running -= m["amount"]
                entries.append(
                    {
                        "type": "chain_consumed", "step": idx + 1,
                        "u": usernames.get(m["u_id"], "?"), "m": usernames.get(m["m_id"], "?"), "v": usernames.get(m["v_id"], "?"),
                        "amount": round(-m["amount"], 2),
                    }
                )
        ledgers.append(
            {
                "from_id": from_id, "from": usernames.get(from_id, "?"),
                "to_id": to_id, "to": usernames.get(to_id, "?"),
                "amount": amount, "entries": entries,
            }
        )
    return ledgers


@app.get("/api/expenses/open")
def get_open_settlements(request: Request, db: Session = Depends(get_db)):
    """
    Schlägt vor, wer an wen zahlen soll, um alle offenen Schulden auszugleichen —
    paarweise verrechnet (siehe _compute_pairwise_debts) und anschließend über
    Ketten reduziert (siehe _resolve_debt_chains): schuldet A dem B etwas UND B
    wiederum C, zahlt A den überlappenden Betrag direkt an C statt über B.
    Die Berechnung ist deterministisch, solange sich die zugrunde liegenden
    Beträge nicht ändern. Gemeldete Tilgungen (status="getilgt") sind bereits
    eingerechnet und reduzieren den offenen Betrag sofort.
    """
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    usernames = {u.id: u.username for u in db.query(User).all()}
    min_settlements = _compute_settlements(db)

    settlements = [
        {
            "from_id": deb_id,
            "from": usernames.get(deb_id, "?"),
            "to_id": cred_id,
            "to": usernames.get(cred_id, "?"),
            "amount": amount,
        }
        for deb_id, cred_id, amount in min_settlements
    ]

    settlements.sort(key=lambda s: -s["amount"])
    return settlements


@app.get("/api/expenses/open/explain")
def get_open_settlements_explain(request: Request, db: Session = Depends(get_db)):
    """Liefert den kompletten Rechenweg hinter /api/expenses/open für die
    animierte Erklärung im Frontend: erst die rohen Ausgaben-Summen je
    Personenpaar (vor jeder Verrechnung), dann die daraus verrechneten
    Netto-Beträge je Paar — das sind exakt die tatsächlichen Zahlungsvorschläge."""
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    usernames = {u.id: u.username for u in db.query(User).all()}
    raw_pairs = _pairwise_raw_breakdown(db)

    pairs = [
        {**p, "a_username": usernames.get(p["a_id"], "?"), "b_username": usernames.get(p["b_id"], "?")}
        for p in raw_pairs
    ]

    netted_pairs = []
    for p in raw_pairs:
        if p["net"] > 0.005:
            from_id, to_id, amount = p["a_id"], p["b_id"], p["net"]
        elif p["net"] < -0.005:
            from_id, to_id, amount = p["b_id"], p["a_id"], -p["net"]
        else:
            continue
        netted_pairs.append(
            {"from_id": from_id, "from": usernames.get(from_id, "?"), "to_id": to_id, "to": usernames.get(to_id, "?"), "amount": amount}
        )
    netted_pairs.sort(key=lambda s: -s["amount"])

    settlements, merges_raw = _resolve_debt_chains(db)

    # Jeder einzelne Kettenschritt bleibt für die Erklärung erhalten (statt wie
    # zuvor zu einer Summe pro Dreier-Kette zusammengefasst) — inklusive der
    # Beträge VOR der Verschiebung (amt_in/amt_out), damit im Frontend die
    # tatsächliche min(...)-Rechnung pro Schritt gezeigt werden kann. Dieselbe
    # Kette kann dabei mehrfach auftauchen (z. B. weil ein Teilbetrag erst durch
    # eine andere Kette freigeschoben wird) — das zeigt der Ablauf bewusst so an.
    merges = [
        {
            "u_id": m["u_id"], "u": usernames.get(m["u_id"], "?"),
            "m_id": m["m_id"], "m": usernames.get(m["m_id"], "?"),
            "v_id": m["v_id"], "v": usernames.get(m["v_id"], "?"),
            "amount": m["amount"],
            "amt_in": m["amt_in"],
            "amt_out": m["amt_out"],
        }
        for m in merges_raw
    ]
    steps = [
        {"from_id": from_id, "from": usernames.get(from_id, "?"), "to_id": to_id, "to": usernames.get(to_id, "?"), "amount": amount}
        for from_id, to_id, amount in settlements
    ]

    examples = _pairwise_examples(db)
    ledgers = _settlement_ledgers(db)

    return {"pairs": pairs, "netted_pairs": netted_pairs, "merges": merges, "steps": steps, "examples": examples, "ledgers": ledgers}


@app.post("/api/expenses/settle")
def settle_expenses(
    request: Request, payload: SettleRequest, db: Session = Depends(get_db)
):
    """
    Der Schuldner (immer der eingeloggte User) meldet, dass er das Geld überwiesen
    hat. Das erzeugt einen neuen Eintrag in derselben Tabelle mit vertauschten
    Rollen (Schuldner wird zum Gläubiger dieses Eintrags), ohne die
    ursprünglichen Ausgaben-Zeilen zu verändern — direkt mit status="getilgt":
    Der Tilgungseintrag erscheint sofort in "Ausgaben" und der Betrag gilt
    unmittelbar als beglichen (er zählt ab sofort in Saldo und offene Zahlungen
    mit ein, siehe /api/expenses/balance und /api/expenses/open).

    Der maximal mögliche Betrag wird über dieselbe Berechnung wie /api/expenses/open
    ermittelt (siehe _compute_settlements: paarweise Verrechnung + Ketten-Auflösung),
    kann also auch eine über eine Kette (A->B->C) reduzierte Zahlung sein, nicht nur
    direkte Historie. payload.amount ist optional und erlaubt Teilzahlungen bis zu
    diesem Maximum — der Rest bleibt offen und fließt beim nächsten Abruf ganz normal
    wieder in die Berechnung ein.
    """
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    creditor = db.query(User).filter(User.id == payload.to_id).first()
    if not me or not creditor:
        return JSONResponse(status_code=400, content={"error": "Person nicht gefunden"})
    if creditor.id == me.id:
        return JSONResponse(status_code=400, content={"error": "Ungültige Auswahl"})

    min_settlements = _compute_settlements(db)
    match = next(
        (amount for deb_id, cred_id, amount in min_settlements if deb_id == me.id and cred_id == creditor.id),
        None,
    )
    if match is None:
        return JSONResponse(
            status_code=400,
            content={"error": "Diese Zahlung ist aktuell nicht mehr offen — bitte Ansicht neu laden"},
        )

    # Teilzahlungen: amount ist optional, Default = kompletter offener Betrag
    # (bisheriges Verhalten). Der Rest bleibt einfach offen und taucht beim
    # nächsten Abruf von /api/expenses/open wieder auf, da er weiterhin in die
    # Netto-Saldo-Berechnung einfließt — keine Änderung an der Verrechnung nötig.
    amount = round(payload.amount, 2) if payload.amount is not None else match
    if amount <= 0:
        return JSONResponse(status_code=400, content={"error": "Betrag muss positiv sein"})
    if amount > match + 0.005:
        return JSONResponse(
            status_code=400,
            content={"error": f"Betrag darf die offenen {match:.2f} € nicht übersteigen".replace(".", ",")},
        )

    tilgung = Ausgabe(
        glaubiger_id=me.id,
        schuldner_id=creditor.id,
        cash=amount,
        betreff=f"Tilgung an {creditor.username}",
        datum=today_berlin(),
        status="getilgt",
    )
    db.add(tilgung)
    db.commit()

    amount_str = f"{amount:.2f} €".replace(".", ",")
    # Name statt "dir" — das Log zeigt denselben Text ungefiltert JEDER Person,
    # die es sich ansieht, nicht nur dem Empfänger selbst (siehe analoger Fix
    # für expense_created in _backfill_expense_log_messages, database.py).
    log_action(
        db, me.username, creditor.username, "payment_reported",
        f"{me.username} hat gemeldet, {creditor.username} {amount_str} überwiesen zu haben",
    )
    db.commit()

    return {"created": True, "amount": amount, "to": creditor.username}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
