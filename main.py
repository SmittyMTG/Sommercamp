import re
import uuid
from datetime import date, datetime as dt
from pathlib import Path

from fastapi import FastAPI, Request, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, and_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import (
    SessionLocal,
    User,
    ShoppingItem,
    ShoppingSource,
    PackItem,
    PlanEvent,
    Task,
    TaskAssignee,
    Ausgabe,
    get_db,
)
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
    woher_id: int | None = None


class ShoppingSourceCreate(BaseModel):
    farbe: str
    bezeichnung: str


class PackItemCreate(BaseModel):
    name: str


class TaskCreate(BaseModel):
    titel: str
    beschreibung: str | None = None
    deadline: str | None = None
    assignee_ids: list[int] = []


class PlanEventCreate(BaseModel):
    datum: str
    uhrzeit: str
    bezeichnung: str
    location: str | None = None
    beschreibung: str | None = None


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

    # Statische Sortierung: rein nach Erstellzeit, unabhängig vom "erledigt"-Status.
    # Sonst springt ein Item beim Abhaken sofort ans Listenende, was beim schnellen
    # Abhaken mehrerer Dinge nervig ist. Umsortieren nach Name/Woher/Status passiert
    # nur clientseitig, wenn gewünscht.
    items = db.query(ShoppingItem).order_by(ShoppingItem.created_at.desc()).all()
    sources = {s.id: s for s in db.query(ShoppingSource).all()}
    return [
        {
            "id": i.id,
            "name": i.name,
            "done": i.done,
            "added_by": i.added_by,
            "woher": (
                {"id": sources[i.woher_id].id, "farbe": sources[i.woher_id].farbe, "bezeichnung": sources[i.woher_id].bezeichnung}
                if i.woher_id and i.woher_id in sources
                else None
            ),
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

    woher = None
    if item.woher_id is not None:
        woher = db.query(ShoppingSource).filter(ShoppingSource.id == item.woher_id).first()
        if not woher:
            return JSONResponse(status_code=400, content={"error": "Unbekannte Quelle"})

    new_item = ShoppingItem(name=name, added_by=user, woher_id=woher.id if woher else None)
    db.add(new_item)
    db.commit()
    db.refresh(new_item)

    return {
        "id": new_item.id,
        "name": new_item.name,
        "done": new_item.done,
        "added_by": new_item.added_by,
        "woher": {"id": woher.id, "farbe": woher.farbe, "bezeichnung": woher.bezeichnung} if woher else None,
    }


@app.patch("/api/shopping/{item_id}")
async def update_shopping_item(
    item_id: int, request: Request, item: ShoppingItemCreate, db: Session = Depends(get_db)
):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    existing = db.query(ShoppingItem).filter(ShoppingItem.id == item_id).first()
    if not existing:
        return JSONResponse(status_code=404, content={"error": "not found"})

    name = item.name.strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "Name darf nicht leer sein"})

    woher = None
    if item.woher_id is not None:
        woher = db.query(ShoppingSource).filter(ShoppingSource.id == item.woher_id).first()
        if not woher:
            return JSONResponse(status_code=400, content={"error": "Unbekannte Quelle"})

    existing.name = name
    existing.woher_id = woher.id if woher else None
    db.commit()

    return {
        "id": existing.id,
        "name": existing.name,
        "done": existing.done,
        "added_by": existing.added_by,
        "woher": {"id": woher.id, "farbe": woher.farbe, "bezeichnung": woher.bezeichnung} if woher else None,
    }


# --- Woher-Quellen für die Einkaufsliste ---

