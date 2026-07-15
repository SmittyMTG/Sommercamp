from datetime import date
from pathlib import Path

from fastapi import FastAPI, Request, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, and_, or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import SessionLocal, User, ShoppingItem, Ausgabe, get_db
from auth import login, logout, get_current_user
import uvicorn

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

templates = Jinja2Templates(directory=BASE_DIR / "templates")


def static_version(filename: str) -> int:
    """mtime of a static file, used as a cache-busting query param."""
    return int((STATIC_DIR / filename).stat().st_mtime)


templates.env.globals["static_version"] = static_version


# --- Schemas ---
class ShoppingItemCreate(BaseModel):
    name: str


class ExpenseCreate(BaseModel):
    glaubiger_id: int
    schuldner_ids: list[int]
    cash: float
    betreff: str
    datum: str | None = None


class SettleRequest(BaseModel):
    to_id: int


class ConfirmReceivedRequest(BaseModel):
    expense_id: int
    amount: float


# --- Routes ---
@app.get("/", name="index", response_class=HTMLResponse)
async def home(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse("index.html", {"request": request, "user": user})


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})


@app.post("/login")
async def login_post(
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
async def logout_route(response: Response):
    logout(response)
    return RedirectResponse(url="/login", status_code=303)


# --- Einkaufsliste ---

@app.get("/api/shopping")
async def get_shopping_items(request: Request, db: Session = Depends(get_db)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    items = (
        db.query(ShoppingItem)
        .order_by(ShoppingItem.done.asc(), ShoppingItem.created_at.desc())
        .all()
    )
    return [
        {
            "id": i.id,
            "name": i.name,
            "done": i.done,
            "added_by": i.added_by,
        }
        for i in items
    ]


@app.post("/api/shopping")
async def create_shopping_item(
    request: Request, item: ShoppingItemCreate, db: Session = Depends(get_db)
):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    name = item.name.strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "Name darf nicht leer sein"})

    new_item = ShoppingItem(name=name, added_by=user)
    db.add(new_item)
    db.commit()
    db.refresh(new_item)

    return {
        "id": new_item.id,
        "name": new_item.name,
        "done": new_item.done,
        "added_by": new_item.added_by,
    }


