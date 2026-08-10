import re
import time
import uuid
from datetime import date, datetime as dt
from pathlib import Path

import httpx
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
    PlanEvent,
    Task,
    TaskAssignee,
    TaskCategory,
    TaskSubitem,
    Ausgabe,
    ActivityLog,
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


# Aktivitäts-Log: absichtlich sehr eng gehalten (nur die Aktionen, bei denen
# eine ANDERE Person konkret betroffen ist — neue Aufgabe, Aufgabe erledigt,
# Ausgabe erfasst, Zahlung gemeldet/bestätigt), nicht jeder Klick in der App.
def log_action(db: Session, actor: str, affected: str | None, action: str, message: str):
    if affected == actor:
        affected = None
    db.add(ActivityLog(actor_username=actor, affected_username=affected, action=action, message=message))


# --- Schemas ---
class ShoppingItemCreate(BaseModel):
    name: str
    woher_id: int | None = None


class ShoppingSourceCreate(BaseModel):
    farbe: str
    bezeichnung: str


class TaskCreate(BaseModel):
    titel: str
    beschreibung: str | None = None
    deadline: str | None = None
    assignee_ids: list[int] = []
    category_id: int | None = None
    recurring: bool = False
    aufwand_min: int | None = None


class TaskSubitemCreate(BaseModel):
    titel: str


class TaskCategoryCreate(BaseModel):
    farbe: str
    bezeichnung: str


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
    # Optional: fixer Betrag für einzelne Personen (user_id -> Betrag). Wer hier
    # nicht auftaucht, teilt sich den verbleibenden Rest gleichmäßig auf.
    fixed_amounts: dict[int, float] = {}


class SettleRequest(BaseModel):
    to_id: int
    amount: float | None = None


class ConfirmReceivedRequest(BaseModel):
    expense_id: int
    amount: float


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


# --- Einkaufsliste ---

def _serialize_shopping_item(item: ShoppingItem, woher: ShoppingSource | None) -> dict:
    return {
        "id": item.id,
        "name": item.name,
        "done": item.done,
        "added_by": item.added_by,
        "deadline": item.deadline.isoformat() if item.deadline else None,
        "woher": {"id": woher.id, "farbe": woher.farbe, "bezeichnung": woher.bezeichnung} if woher else None,
    }


@app.get("/api/shopping")
def get_shopping_items(request: Request, db: Session = Depends(get_db)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    # Statische Sortierung: rein nach Erstellzeit, unabhängig vom "erledigt"-Status.
    # Sonst springt ein Item beim Abhaken sofort ans Listenende, was beim schnellen
    # Abhaken mehrerer Dinge nervig ist. Umsortieren nach Name/Woher/Status passiert
    # nur clientseitig, wenn gewünscht.
    items = db.query(ShoppingItem).order_by(ShoppingItem.created_at.desc()).all()
    sources = {s.id: s for s in db.query(ShoppingSource).all()}
    return [_serialize_shopping_item(i, sources.get(i.woher_id)) for i in items]


@app.post("/api/shopping")
def create_shopping_item(
    request: Request, item: ShoppingItemCreate, db: Session = Depends(get_db)
):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    name = item.name.strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "Name darf nicht leer sein"})
    if len(name) > 80:
        return JSONResponse(status_code=400, content={"error": "Name darf maximal 80 Zeichen haben"})

    woher = None
    if item.woher_id is not None:
        woher = db.query(ShoppingSource).filter(ShoppingSource.id == item.woher_id).first()
        if not woher:
            return JSONResponse(status_code=400, content={"error": "Unbekannte Quelle"})

    new_item = ShoppingItem(name=name, added_by=user, woher_id=woher.id if woher else None)
    db.add(new_item)
    db.commit()
    db.refresh(new_item)

    return _serialize_shopping_item(new_item, woher)