@app.get("/api/shopping-sources")
async def list_shopping_sources(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    sources = db.query(ShoppingSource).order_by(ShoppingSource.bezeichnung.asc()).all()
    return [{"id": s.id, "farbe": s.farbe, "bezeichnung": s.bezeichnung} for s in sources]


@app.post("/api/shopping-sources")
async def create_shopping_source(
    request: Request, payload: ShoppingSourceCreate, db: Session = Depends(get_db)
):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    bezeichnung = payload.bezeichnung.strip()
    if not bezeichnung:
        return JSONResponse(status_code=400, content={"error": "Bezeichnung darf nicht leer sein"})
    if len(bezeichnung) > 16:
        return JSONResponse(status_code=400, content={"error": "Bezeichnung darf maximal 16 Zeichen haben"})

    farbe = payload.farbe.strip().lower()
    if not re.fullmatch(r"#[0-9a-f]{6}", farbe):
        return JSONResponse(status_code=400, content={"error": "Farbe muss ein Hex-Code sein, z. B. #ffd400"})

    existing = db.query(ShoppingSource).filter(ShoppingSource.bezeichnung == bezeichnung).first()
    if existing:
        return JSONResponse(status_code=400, content={"error": "Diese Bezeichnung gibt es schon"})

    source = ShoppingSource(farbe=farbe, bezeichnung=bezeichnung)
    db.add(source)
    db.commit()
    db.refresh(source)
    return {"id": source.id, "farbe": source.farbe, "bezeichnung": source.bezeichnung}


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


# --- Aufgaben (geteilt, mehrere Personen zuweisbar, mit Deadline) ---

def _validate_task_payload(payload: TaskCreate, db: Session):
    """Gibt entweder (titel, beschreibung, deadline, assignee_ids) oder eine
    fertige JSONResponse mit Fehlermeldung zurück."""
    titel = payload.titel.strip()
    if not titel:
        return JSONResponse(status_code=400, content={"error": "Titel darf nicht leer sein"})
    if len(titel) > 80:
        return JSONResponse(status_code=400, content={"error": "Titel darf maximal 80 Zeichen haben"})

    beschreibung = (payload.beschreibung or "").strip() or None

    deadline = None
    if payload.deadline:
        try:
            deadline = dt.fromisoformat(payload.deadline)
        except ValueError:
            return JSONResponse(status_code=400, content={"error": "Ungültige Deadline"})

    assignee_ids = sorted(set(payload.assignee_ids))
    if assignee_ids:
        valid_ids = {u.id for u in db.query(User).filter(User.id.in_(assignee_ids)).all()}
        if not set(assignee_ids).issubset(valid_ids):
            return JSONResponse(status_code=400, content={"error": "Unbekannte Person ausgewählt"})

    return titel, beschreibung, deadline, assignee_ids


def _serialize_task(task: Task, assignee_ids: list[int], usernames: dict[int, str]) -> dict:
    return {
        "id": task.id,
        "titel": task.titel,
        "beschreibung": task.beschreibung,
        "done": task.done,
        "deadline": task.deadline.isoformat() if task.deadline else None,
        "created_by": task.created_by,
        "assignees": [
            {"id": uid, "username": usernames.get(uid, "?")} for uid in assignee_ids
        ],
    }


@app.get("/api/tasks")
async def list_tasks(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    tasks = db.query(Task).order_by(Task.created_at.desc()).all()
    usernames = {u.id: u.username for u in db.query(User).all()}

    assignees_by_task: dict[int, list[int]] = {}
    for a in db.query(TaskAssignee).all():
        assignees_by_task.setdefault(a.task_id, []).append(a.user_id)

    return [_serialize_task(t, assignees_by_task.get(t.id, []), usernames) for t in tasks]


@app.post("/api/tasks")
async def create_task(request: Request, payload: TaskCreate, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    validated = _validate_task_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    titel, beschreibung, deadline, assignee_ids = validated

    task = Task(titel=titel, beschreibung=beschreibung, deadline=deadline, created_by=username)
    db.add(task)
    db.commit()
    db.refresh(task)

    for uid in assignee_ids:
        db.add(TaskAssignee(task_id=task.id, user_id=uid))
    db.commit()

    usernames = {u.id: u.username for u in db.query(User).filter(User.id.in_(assignee_ids)).all()}
    return _serialize_task(task, assignee_ids, usernames)


@app.patch("/api/tasks/{task_id}")
async def update_task(task_id: int, request: Request, payload: TaskCreate, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        return JSONResponse(status_code=404, content={"error": "not found"})

    validated = _validate_task_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    titel, beschreibung, deadline, assignee_ids = validated

    task.titel = titel
    task.beschreibung = beschreibung
    task.deadline = deadline
    db.query(TaskAssignee).filter(TaskAssignee.task_id == task.id).delete(synchronize_session=False)
    for uid in assignee_ids:
        db.add(TaskAssignee(task_id=task.id, user_id=uid))
    db.commit()

    usernames = {u.id: u.username for u in db.query(User).filter(User.id.in_(assignee_ids)).all()}
    return _serialize_task(task, assignee_ids, usernames)


@app.patch("/api/tasks/{task_id}/toggle")
async def toggle_task(task_id: int, request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        return JSONResponse(status_code=404, content={"error": "not found"})

    task.done = not task.done
    db.commit()
    return {"id": task.id, "done": task.done}


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: int, request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(Task).filter(Task.id == task_id).first()
    if task:
        db.query(TaskAssignee).filter(TaskAssignee.task_id == task.id).delete(synchronize_session=False)
        db.delete(task)
        db.commit()
    return {"ok": True}


# --- Packliste (privat pro User) ---

@app.get("/api/pack")
async def get_pack_items(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    items = (
        db.query(PackItem)
        .filter(PackItem.owner_username == username)
        .order_by(PackItem.created_at.desc())
        .all()
    )
    return [{"id": i.id, "name": i.name, "done": i.done} for i in items]


@app.post("/api/pack")
async def create_pack_item(
    request: Request, item: PackItemCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    name = item.name.strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "Name darf nicht leer sein"})

    new_item = PackItem(name=name, owner_username=username)
    db.add(new_item)
    db.commit()
    db.refresh(new_item)

    return {"id": new_item.id, "name": new_item.name, "done": new_item.done}


@app.patch("/api/pack/{item_id}")
async def update_pack_item(
    item_id: int, request: Request, item: PackItemCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    existing = (
        db.query(PackItem)
        .filter(PackItem.id == item_id, PackItem.owner_username == username)
        .first()
    )
    if not existing:
        return JSONResponse(status_code=404, content={"error": "not found"})

    name = item.name.strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "Name darf nicht leer sein"})

    existing.name = name
    db.commit()
    return {"id": existing.id, "name": existing.name, "done": existing.done}


@app.patch("/api/pack/{item_id}/toggle")
async def toggle_pack_item(item_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    # owner_username ist Teil des Filters, nicht nur eine Anzeige-Info — so kann
    # niemand über eine erratene ID ein fremdes privates Item toggeln.
    item = (
        db.query(PackItem)
        .filter(PackItem.id == item_id, PackItem.owner_username == username)
        .first()
    )
    if not item:
        return JSONResponse(status_code=404, content={"error": "not found"})

    item.done = not item.done
    db.commit()
    return {"id": item.id, "done": item.done}


@app.delete("/api/pack/{item_id}")
async def delete_pack_item(item_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    item = (
        db.query(PackItem)
        .filter(PackItem.id == item_id, PackItem.owner_username == username)
        .first()
    )
    if item:
        db.delete(item)
        db.commit()
    return {"ok": True}


# --- Camp-Plan (Termine, nur Admins legen an) ---

def _require_admin(db: Session, username: str) -> User | None:
    user = db.query(User).filter(User.username == username).first()
    if not user or not user.role or user.role.strip().lower() != "admin":
        return None
    return user


def _validate_plan_payload(payload: PlanEventCreate):
    """Validiert Termin-Felder für Anlegen UND Bearbeiten. Gibt entweder ein
    Tupel (datum, uhrzeit, bezeichnung, location, beschreibung) oder eine
    fertige JSONResponse mit Fehlermeldung zurück."""
    bezeichnung = payload.bezeichnung.strip()
    if not bezeichnung:
        return JSONResponse(status_code=400, content={"error": "Bezeichnung darf nicht leer sein"})
    if len(bezeichnung) > 60:
        return JSONResponse(status_code=400, content={"error": "Bezeichnung darf maximal 60 Zeichen haben"})

    location = (payload.location or "").strip() or None
    if location and len(location) > 120:
        return JSONResponse(status_code=400, content={"error": "Location darf maximal 120 Zeichen haben"})

    try:
        event_date = date.fromisoformat(payload.datum)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Ungültiges Datum"})

    try:
        event_time = dt.strptime(payload.uhrzeit, "%H:%M").time()
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Ungültige Uhrzeit"})

    beschreibung = (payload.beschreibung or "").strip() or None
    return event_date, event_time, bezeichnung, location, beschreibung


@app.get("/api/plan")
async def list_plan_events(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    events = db.query(PlanEvent).order_by(PlanEvent.datum.asc(), PlanEvent.uhrzeit.asc()).all()
    return [
        {
            "id": e.id,
            "datum": e.datum.isoformat(),
            "uhrzeit": e.uhrzeit.strftime("%H:%M"),
            "bezeichnung": e.bezeichnung,
            "location": e.location,
            "beschreibung": e.beschreibung,
        }
        for e in events
    ]


@app.post("/api/plan")
async def create_plan_event(
    request: Request, payload: PlanEventCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Termine anlegen"})

    validated = _validate_plan_payload(payload)
    if isinstance(validated, JSONResponse):
        return validated
    event_date, event_time, bezeichnung, location, beschreibung = validated

    new_event = PlanEvent(
        datum=event_date,
        uhrzeit=event_time,
        bezeichnung=bezeichnung,
        location=location,
        beschreibung=beschreibung,
        created_by=username,
    )
    db.add(new_event)
    db.commit()
    db.refresh(new_event)

    return {
        "id": new_event.id,
        "datum": new_event.datum.isoformat(),
        "uhrzeit": new_event.uhrzeit.strftime("%H:%M"),
        "bezeichnung": new_event.bezeichnung,
        "location": new_event.location,
        "beschreibung": new_event.beschreibung,
    }


@app.patch("/api/plan/{event_id}")
async def update_plan_event(
    event_id: int, request: Request, payload: PlanEventCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Termine bearbeiten"})

    existing = db.query(PlanEvent).filter(PlanEvent.id == event_id).first()
    if not existing:
        return JSONResponse(status_code=404, content={"error": "not found"})

    validated = _validate_plan_payload(payload)
    if isinstance(validated, JSONResponse):
        return validated
    event_date, event_time, bezeichnung, location, beschreibung = validated

    existing.datum = event_date
    existing.uhrzeit = event_time
    existing.bezeichnung = bezeichnung
    existing.location = location
    existing.beschreibung = beschreibung
    db.commit()

    return {
        "id": existing.id,
        "datum": existing.datum.isoformat(),
        "uhrzeit": existing.uhrzeit.strftime("%H:%M"),
        "bezeichnung": existing.bezeichnung,
        "location": existing.location,
        "beschreibung": existing.beschreibung,
    }


@app.delete("/api/plan/{event_id}")
async def delete_plan_event(event_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Termine löschen"})

    event = db.query(PlanEvent).filter(PlanEvent.id == event_id).first()
    if event:
        db.delete(event)
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
    return {"id": me.id, "username": me.username, "role": me.role}


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
    # Sortierung nach created_at (echter Zeitstempel), nicht nach "datum" — das
    # Feld ist frei editierbar (z. B. beim Nacherfassen älterer Ausgaben) und
    # eignet sich daher nicht als verlässliche Sortiergrundlage.
    rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.status == "offen")
        .order_by(Ausgabe.created_at.desc())
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


def _validate_expense_payload(payload: ExpenseCreate, db: Session):
    """Validiert eine Ausgabe für Anlegen UND Bearbeiten. Gibt entweder ein Tupel
    (glaubiger_id, beneficiary_ids, betreff, expense_date, share) oder eine
    fertige JSONResponse mit Fehlermeldung zurück."""
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
    return payload.glaubiger_id, beneficiary_ids, betreff, expense_date, share


@app.post("/api/expenses")
async def create_expense(
    request: Request, payload: ExpenseCreate, db: Session = Depends(get_db)
):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    validated = _validate_expense_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    glaubiger_id, beneficiary_ids, betreff, expense_date, share = validated

    batch_id = uuid.uuid4().hex
    created = []
    for uid in beneficiary_ids:
        row = Ausgabe(
            glaubiger_id=glaubiger_id,
            schuldner_id=uid,
            cash=share,
            betreff=betreff,
            datum=expense_date,
            batch_id=batch_id,
        )
        db.add(row)
        created.append(row)
    db.commit()

    return {"created": len(created), "share": share, "betreff": betreff, "batch_id": batch_id}


@app.patch("/api/expenses/batch/{batch_id}")
async def update_expense_batch(
    batch_id: str, request: Request, payload: ExpenseCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Ausgaben bearbeiten"})

    existing_rows = (
        db.query(Ausgabe).filter(Ausgabe.batch_id == batch_id, Ausgabe.status == "offen").all()
    )
    if not existing_rows:
        return JSONResponse(status_code=404, content={"error": "Ausgabe nicht gefunden"})

    validated = _validate_expense_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    glaubiger_id, beneficiary_ids, betreff, expense_date, share = validated

    # Alte Zeilen des Vorgangs ersetzen statt anzupassen — einfacher und robuster
    # als ein Zeilen-für-Zeilen-Diff, gleiche batch_id bleibt für Kontinuität erhalten.
    for r in existing_rows:
        db.delete(r)
    for uid in beneficiary_ids:
        db.add(
            Ausgabe(
                glaubiger_id=glaubiger_id,
                schuldner_id=uid,
                cash=share,
                betreff=betreff,
                datum=expense_date,
                batch_id=batch_id,
            )
        )
    db.commit()

    return {"batch_id": batch_id, "created": len(beneficiary_ids), "share": share, "betreff": betreff}


@app.delete("/api/expenses/batch/{batch_id}")
async def delete_expense_batch(batch_id: str, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Ausgaben löschen"})

    deleted = (
        db.query(Ausgabe)
        .filter(Ausgabe.batch_id == batch_id, Ausgabe.status == "offen")
        .delete(synchronize_session=False)
    )
    db.commit()
    if deleted == 0:
        return JSONResponse(status_code=404, content={"error": "Ausgabe nicht gefunden"})
    return {"ok": True, "deleted": deleted}


def _compute_net_balances(db: Session) -> dict[int, float]:
    """Netto-Saldo je Person aus allen Ausgaben + bereits getilgten Tilgungen.
    "pending" Tilgungen zählen bewusst nicht mit — die würden sonst die Zahlen
    verschieben, bevor der Gläubiger überhaupt bestätigt hat."""
    rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.schuldner_id != Ausgabe.glaubiger_id, Ausgabe.status != "pending")
        .all()
    )
    net: dict[int, float] = {}
    for r in rows:
        cash = float(r.cash)
        net[r.glaubiger_id] = net.get(r.glaubiger_id, 0.0) + cash
        net[r.schuldner_id] = net.get(r.schuldner_id, 0.0) - cash
    return net


def _compute_min_settlements(net: dict[int, float]) -> list[tuple[int, int, float]]:
    """Greedy-Minimierung: größter Schuldner tilgt größten Gläubiger, bis alle
    Salden ~0 sind. Stabil sortiert (Betrag, dann User-ID), damit das Ergebnis bei
    unveränderten Netto-Salden IMMER identisch ausfällt — sonst würde das
    Bestätigen einer Zahlung die Vorschläge für alle anderen verschieben."""
    creditors = sorted(
        ([uid, amt] for uid, amt in net.items() if amt > 0.005), key=lambda x: (-x[1], x[0])
    )
    debtors = sorted(
        ([uid, -amt] for uid, amt in net.items() if amt < -0.005), key=lambda x: (-x[1], x[0])
    )

    result: list[tuple[int, int, float]] = []
    i = j = 0
    while i < len(creditors) and j < len(debtors):
        cred_id, cred_amt = creditors[i]
        deb_id, deb_amt = debtors[j]
        amount = round(min(cred_amt, deb_amt), 2)
        if amount > 0.005:
            result.append((deb_id, cred_id, amount))
        creditors[i][1] -= amount
        debtors[j][1] -= amount
        if creditors[i][1] <= 0.005:
            i += 1
        if debtors[j][1] <= 0.005:
            j += 1
    return result


@app.get("/api/expenses/open")
async def get_open_settlements(request: Request, db: Session = Depends(get_db)):
    """
    Schlägt die minimale Anzahl an Überweisungen vor, um alle offenen Schulden
    auszugleichen (Greedy-Minimierung über alle Netto-Salden, siehe
    _compute_min_settlements). Die Berechnung ist deterministisch, solange sich
    die zugrunde liegenden (nicht-pending) Salden nicht ändern — das Bestätigen
    einer einzelnen Zahlung verschiebt die Vorschläge für andere Personen daher
    nie, egal wie viele Zahlungen gleichzeitig unterwegs sind.

    "pending" Tilgungseinträge zählen bewusst NICHT in die Berechnung hinein
    (sonst würde die Kachel sofort verschwinden, bevor der Gläubiger bestätigt
    hat) — stattdessen wird die Kachel per "pending"-Flag markiert, damit das
    Frontend sie ausgegraut mit "Wartet auf Bestätigung" statt mit Button zeigt.
    """
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    usernames = {u.id: u.username for u in db.query(User).all()}
    net = _compute_net_balances(db)
    min_settlements = _compute_min_settlements(net)

    pending_by_pair = {
        (r.glaubiger_id, r.schuldner_id): float(r.cash)
        for r in db.query(Ausgabe).filter(Ausgabe.status == "pending").all()
    }

    settlements = []
    seen_pairs = set()
    for deb_id, cred_id, amount in min_settlements:
        seen_pairs.add((deb_id, cred_id))
        settlements.append(
            {
                "from_id": deb_id,
                "from": usernames.get(deb_id, "?"),
                "to_id": cred_id,
                "to": usernames.get(cred_id, "?"),
                "amount": amount,
                "pending": (deb_id, cred_id) in pending_by_pair,
            }
        )

    # Pending Tilgungen, die im aktuellen Vorschlag nicht (mehr) vorkommen (z. B.
    # weil sich der offene Betrag inzwischen exakt deckt), trotzdem als wartende
    # Kachel zeigen, bis der Gläubiger bestätigt.
    for (from_id, to_id), amount in pending_by_pair.items():
        if (from_id, to_id) in seen_pairs:
            continue
        settlements.append(
            {
                "from_id": from_id,
                "from": usernames.get(from_id, "?"),
                "to_id": to_id,
                "to": usernames.get(to_id, "?"),
                "amount": amount,
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

    Der Betrag wird über dieselbe Minimierungs-Berechnung wie /api/expenses/open
    ermittelt (nicht aus der direkten Historie zwischen den beiden), damit auch
    global optimierte Zahlungsvorschläge bestätigt werden können, die keine
    direkte gemeinsame Ausgabe haben.
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

    net = _compute_net_balances(db)
    min_settlements = _compute_min_settlements(net)
    match = next(
        (amount for deb_id, cred_id, amount in min_settlements if deb_id == me.id and cred_id == creditor.id),
        None,
    )
    if match is None:
        return JSONResponse(
            status_code=400,
            content={"error": "Diese Zahlung ist aktuell nicht mehr offen — bitte Ansicht neu laden"},
        )

    tilgung = Ausgabe(
        glaubiger_id=me.id,
        schuldner_id=creditor.id,
        cash=match,
        betreff=f"Tilgung an {creditor.username}",
        datum=date.today(),
        status="pending",
    )
    db.add(tilgung)
    db.commit()
    return {"created": True, "amount": match, "to": creditor.username}


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
            content={
                "error": f"Der eingegebene Betrag stimmt nicht mit den gemeldeten {float(row.cash):.2f} € überein".replace(".", ",")
            },
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