@app.patch("/api/shopping/{item_id}/toggle")
async def toggle_shopping_item(item_id: int, request: Request, db: Session = Depends(get_db)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    item = db.query(ShoppingItem).filter(ShoppingItem.id == item_id).first()
    if not item:
        return JSONResponse(status_code=404, content={"error": "not found"})

    item.done = not item.done
    db.commit()
    return {"id": item.id, "done": item.done}


@app.delete("/api/shopping/{item_id}")
async def delete_shopping_item(item_id: int, request: Request, db: Session = Depends(get_db)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    item = db.query(ShoppingItem).filter(ShoppingItem.id == item_id).first()
    if item:
        db.delete(item)
        db.commit()
    return {"ok": True}


# --- User-Übersicht (für die Auswahl in der Ausgaben-Maske) ---

@app.get("/api/me")
async def get_me(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return {"id": me.id, "username": me.username}


@app.get("/api/users")
async def list_users(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    users = db.query(User).order_by(User.username.asc()).all()
    return [{"id": u.id, "username": u.username} for u in users]


# --- Kosten & Schulden ---

@app.get("/api/expenses")
async def list_expenses(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    # Tilgungseinträge (Rückzahlungen, status != "offen") sind Buchhaltung, keine
    # eigenen Einkäufe — die gehören nicht in die "Alle Ausgaben"-Übersicht.
    rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.status == "offen")
        .order_by(Ausgabe.datum.desc(), Ausgabe.created_at.desc())
        .all()
    )
    usernames = {u.id: u.username for u in db.query(User).all()}
    return [
        {
            "id": r.id,
            "glaubiger": usernames.get(r.glaubiger_id, "?"),
            "schuldner": usernames.get(r.schuldner_id, "?"),
            "cash": float(r.cash),
            "betreff": r.betreff,
            "datum": r.datum.isoformat(),
            "selbst": r.schuldner_id == r.glaubiger_id,
        }
        for r in rows
    ]


@app.get("/api/expenses/balance")
async def get_expense_balance(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})

    # Zählt Ausgaben UND bereits bestätigte (getilgte) Tilgungseinträge zusammen —
    # ein getilgter Tilgungseintrag ist die Umkehrung der ursprünglichen Schuld und
    # gleicht den Saldo dadurch aus, ganz ohne die ursprünglichen Zeilen zu verändern.
    # Pending Tilgungen zählen bewusst noch nicht (erst nach Bestätigung des
    # Gläubigers), Einträge wo man sich selbst als Schuldner eingetragen hat sind
    # keine echte Schuld und zählen nie mit.
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


@app.post("/api/expenses")
async def create_expense(
    request: Request, payload: ExpenseCreate, db: Session = Depends(get_db)
):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

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
    else:
        expense_date = date.today()

    # Ein Eintrag pro ausgewählter Person, auch für den Zahler selbst (z. B. eigener
    # Snackkauf ohne Beteiligte). schuldner_id == glaubiger_id ist keine echte Schuld,
    # zählt aber fürs Leaderboard mit und wird in Saldo/Offene-Zahlungen ausgeblendet.
    share = round(payload.cash / len(beneficiary_ids), 2)

    created = []
    for uid in beneficiary_ids:
        row = Ausgabe(
            glaubiger_id=payload.glaubiger_id,
            schuldner_id=uid,
            cash=share,
            betreff=betreff,
            datum=expense_date,
        )
        db.add(row)
        created.append(row)
    db.commit()

    return {"created": len(created), "share": share, "betreff": betreff}


@app.get("/api/expenses/open")
async def get_open_settlements(request: Request, db: Session = Depends(get_db)):
    """
    Zeigt den echten, paarweisen offenen Saldo zwischen je zwei Personen (nicht
    global über alle Personen hinweg minimiert) — jede Kachel entspricht einer
    tatsächlichen Historie zwischen genau diesen beiden, ist unabhängig von allen
    anderen Kacheln und lässt sich einzeln bestätigen, egal wie viele Personen
    jemand gleichzeitig etwas schuldet.

    "pending" Tilgungseinträge zählen bewusst NICHT in den Saldo hinein (sonst
    würde die Kachel sofort verschwinden, bevor der Gläubiger bestätigt hat) —
    stattdessen wird die Kachel per "pending"-Flag markiert, damit das Frontend
    sie ausgegraut mit "Wartet auf Bestätigung" statt mit Button anzeigt.
    """
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    usernames = {u.id: u.username for u in db.query(User).all()}

    settled_rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.schuldner_id != Ausgabe.glaubiger_id, Ausgabe.status != "pending")
        .all()
    )
    pair_net: dict[tuple[int, int], float] = {}
    for r in settled_rows:
        cash = float(r.cash)
        a, b = r.glaubiger_id, r.schuldner_id  # b schuldet a
        key = tuple(sorted((a, b)))
        sign = 1.0 if key[0] == a else -1.0
        pair_net[key] = pair_net.get(key, 0.0) + sign * cash

    pending_by_pair = {
        (r.glaubiger_id, r.schuldner_id): {"amount": float(r.cash)}
        for r in db.query(Ausgabe).filter(Ausgabe.status == "pending").all()
    }

    settlements = []
    seen_pairs = set()
    for (u1, u2), net in pair_net.items():
        net = round(net, 2)
        if abs(net) <= 0.005:
            continue
        from_id, to_id = (u2, u1) if net > 0 else (u1, u2)
        seen_pairs.add((from_id, to_id))
        settlements.append(
            {
                "from_id": from_id,
                "from": usernames.get(from_id, "?"),
                "to_id": to_id,
                "to": usernames.get(to_id, "?"),
                "amount": abs(net),
                "pending": (from_id, to_id) in pending_by_pair,
            }
        )

    # Pending Tilgungen, deren Paar oben nicht (mehr) auftaucht (z. B. weil sich
    # der offene Betrag exakt deckt), trotzdem als wartende Kachel zeigen.
    for (from_id, to_id), info in pending_by_pair.items():
        if (from_id, to_id) in seen_pairs:
            continue
        settlements.append(
            {
                "from_id": from_id,
                "from": usernames.get(from_id, "?"),
                "to_id": to_id,
                "to": usernames.get(to_id, "?"),
                "amount": info["amount"],
                "pending": True,
            }
        )

    settlements.sort(key=lambda s: -s["amount"])
    return settlements