@app.patch("/api/shopping/{item_id}")
def update_shopping_item(
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
    if len(name) > 80:
        return JSONResponse(status_code=400, content={"error": "Name darf maximal 80 Zeichen haben"})

    woher = None
    if item.woher_id is not None:
        woher = db.query(ShoppingSource).filter(ShoppingSource.id == item.woher_id).first()
        if not woher:
            return JSONResponse(status_code=400, content={"error": "Unbekannte Quelle"})

    existing.name = name
    existing.woher_id = woher.id if woher else None
    db.commit()

    return _serialize_shopping_item(existing, woher)


# --- Woher-Quellen für die Einkaufsliste ---

@app.get("/api/shopping-sources")
def list_shopping_sources(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    sources = db.query(ShoppingSource).order_by(ShoppingSource.bezeichnung.asc()).all()
    return [{"id": s.id, "farbe": s.farbe, "bezeichnung": s.bezeichnung} for s in sources]


@app.post("/api/shopping-sources")
def create_shopping_source(
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
def toggle_shopping_item(item_id: int, request: Request, db: Session = Depends(get_db)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    item = db.query(ShoppingItem).filter(ShoppingItem.id == item_id).first()
    if not item:
        return JSONResponse(status_code=404, content={"error": "not found"})

    item.done = not item.done
    db.commit()
    return {"id": item.id, "done": item.done}


@app.patch("/api/shopping/{item_id}/deadline-today")
def toggle_shopping_deadline_today(item_id: int, request: Request, db: Session = Depends(get_db)):
    """Schnellaktion (❗-Button): markiert "wird heute gebraucht". Steht das
    Datum schon auf heute, wird es stattdessen wieder entfernt (Toggle)."""
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    item = db.query(ShoppingItem).filter(ShoppingItem.id == item_id).first()
    if not item:
        return JSONResponse(status_code=404, content={"error": "not found"})

    item.deadline = None if item.deadline == date.today() else date.today()
    db.commit()
    return {"id": item.id, "deadline": item.deadline.isoformat() if item.deadline else None}


@app.delete("/api/shopping/{item_id}")
def delete_shopping_item(item_id: int, request: Request, db: Session = Depends(get_db)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    item = db.query(ShoppingItem).filter(ShoppingItem.id == item_id).first()
    if item:
        db.delete(item)
        db.commit()
    return {"ok": True}


# --- Aufgaben (geteilt, höchstens eine Person zuweisbar, mit Deadline) ---

def _validate_task_payload(payload: TaskCreate, db: Session):
    """Gibt entweder (titel, beschreibung, deadline, assignee_ids, category_id,
    aufwand_min) oder eine fertige JSONResponse mit Fehlermeldung zurück."""
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

    # Höchstens eine Person: entweder klar verantwortlich, oder niemand (dann
    # gilt die Aufgabe für alle, siehe Frontend-Filter/Dashboard).
    assignee_ids = sorted(set(payload.assignee_ids))
    if len(assignee_ids) > 1:
        return JSONResponse(status_code=400, content={"error": "Nur eine Person kann zugewiesen werden"})
    if assignee_ids:
        valid_ids = {u.id for u in db.query(User).filter(User.id.in_(assignee_ids)).all()}
        if not set(assignee_ids).issubset(valid_ids):
            return JSONResponse(status_code=400, content={"error": "Unbekannte Person ausgewählt"})

    category_id = payload.category_id
    if category_id is not None:
        if not db.query(TaskCategory).filter(TaskCategory.id == category_id).first():
            return JSONResponse(status_code=400, content={"error": "Unbekannte Kategorie"})

    aufwand_min = payload.aufwand_min
    if aufwand_min is not None and aufwand_min < 0:
        return JSONResponse(status_code=400, content={"error": "Aufwand darf nicht negativ sein"})

    return titel, beschreibung, deadline, assignee_ids, category_id, aufwand_min


def _serialize_task(
    task: Task,
    assignee_ids: list[int],
    usernames: dict[int, str],
    categories: dict[int, TaskCategory],
    subitems: list[TaskSubitem] | None = None,
) -> dict:
    category = categories.get(task.category_id) if task.category_id else None
    return {
        "id": task.id,
        "titel": task.titel,
        "beschreibung": task.beschreibung,
        "done": task.done,
        "deadline": task.deadline.isoformat() if task.deadline else None,
        "created_by": task.created_by,
        "recurring": task.recurring,
        "aufwand_min": task.aufwand_min,
        "assignees": [
            {"id": uid, "username": usernames.get(uid, "?")} for uid in assignee_ids
        ],
        "category": (
            {"id": category.id, "farbe": category.farbe, "bezeichnung": category.bezeichnung}
            if category
            else None
        ),
        "subitems": [{"id": s.id, "titel": s.titel, "done": s.done} for s in (subitems or [])],
    }


@app.get("/api/tasks")
def list_tasks(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    tasks = db.query(Task).order_by(Task.created_at.desc()).all()
    usernames = {u.id: u.username for u in db.query(User).all()}
    categories = {c.id: c for c in db.query(TaskCategory).all()}

    assignees_by_task: dict[int, list[int]] = {}
    for a in db.query(TaskAssignee).all():
        assignees_by_task.setdefault(a.task_id, []).append(a.user_id)

    subitems_by_task: dict[int, list[TaskSubitem]] = {}
    for s in db.query(TaskSubitem).order_by(TaskSubitem.created_at.asc()).all():
        subitems_by_task.setdefault(s.task_id, []).append(s)

    return [
        _serialize_task(
            t, assignees_by_task.get(t.id, []), usernames, categories, subitems_by_task.get(t.id, [])
        )
        for t in tasks
    ]


@app.get("/api/task-categories")
def list_task_categories(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    categories = db.query(TaskCategory).order_by(TaskCategory.bezeichnung.asc()).all()
    return [{"id": c.id, "farbe": c.farbe, "bezeichnung": c.bezeichnung} for c in categories]


@app.post("/api/task-categories")
def create_task_category(
    request: Request, payload: TaskCategoryCreate, db: Session = Depends(get_db)
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

    existing = db.query(TaskCategory).filter(TaskCategory.bezeichnung == bezeichnung).first()
    if existing:
        return JSONResponse(status_code=400, content={"error": "Diese Bezeichnung gibt es schon"})

    category = TaskCategory(farbe=farbe, bezeichnung=bezeichnung)
    db.add(category)
    db.commit()
    db.refresh(category)
    return {"id": category.id, "farbe": category.farbe, "bezeichnung": category.bezeichnung}


@app.post("/api/tasks")
def create_task(request: Request, payload: TaskCreate, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    validated = _validate_task_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    titel, beschreibung, deadline, assignee_ids, category_id, aufwand_min = validated

    task = Task(
        titel=titel,
        beschreibung=beschreibung,
        deadline=deadline,
        created_by=username,
        category_id=category_id,
        recurring=payload.recurring,
        aufwand_min=aufwand_min,
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    for uid in assignee_ids:
        db.add(TaskAssignee(task_id=task.id, user_id=uid))
    db.commit()

    usernames = {u.id: u.username for u in db.query(User).filter(User.id.in_(assignee_ids)).all()}
    categories = {
        c.id: c for c in db.query(TaskCategory).filter(TaskCategory.id == task.category_id).all()
    }

    if assignee_ids:
        affected = usernames.get(assignee_ids[0])
        if affected:
            log_action(db, username, affected, "task_created", f"{username} hat dir die Aufgabe „{titel}“ zugewiesen")
            db.commit()

    return _serialize_task(task, assignee_ids, usernames, categories, [])


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: int, request: Request, payload: TaskCreate, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        return JSONResponse(status_code=404, content={"error": "not found"})

    validated = _validate_task_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    titel, beschreibung, deadline, assignee_ids, category_id, aufwand_min = validated

    task.titel = titel
    task.beschreibung = beschreibung
    task.deadline = deadline
    task.category_id = category_id
    task.recurring = payload.recurring
    task.aufwand_min = aufwand_min
    db.query(TaskAssignee).filter(TaskAssignee.task_id == task.id).delete(synchronize_session=False)
    for uid in assignee_ids:
        db.add(TaskAssignee(task_id=task.id, user_id=uid))
    db.commit()

    usernames = {u.id: u.username for u in db.query(User).filter(User.id.in_(assignee_ids)).all()}
    categories = {
        c.id: c for c in db.query(TaskCategory).filter(TaskCategory.id == task.category_id).all()
    }
    subitems = db.query(TaskSubitem).filter(TaskSubitem.task_id == task.id).order_by(TaskSubitem.created_at.asc()).all()
    return _serialize_task(task, assignee_ids, usernames, categories, subitems)


@app.patch("/api/tasks/{task_id}/toggle")
def toggle_task(task_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        return JSONResponse(status_code=404, content={"error": "not found"})

    task.done = not task.done
    cloned = False

    if task.done:
        assignee = db.query(TaskAssignee).filter(TaskAssignee.task_id == task.id).first()
        if assignee:
            affected_user = db.query(User).filter(User.id == assignee.user_id).first()
            if affected_user:
                log_action(
                    db,
                    username,
                    affected_user.username,
                    "task_done",
                    f"{username} hat deine Aufgabe „{task.titel}“ abgeschlossen",
                )

        # Wiederkehrend: die erledigte Zeile bleibt als abgeschlossener Vorgang
        # stehen (zählt in der Statistik als "erledigt"), eine frische Kopie
        # entsteht offen — zählt dort dann als eigene, neue Aufgabe.
        if task.recurring:
            clone = Task(
                titel=task.titel,
                beschreibung=task.beschreibung,
                deadline=task.deadline,
                created_by=task.created_by,
                category_id=task.category_id,
                recurring=True,
                aufwand_min=task.aufwand_min,
            )
            db.add(clone)
            db.commit()
            db.refresh(clone)
            for a in db.query(TaskAssignee).filter(TaskAssignee.task_id == task.id).all():
                db.add(TaskAssignee(task_id=clone.id, user_id=a.user_id))
            cloned = True

    db.commit()
    return {"id": task.id, "done": task.done, "cloned": cloned}


@app.patch("/api/tasks/{task_id}/deadline-today")
def toggle_task_deadline_today(task_id: int, request: Request, db: Session = Depends(get_db)):
    """Schnellaktion (❗-Button): setzt die Deadline auf heute. Steht sie schon
    auf heute, wird sie stattdessen wieder entfernt (Toggle)."""
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        return JSONResponse(status_code=404, content={"error": "not found"})

    if task.deadline and task.deadline.date() == date.today():
        task.deadline = None
    else:
        task.deadline = dt.combine(date.today(), dt.min.time())
    db.commit()
    return {"id": task.id, "deadline": task.deadline.isoformat() if task.deadline else None}


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: int, request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(Task).filter(Task.id == task_id).first()
    if task:
        db.query(TaskAssignee).filter(TaskAssignee.task_id == task.id).delete(synchronize_session=False)
        db.query(TaskSubitem).filter(TaskSubitem.task_id == task.id).delete(synchronize_session=False)
        db.delete(task)
        db.commit()
    return {"ok": True}


# --- Teilaufgaben (Checkliste innerhalb einer Aufgabe) ---

@app.post("/api/tasks/{task_id}/subitems")
def create_task_subitem(task_id: int, request: Request, payload: TaskSubitemCreate, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        return JSONResponse(status_code=404, content={"error": "not found"})

    titel = payload.titel.strip()
    if not titel:
        return JSONResponse(status_code=400, content={"error": "Titel darf nicht leer sein"})
    if len(titel) > 120:
        return JSONResponse(status_code=400, content={"error": "Titel darf maximal 120 Zeichen haben"})

    sub = TaskSubitem(task_id=task_id, titel=titel)
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return {"id": sub.id, "titel": sub.titel, "done": sub.done}


@app.patch("/api/tasks/{task_id}/subitems/{sub_id}/toggle")
def toggle_task_subitem(task_id: int, sub_id: int, request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    sub = db.query(TaskSubitem).filter(TaskSubitem.id == sub_id, TaskSubitem.task_id == task_id).first()
    if not sub:
        return JSONResponse(status_code=404, content={"error": "not found"})

    sub.done = not sub.done
    db.commit()
    return {"id": sub.id, "done": sub.done}


@app.delete("/api/tasks/{task_id}/subitems/{sub_id}")
def delete_task_subitem(task_id: int, sub_id: int, request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    db.query(TaskSubitem).filter(TaskSubitem.id == sub_id, TaskSubitem.task_id == task_id).delete(
        synchronize_session=False
    )
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
def list_plan_events(request: Request, db: Session = Depends(get_db)):
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
def create_plan_event(
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
def update_plan_event(
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
def delete_plan_event(event_id: int, request: Request, db: Session = Depends(get_db)):
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
def get_me(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    me = db.query(User).filter(User.username == username).first()
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return {"id": me.id, "username": me.username, "role": me.role}


@app.get("/api/users")
def list_users(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    users = db.query(User).order_by(User.username.asc()).all()
    return [{"id": u.id, "username": u.username} for u in users]


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

    # Tilgungseinträge (Rückzahlungen, status != "offen") sind Buchhaltung, keine eigenen Einkäufe
    # Sortierung nach "datum" (eingestelltes/vom Nutzer gesetztes Datum), nicht nach
    # created_at — Nutzer wollen die Liste nach dem Datum sehen, das sie der Ausgabe
    # gegeben haben, auch wenn diese später nacherfasst oder bearbeitet wurde.
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
        }
        for r in rows
    ]


@app.get("/api/expenses/balance")
def get_expense_balance(request: Request, db: Session = Depends(get_db)):
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
        if expense_date > date.today():
            return JSONResponse(status_code=400, content={"error": "Datum darf nicht in der Zukunft liegen"})
    else:
        expense_date = date.today()

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
    # Snackkauf ohne Beteiligte). schuldner_id == glaubiger_id ist keine echte Schuld,
    # zählt aber fürs Leaderboard mit und wird in Saldo/Offene-Zahlungen ausgeblendet.
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
    if not get_current_user(request):
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
        )
        db.add(row)
        created.append(row)
    db.commit()

    names = {u.id: u.username for u in db.query(User).filter(User.id.in_(beneficiary_ids + [glaubiger_id])).all()}
    payer_name = names.get(glaubiger_id, "?")
    for uid in beneficiary_ids:
        beneficiary_name = names.get(uid, "?")
        amount_str = f"{amounts[uid]:.2f} €".replace(".", ",")
        log_action(
            db, payer_name, beneficiary_name, "expense_created",
            f"{payer_name} hat {amount_str} für „{betreff}“ für dich bezahlt",
        )
    db.commit()

    return {"created": len(created), "amounts": amounts, "betreff": betreff, "batch_id": batch_id}


@app.patch("/api/expenses/batch/{batch_id}")
def update_expense_batch(
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
            )
        )
    db.commit()

    return {"batch_id": batch_id, "created": len(beneficiary_ids), "amounts": amounts, "betreff": betreff}


@app.delete("/api/expenses/batch/{batch_id}")
def delete_expense_batch(batch_id: str, request: Request, db: Session = Depends(get_db)):
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


def _pairwise_raw_breakdown(db: Session) -> list[dict]:
    """Für jedes Personenpaar, das tatsächlich mindestens eine gemeinsame
    Ausgabe hatte: die rohen Summen je Richtung (a->b und b->a, vor der
    Verrechnung) plus den daraus resultierenden Netto-Betrag. Eigenkäufe
    (schuldner_id == glaubiger_id) und "pending"-Tilgungen fließen bewusst
    nicht ein — Eigenkäufe erzeugen kein Schuldverhältnis, pending-Tilgungen
    würden die Zahlen verschieben, bevor der Gläubiger bestätigt hat.

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


def _pairwise_example(db: Session) -> dict | None:
    """Konkretes Beispielpaar mit den einzelnen zugrundeliegenden Ausgaben-Zeilen
    (nicht nur der Summe) für die Erklär-Animation — zeigt anschaulich, wie sich
    ein a_to_b/b_to_a-Wert aus Schritt 1 tatsächlich zusammensetzt. Wählt das
    Paar mit den meisten Einzel-Positionen (interessantestes Beispiel); die
    Summen entsprechen exakt denen aus _pairwise_raw_breakdown für dieses Paar,
    nur die Anzeige der Einzelposten ist auf ein paar Beispiele begrenzt."""
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
        return None
    pair, pair_rows = max(by_pair.items(), key=lambda kv: len(kv[1]))
    a_id, b_id = tuple(pair)

    usernames = {u.id: u.username for u in db.query(User).all()}
    a_to_b_rows = [r for r in pair_rows if r.schuldner_id == a_id]
    b_to_a_rows = [r for r in pair_rows if r.schuldner_id == b_id]

    def summarize(rows_: list[Ausgabe], limit: int = 3) -> dict:
        shown = [{"betreff": r.betreff, "cash": float(r.cash), "tilgung": r.status == "getilgt"} for r in rows_[:limit]]
        return {"items": shown, "more": max(0, len(rows_) - limit), "total": round(sum(float(r.cash) for r in rows_), 2)}

    return {
        "a_id": a_id, "a": usernames.get(a_id, "?"),
        "b_id": b_id, "b": usernames.get(b_id, "?"),
        "a_to_b": summarize(a_to_b_rows),
        "b_to_a": summarize(b_to_a_rows),
    }


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
    (nicht-pending) Beträge nicht ändern.

    "pending" Tilgungseinträge zählen bewusst NICHT in die Berechnung hinein
    (sonst würde die Kachel sofort verschwinden, bevor der Gläubiger bestätigt
    hat) — stattdessen wird die Kachel per "pending"-Flag markiert, damit das
    Frontend sie ausgegraut mit "Wartet auf Bestätigung" statt mit Button zeigt.
    """
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    usernames = {u.id: u.username for u in db.query(User).all()}
    min_settlements = _compute_settlements(db)

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

    example = _pairwise_example(db)
    ledgers = _settlement_ledgers(db)

    return {"pairs": pairs, "netted_pairs": netted_pairs, "merges": merges, "steps": steps, "example": example, "ledgers": ledgers}


@app.post("/api/expenses/settle")
def settle_expenses(
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
        datum=date.today(),
        status="pending",
    )
    db.add(tilgung)
    db.commit()

    amount_str = f"{amount:.2f} €".replace(".", ",")
    log_action(
        db, me.username, creditor.username, "payment_reported",
        f"{me.username} hat gemeldet, dir {amount_str} überwiesen zu haben",
    )
    db.commit()

    return {"created": True, "amount": amount, "to": creditor.username}


@app.get("/api/expenses/received")
def get_pending_received(request: Request, db: Session = Depends(get_db)):
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
def confirm_received_payment(
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

    original_sender = db.query(User).filter(User.id == row.glaubiger_id).first()
    if original_sender:
        amount_str = f"{float(row.cash):.2f} €".replace(".", ",")
        log_action(
            db, me.username, original_sender.username, "payment_confirmed",
            f"{me.username} hat deine Zahlung von {amount_str} bestätigt",
        )
        db.commit()

    return {"ok": True}


@app.get("/api/expenses/settled")
def get_settled_payments(request: Request, db: Session = Depends(get_db)):
    """Bereits bestätigte Rückzahlungen (status='getilgt') — reine Historie,
    zeigt wer wann wie viel an wen gezahlt hat und bereits bestätigt wurde.
    Im Tilgungseintrag ist glaubiger_id der ursprüngliche Absender (Schuldner)
    und schuldner_id der Empfänger, der bestätigt hat (siehe settle_expenses/
    confirm_received_payment) — für die Anzeige also "from"=glaubiger."""
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    usernames = {u.id: u.username for u in db.query(User).all()}
    rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.status == "getilgt")
        .order_by(Ausgabe.created_at.desc())
        .all()
    )
    return [
        {
            "id": r.id,
            "from_id": r.glaubiger_id,
            "from": usernames.get(r.glaubiger_id, "?"),
            "to_id": r.schuldner_id,
            "to": usernames.get(r.schuldner_id, "?"),
            "amount": float(r.cash),
            "date": r.datum.isoformat(),
        }
        for r in rows
    ]


@app.get("/api/expenses/leaderboard")
def get_expense_leaderboard(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
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
        ({"user_id": u.id, "total": float(totals.get(u.id, 0) or 0)} for u in users),
        key=lambda x: -x["total"],
    )

    # Das volle Ranking bleibt bis zum Ende des Camps geheim (siehe Frontend-
    # Hinweis) — hier wird deshalb nur der eigene Platz zurückgegeben, nie die
    # Beträge der anderen.
    me = next((u for u in users if u.username == username), None)
    rank = next((i + 1 for i, r in enumerate(ranking) if me and r["user_id"] == me.id), None)

    return {
        "rank": rank,
        "total_participants": len(ranking),
        "your_total": float(totals.get(me.id, 0) or 0) if me else 0,
    }


# --- Wetter (Open-Meteo, keine Anmeldung/API-Key nötig) ---
# Feste Koordinaten des Camp-Standorts.
CAMP_LAT = 47.6738659
CAMP_LON = 9.7418924
WEATHER_CACHE_SECONDS = 600  # 10 Minuten — genug Aktualität, schont die kostenlose API
THUNDERSTORM_CODES = {95, 96, 99}
STORM_GUST_THRESHOLD_KMH = 70
# WMO-Wettercodes zu Niederschlags-Intensität gruppiert — unabhängig von
# Gewitter (das wird separat über THUNDERSTORM_CODES geflaggt, damit "Regen"/
# "Starkregen" rein die Intensität beschreiben und Gewitter ein eigenes,
# zusätzliches Signal bleibt).
HEAVY_RAIN_CODES = {65, 67, 82, 86, 96, 99}
RAIN_CODES = {51, 53, 55, 56, 57, 61, 63, 66, 71, 73, 75, 77, 80, 81, 85, 95}


def _classify_precip_status(code: int) -> str:
    if code in HEAVY_RAIN_CODES:
        return "starkregen"
    if code in RAIN_CODES:
        return "regen"
    return "trocken"

_weather_cache = {"data": None, "fetched_at": 0.0}


def _fetch_weather_raw() -> dict:
    now = time.time()
    if _weather_cache["data"] and now - _weather_cache["fetched_at"] < WEATHER_CACHE_SECONDS:
        return _weather_cache["data"]

    resp = httpx.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": CAMP_LAT,
            "longitude": CAMP_LON,
            "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,"
            "wind_gusts_10m,wind_direction_10m,relative_humidity_2m,precipitation",
            "hourly": "temperature_2m,precipitation_probability,precipitation,weather_code,"
            "wind_speed_10m,wind_gusts_10m",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
            "wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset",
            "timezone": "Europe/Berlin",
            "forecast_days": 4,
        },
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    _weather_cache["data"] = data
    _weather_cache["fetched_at"] = now
    return data


@app.get("/api/weather")
def get_weather(request: Request):
    """Kein Standort-Handling nötig — der Camp-Standort ist fix. Ableitung von
    Gewitter-/Sturmwarnungen passiert hier aus den echten Open-Meteo-Rohdaten
    (Wettercode 95/96/99 bzw. Böen ab 70 km/h in den nächsten 72h) — das ist
    keine offizielle DWD-Unwetterwarnung, sondern eine eigene, transparente
    Schwellenwert-Auswertung auf Basis echter Vorhersagedaten."""
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    try:
        data = _fetch_weather_raw()
    except Exception:
        return JSONResponse(status_code=502, content={"error": "Wetterdaten aktuell nicht abrufbar"})

    hourly = data.get("hourly", {})
    times = hourly.get("time", [])
    codes = hourly.get("weather_code", [])
    gusts = hourly.get("wind_gusts_10m", [])
    # current.time hat Minutenauflösung (z. B. "...T12:30"), hourly.time nur
    # volle Stunden — ein exakter String-Vergleich träfe daher nie. ISO8601 in
    # diesem Format ("YYYY-MM-DDTHH:MM") vergleicht sich lexikografisch korrekt
    # chronologisch, daher reicht ">=" um die nächste kommende Stunde zu finden.
    current_time = data.get("current", {}).get("time") or ""
    start_idx = next((i for i, t in enumerate(times) if t >= current_time), 0)
    # 72h statt nur 24h: die 3-Tage-Prognose (heute/morgen/übermorgen) braucht
    # stündliche Auflösung für alle drei Tage, nicht nur für den ersten, sonst
    # lässt sich für Tag 2/3 keine Uhrzeit für Regen/Böen angeben.
    # codes/gusts können bei einer degradierten Open-Meteo-Antwort kürzer als
    # times sein — end_idx muss auch das begrenzen, sonst crasht codes[i]/gusts[i]
    # weiter unten ungefangen mit IndexError.
    end_idx = min(start_idx + 72, len(times), len(codes), len(gusts))

    warnings = []
    for i in range(start_idx, end_idx):
        if codes[i] in THUNDERSTORM_CODES:
            warnings.append({"type": "gewitter", "time": times[i], "message": "Gewitter möglich"})
        elif gusts[i] >= STORM_GUST_THRESHOLD_KMH:
            warnings.append(
                {"type": "sturm", "time": times[i], "message": f"Starke Böen bis {round(gusts[i])} km/h"}
            )

    hourly_out = [
        {
            "time": times[i],
            "temp": hourly.get("temperature_2m", [None])[i] if i < len(hourly.get("temperature_2m", [])) else None,
            "precip_prob": hourly.get("precipitation_probability", [None])[i]
            if i < len(hourly.get("precipitation_probability", []))
            else None,
            "precip": hourly.get("precipitation", [None])[i] if i < len(hourly.get("precipitation", [])) else None,
            "code": codes[i],
            "wind": hourly.get("wind_speed_10m", [None])[i] if i < len(hourly.get("wind_speed_10m", [])) else None,
            "gust": gusts[i] if i < len(gusts) else None,
        }
        for i in range(start_idx, end_idx)
    ]

    daily = data.get("daily", {})
    daily_out = [
        {
            "date": daily["time"][i],
            "code": daily["weather_code"][i],
            "temp_max": daily["temperature_2m_max"][i],
            "temp_min": daily["temperature_2m_min"][i],
            "precip_prob": daily["precipitation_probability_max"][i],
            "wind_max": daily["wind_speed_10m_max"][i],
            "gust_max": daily["wind_gusts_10m_max"][i],
        }
        for i in range(len(daily.get("time", [])))
    ]

    # Fokussierte 3-Tage-Prognose (heute/morgen/übermorgen) mit genau den vier
    # relevanten Signalen: Niederschlags-Intensität (trocken/regen/starkregen)
    # MIT Uhrzeit-Fenster, Gewitter, Windgeschwindigkeit mit Böen-Spitze samt
    # Uhrzeit. Bewusst aus den STÜNDLICHEN Daten abgeleitet (nicht aus dem
    # einzelnen Tages-Code) — so bleibt die Einstufung immer konsistent mit der
    # angezeigten Uhrzeit, statt wie vorher zwei unabhängige Signale zu zeigen,
    # die sich scheinbar widersprechen konnten.
    precips = hourly.get("precipitation", [])
    precip_probs = hourly.get("precipitation_probability", [])

    day_groups: dict[str, list[int]] = {}
    for i in range(start_idx, end_idx):
        day_groups.setdefault(times[i][:10], []).append(i)

    forecast = []
    for date, idxs in list(day_groups.items())[:3]:
        rain_idxs = [
            i
            for i in idxs
            if (precips[i] if i < len(precips) else 0) >= 0.1
            or (precip_probs[i] if i < len(precip_probs) else 0) >= 30
        ]
        if rain_idxs:
            status = "starkregen" if any(codes[i] in HEAVY_RAIN_CODES for i in rain_idxs) else "regen"
            rain_from = int(times[rain_idxs[0]][11:13])
            rain_to = int(times[rain_idxs[-1]][11:13])
        else:
            status = "trocken"
            rain_from = None
            rain_to = None

        gust_peak_idx = max(idxs, key=lambda i: gusts[i] if i < len(gusts) else 0)
        day_info = next((d for d in daily_out if d["date"] == date), None)

        forecast.append(
            {
                "date": date,
                "status": status,
                "rain_from": rain_from,
                "rain_to": rain_to,
                "thunderstorm": any(codes[i] in THUNDERSTORM_CODES for i in idxs),
                "wind_max": round(day_info["wind_max"]) if day_info else None,
                "gust_max": round(gusts[gust_peak_idx]),
                "gust_peak_hour": int(times[gust_peak_idx][11:13]),
                "temp_max": round(day_info["temp_max"]) if day_info else None,
                "temp_min": round(day_info["temp_min"]) if day_info else None,
            }
        )

    return {
        "current": data.get("current"),
        "hourly": hourly_out,
        "daily": daily_out,
        "forecast": forecast,
        "warnings": warnings,
        "fetched_at": _weather_cache["fetched_at"],
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