@app.post("/api/expenses/settle")
async def settle_expenses(
    request: Request, payload: SettleRequest, db: Session = Depends(get_db)
):
    """
    Schritt 1 des Tilgungs-Workflows: der Schuldner (immer der eingeloggte User)
    bestätigt, dass er das Geld überwiesen hat. Das erzeugt einen neuen Eintrag in
    derselben Tabelle mit vertauschten Rollen (Schuldner wird zum Gläubiger dieses
    Eintrags), ohne die ursprünglichen Ausgaben-Zeilen zu verändern. status="pending",
    bis der echte Gläubiger den Empfang über /api/expenses/settle/confirm bestätigt —
    bis dahin bleibt der offene Betrag sichtbar, nur als "wartend" markiert (siehe
    /api/expenses/open), damit man parallel an mehrere Personen etwas schicken kann.
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

    already_pending = (
        db.query(Ausgabe)
        .filter(Ausgabe.status == "pending", Ausgabe.glaubiger_id == me.id, Ausgabe.schuldner_id == creditor.id)
        .first()
    )
    if already_pending:
        return JSONResponse(
            status_code=400,
            content={"error": "Diese Zahlung wurde bereits als gesendet markiert und wartet auf Bestätigung"},
        )

    rows = (
        db.query(Ausgabe)
        .filter(
            Ausgabe.schuldner_id != Ausgabe.glaubiger_id,
            Ausgabe.status != "pending",
            or_(
                and_(Ausgabe.glaubiger_id == creditor.id, Ausgabe.schuldner_id == me.id),
                and_(Ausgabe.glaubiger_id == me.id, Ausgabe.schuldner_id == creditor.id),
            ),
        )
        .all()
    )
    net = 0.0
    for r in rows:
        cash = float(r.cash)
        net += cash if r.glaubiger_id == creditor.id else -cash
    net = round(net, 2)
    if net <= 0.005:
        return JSONResponse(status_code=400, content={"error": "Du schuldest dieser Person aktuell nichts"})

    tilgung = Ausgabe(
        glaubiger_id=me.id,
        schuldner_id=creditor.id,
        cash=net,
        betreff=f"Tilgung an {creditor.username}",
        datum=date.today(),
        status="pending",
    )
    db.add(tilgung)
    db.commit()
    return {"created": True, "amount": net, "to": creditor.username}


@app.get("/api/expenses/received")
async def get_pending_received(request: Request, db: Session = Depends(get_db)):
    """Zahlungen, die laut Schuldner bereits unterwegs sind und auf Bestätigung
    des Empfängers (dem eingeloggten User) warten."""
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})

    rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.status == "pending", Ausgabe.schuldner_id == me.id)
        .order_by(Ausgabe.created_at.desc())
        .all()
    )
    usernames = {u.id: u.username for u in db.query(User).all()}
    return [
        {
            "id": r.id,
            "from_id": r.glaubiger_id,
            "from": usernames.get(r.glaubiger_id, "?"),
            "amount": float(r.cash),
            "datum": r.datum.isoformat(),
        }
        for r in rows
    ]


@app.post("/api/expenses/settle/confirm")
async def confirm_received_payment(
    request: Request, payload: ConfirmReceivedRequest, db: Session = Depends(get_db)
):
    """Schritt 2: der Gläubiger tippt den erhaltenen Betrag selbst ein. Nur bei
    exakter Übereinstimmung wird der Tilgungseintrag endgültig auf "getilgt"
    gesetzt und zählt ab da wie jede normale Zahlung."""
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})

    row = (
        db.query(Ausgabe)
        .filter(Ausgabe.id == payload.expense_id, Ausgabe.status == "pending", Ausgabe.schuldner_id == me.id)
        .first()
    )
    if not row:
        return JSONResponse(status_code=404, content={"error": "Zahlung nicht gefunden"})

    if round(payload.amount, 2) != round(float(row.cash), 2):
        return JSONResponse(
            status_code=400,
            content={"error": f"Der eingegebene Betrag stimmt nicht mit den gemeldeten {float(row.cash):.2f} € überein"},
        )

    row.status = "getilgt"
    db.commit()
    return {"ok": True}


@app.get("/api/expenses/leaderboard")
async def get_expense_leaderboard(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    # Nur echte Ausgaben zählen fürs Leaderboard, keine Tilgungs-Buchungen.
    totals = dict(
        db.query(Ausgabe.schuldner_id, func.sum(Ausgabe.cash))
        .filter(Ausgabe.status == "offen")
        .group_by(Ausgabe.schuldner_id)
        .all()
    )
    users = db.query(User).all()
    ranking = sorted(
        (
            {"user_id": u.id, "username": u.username, "total": float(totals.get(u.id, 0) or 0)}
            for u in users
        ),
        key=lambda x: -x["total"],
    )
    return ranking


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
