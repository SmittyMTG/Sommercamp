import json
import re
import secrets
import time
import uuid
from datetime import date, datetime as dt
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Request, Depends, Form, UploadFile, File, Body
from fastapi.responses import HTMLResponse, RedirectResponse, Response, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, and_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import (
    SessionLocal,
    User,
    UserSession,
    PlanEvent,
    TaskCategory,
    Project,
    ProjectAccess,
    PrivateTask,
    PrivateTaskAssignee,
    PrivateTaskSubitem,
    Ausgabe,
    ActivityLog,
    pwd_context,
    get_db,
)
from auth import login, logout, get_current_user, verify_password
import push
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
# eine ANDERE Person konkret betroffen ist — neue Aufgabe, Aufgabe erledigt,
# Ausgabe erfasst, Zahlung gemeldet/bestätigt), nicht jeder Klick in der App.
def log_action(db: Session, actor: str, affected: str | None, action: str, message: str):
    if affected == actor:
        affected = None
    db.add(ActivityLog(actor_username=actor, affected_username=affected, action=action, message=message))


# --- Schemas ---
class TaskCategoryCreate(BaseModel):
    farbe: str
    bezeichnung: str


class PlanEventCreate(BaseModel):
    datum: str | None = None
    datum_ende: str | None = None
    uhrzeit: str | None = None
    uhrzeit_ende: str | None = None
    bezeichnung: str
    location: str | None = None
    beschreibung: str | None = None
    shared_project_id: int | None = None
    is_public: bool = False


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


class PrivateTaskCreate(BaseModel):
    titel: str
    beschreibung: str | None = None
    deadline: str | None = None
    category_id: int | None = None
    project_id: int | None = None
    assignee_ids: list[int] = []
    is_public: bool = False


class PrivateTaskSubitemCreate(BaseModel):
    titel: str


class ProjectCreate(BaseModel):
    name: str


class ProjectUpdate(BaseModel):
    name: str
    member_ids: list[int] = []


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


# --- Web Push (VAPID) — Registrierung/Verwaltung siehe push.py ---

# /sw.js bewusst NICHT unter /static/ ausgeliefert: ein Service Worker darf
# nur Seiten in seinem eigenen Pfad (oder tiefer) kontrollieren, unter
# /static/sw.js wäre der Scope auf /static/ beschränkt statt auf die ganze
# Seite. Service-Worker-Allowed setzt das zwar auch explizit, aber die
# Auslieferung von der Root aus ist die robustere, browserübergreifend
# unproblematische Variante.
@app.get("/sw.js")
def service_worker():
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


class PushSubscribeRequest(BaseModel):
    endpoint: str
    keys: dict


class PushUnsubscribeRequest(BaseModel):
    endpoint: str


class PushSendRequest(BaseModel):
    title: str
    body: str


@app.get("/api/push/vapid-public-key")
def get_vapid_public_key(request: Request):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return {"key": push.get_vapid_public_key_b64()}


@app.post("/api/push/subscribe")
def push_subscribe(request: Request, payload: PushSubscribeRequest, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if "p256dh" not in payload.keys or "auth" not in payload.keys:
        return JSONResponse(status_code=400, content={"error": "Ungültige Subscription"})
    push.save_subscription(db, username, payload.dict())
    return {"ok": True}


@app.post("/api/push/unsubscribe")
def push_unsubscribe(request: Request, payload: PushUnsubscribeRequest, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    push.remove_subscription(db, payload.endpoint)
    return {"ok": True}


@app.post("/api/push/send")
def push_send(request: Request, payload: PushSendRequest, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Benachrichtigungen verschicken"})

    title = payload.title.strip()
    body = payload.body.strip()
    if not title:
        return JSONResponse(status_code=400, content={"error": "Titel darf nicht leer sein"})
    if not body:
        return JSONResponse(status_code=400, content={"error": "Text darf nicht leer sein"})

    return push.send_to_all(db, title, body)


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


# --- "Tasks"-Seite (privat/projekt-getaggt, aktuell nur für Felix erreichbar
# über die Nav, siehe app.js) — Sichtbarkeit läuft über created_by ("privat")
# bzw. ProjectAccess (geteiltes Projekt), nicht über eine feste Zuweisungsliste
# wie bei den geteilten Aufgaben oben.

def _user_by_username(db: Session, username: str) -> User | None:
    return db.query(User).filter(User.username == username).first()


def _is_admin_user(user: User) -> bool:
    return bool(user.role and user.role.strip().lower() == "admin")


def _user_project_ids(db: Session, user_id: int) -> set[int]:
    return {a.project_id for a in db.query(ProjectAccess).filter(ProjectAccess.user_id == user_id).all()}


def _can_access_private_task(db: Session, user: User, task: PrivateTask) -> bool:
    if task.created_by == user.username or task.is_public or _is_admin_user(user):
        return True
    return bool(task.project_id and task.project_id in _user_project_ids(db, user.id))


def _can_use_private_project(db: Session, user: User, project_id: int | None) -> bool:
    if project_id is None or _is_admin_user(user):
        return True
    return project_id in _user_project_ids(db, user.id)


def _validate_private_task_payload(payload: PrivateTaskCreate, db: Session):
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

    category_id = payload.category_id
    if category_id is not None and not db.query(TaskCategory).filter(TaskCategory.id == category_id).first():
        return JSONResponse(status_code=400, content={"error": "Unbekannte Kategorie"})

    project_id = payload.project_id
    if project_id is not None and not db.query(Project).filter(Project.id == project_id).first():
        return JSONResponse(status_code=400, content={"error": "Unbekanntes Projekt"})

    # Mehrere Personen können gemeinsam verantwortlich sein, oder niemand.
    assignee_ids = sorted(set(payload.assignee_ids))
    if assignee_ids:
        valid_ids = {u.id for u in db.query(User).filter(User.id.in_(assignee_ids)).all()}
        if not set(assignee_ids).issubset(valid_ids):
            return JSONResponse(status_code=400, content={"error": "Unbekannte Person ausgewählt"})

    return titel, beschreibung, deadline, category_id, project_id, assignee_ids, payload.is_public


def _serialize_private_task(
    task: PrivateTask,
    assignee_ids: list[int],
    usernames: dict[int, str],
    categories: dict[int, TaskCategory],
    projects: dict[int, Project],
    subitems: list[PrivateTaskSubitem] | None = None,
) -> dict:
    category = categories.get(task.category_id) if task.category_id else None
    project = projects.get(task.project_id) if task.project_id else None
    return {
        "id": task.id,
        "titel": task.titel,
        "beschreibung": task.beschreibung,
        "done": task.done,
        "deadline": task.deadline.isoformat() if task.deadline else None,
        "created_by": task.created_by,
        "is_public": task.is_public,
        "assignees": [
            {"id": uid, "username": usernames.get(uid, "?")} for uid in assignee_ids
        ],
        "category": (
            {"id": category.id, "farbe": category.farbe, "bezeichnung": category.bezeichnung}
            if category
            else None
        ),
        "project": ({"id": project.id, "name": project.name} if project else None),
        "subitems": [{"id": s.id, "titel": s.titel, "done": s.done} for s in (subitems or [])],
    }


@app.get("/api/private-tasks")
def list_private_tasks(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    tasks = db.query(PrivateTask).order_by(PrivateTask.created_at.desc()).all()
    visible = [t for t in tasks if _can_access_private_task(db, me, t)]

    usernames = {u.id: u.username for u in db.query(User).all()}
    categories = {c.id: c for c in db.query(TaskCategory).all()}
    projects = {p.id: p for p in db.query(Project).all()}
    assignees_by_task: dict[int, list[int]] = {}
    for a in db.query(PrivateTaskAssignee).all():
        assignees_by_task.setdefault(a.task_id, []).append(a.user_id)
    subitems_by_task: dict[int, list[PrivateTaskSubitem]] = {}
    for s in db.query(PrivateTaskSubitem).order_by(PrivateTaskSubitem.created_at.asc()).all():
        subitems_by_task.setdefault(s.task_id, []).append(s)

    return [
        _serialize_private_task(
            t, assignees_by_task.get(t.id, []), usernames, categories, projects, subitems_by_task.get(t.id, [])
        )
        for t in visible
    ]


@app.post("/api/private-tasks")
def create_private_task(request: Request, payload: PrivateTaskCreate, db: Session = Depends(get_db)):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    validated = _validate_private_task_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    titel, beschreibung, deadline, category_id, project_id, assignee_ids, is_public = validated

    if not _can_use_private_project(db, me, project_id):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf dieses Projekt"})

    task = PrivateTask(
        titel=titel,
        beschreibung=beschreibung,
        deadline=deadline,
        created_by=username,
        category_id=category_id,
        project_id=project_id,
        is_public=is_public,
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    for uid in assignee_ids:
        db.add(PrivateTaskAssignee(task_id=task.id, user_id=uid))
    if assignee_ids:
        db.commit()

    usernames = {u.id: u.username for u in db.query(User).filter(User.id.in_(assignee_ids)).all()}
    categories = {c.id: c for c in db.query(TaskCategory).filter(TaskCategory.id == task.category_id).all()}
    projects = {p.id: p for p in db.query(Project).filter(Project.id == task.project_id).all()}
    return _serialize_private_task(task, assignee_ids, usernames, categories, projects, [])


@app.patch("/api/private-tasks/{task_id}")
def update_private_task(task_id: int, request: Request, payload: PrivateTaskCreate, db: Session = Depends(get_db)):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(PrivateTask).filter(PrivateTask.id == task_id).first()
    if not task:
        return JSONResponse(status_code=404, content={"error": "not found"})
    if not _can_access_private_task(db, me, task):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf diese Aufgabe"})

    validated = _validate_private_task_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    titel, beschreibung, deadline, category_id, project_id, assignee_ids, is_public = validated

    if project_id != task.project_id and not _can_use_private_project(db, me, project_id):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf dieses Projekt"})

    task.titel = titel
    task.beschreibung = beschreibung
    task.deadline = deadline
    task.category_id = category_id
    task.project_id = project_id
    task.is_public = is_public
    db.query(PrivateTaskAssignee).filter(PrivateTaskAssignee.task_id == task.id).delete(synchronize_session=False)
    for uid in assignee_ids:
        db.add(PrivateTaskAssignee(task_id=task.id, user_id=uid))
    db.commit()

    usernames = {u.id: u.username for u in db.query(User).filter(User.id.in_(assignee_ids)).all()}
    categories = {c.id: c for c in db.query(TaskCategory).filter(TaskCategory.id == task.category_id).all()}
    projects = {p.id: p for p in db.query(Project).filter(Project.id == task.project_id).all()}
    subitems = (
        db.query(PrivateTaskSubitem)
        .filter(PrivateTaskSubitem.task_id == task.id)
        .order_by(PrivateTaskSubitem.created_at.asc())
        .all()
    )
    return _serialize_private_task(task, assignee_ids, usernames, categories, projects, subitems)


@app.patch("/api/private-tasks/{task_id}/toggle")
def toggle_private_task(task_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(PrivateTask).filter(PrivateTask.id == task_id).first()
    if not task:
        return JSONResponse(status_code=404, content={"error": "not found"})
    if not _can_access_private_task(db, me, task):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf diese Aufgabe"})

    task.done = not task.done
    db.commit()
    return {"id": task.id, "done": task.done}


@app.delete("/api/private-tasks/{task_id}")
def delete_private_task(task_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(PrivateTask).filter(PrivateTask.id == task_id).first()
    if task:
        if not _can_access_private_task(db, me, task):
            return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf diese Aufgabe"})
        db.query(PrivateTaskSubitem).filter(PrivateTaskSubitem.task_id == task.id).delete(synchronize_session=False)
        db.query(PrivateTaskAssignee).filter(PrivateTaskAssignee.task_id == task.id).delete(synchronize_session=False)
        db.delete(task)
        db.commit()
    return {"ok": True}


# --- Teilaufgaben der privaten Tasks ---

@app.post("/api/private-tasks/{task_id}/subitems")
def create_private_task_subitem(
    task_id: int, request: Request, payload: PrivateTaskSubitemCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(PrivateTask).filter(PrivateTask.id == task_id).first()
    if not task:
        return JSONResponse(status_code=404, content={"error": "not found"})
    if not _can_access_private_task(db, me, task):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf diese Aufgabe"})

    titel = payload.titel.strip()
    if not titel:
        return JSONResponse(status_code=400, content={"error": "Titel darf nicht leer sein"})
    if len(titel) > 120:
        return JSONResponse(status_code=400, content={"error": "Titel darf maximal 120 Zeichen haben"})

    sub = PrivateTaskSubitem(task_id=task_id, titel=titel)
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return {"id": sub.id, "titel": sub.titel, "done": sub.done}


@app.patch("/api/private-tasks/{task_id}/subitems/{sub_id}/toggle")
def toggle_private_task_subitem(task_id: int, sub_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(PrivateTask).filter(PrivateTask.id == task_id).first()
    if not task or not _can_access_private_task(db, me, task):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf diese Aufgabe"})

    sub = (
        db.query(PrivateTaskSubitem)
        .filter(PrivateTaskSubitem.id == sub_id, PrivateTaskSubitem.task_id == task_id)
        .first()
    )
    if not sub:
        return JSONResponse(status_code=404, content={"error": "not found"})

    sub.done = not sub.done
    db.commit()
    return {"id": sub.id, "done": sub.done}


@app.delete("/api/private-tasks/{task_id}/subitems/{sub_id}")
def delete_private_task_subitem(task_id: int, sub_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    task = db.query(PrivateTask).filter(PrivateTask.id == task_id).first()
    if not task or not _can_access_private_task(db, me, task):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf diese Aufgabe"})

    db.query(PrivateTaskSubitem).filter(
        PrivateTaskSubitem.id == sub_id, PrivateTaskSubitem.task_id == task_id
    ).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


# --- Camp-Plan (Termine, nur Admins legen an) ---

def _require_admin(db: Session, username: str) -> User | None:
    user = db.query(User).filter(User.username == username).first()
    if not user or not user.role or user.role.strip().lower() != "admin":
        return None
    return user


# --- Projekte (Admin-verwaltet: steuert, wer Zugriff auf projekt-getaggte
# Tasks auf der "Tasks"-Seite hat, siehe oben) ---

@app.get("/api/projects")
def list_projects(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    projects = db.query(Project).order_by(Project.name.asc()).all()

    if _is_admin_user(me):
        usernames = {u.id: u.username for u in db.query(User).all()}
        members_by_project: dict[int, list[dict]] = {}
        for a in db.query(ProjectAccess).all():
            members_by_project.setdefault(a.project_id, []).append(
                {"id": a.user_id, "username": usernames.get(a.user_id, "?")}
            )
        return [
            {"id": p.id, "name": p.name, "members": members_by_project.get(p.id, [])} for p in projects
        ]

    my_project_ids = _user_project_ids(db, me.id)
    return [{"id": p.id, "name": p.name} for p in projects if p.id in my_project_ids]


# "Privat" ist kein echtes Projekt, sondern die implizite Bedeutung von
# project_id=NULL (jede:r hat den eigenen privaten Bereich automatisch) — ein
# gleichnamiges Projekt anzulegen wäre verwirrend/doppeldeutig.
def _validate_project_name(name: str, db: Session, exclude_project_id: int | None = None):
    name = name.strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "Name darf nicht leer sein"})
    if len(name) > 60:
        return JSONResponse(status_code=400, content={"error": "Name darf maximal 60 Zeichen haben"})
    if name.strip().lower() == "privat":
        return JSONResponse(
            status_code=400, content={"error": "„Privat“ ist reserviert — jede:r hat das automatisch"}
        )
    existing_q = db.query(Project).filter(Project.name == name)
    if exclude_project_id is not None:
        existing_q = existing_q.filter(Project.id != exclude_project_id)
    if existing_q.first():
        return JSONResponse(status_code=400, content={"error": "Dieses Projekt gibt es schon"})
    return name


@app.post("/api/projects")
def create_project(request: Request, payload: ProjectCreate, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Projekte anlegen"})

    name = _validate_project_name(payload.name, db)
    if isinstance(name, JSONResponse):
        return name

    project = Project(name=name, created_by=username)
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"id": project.id, "name": project.name, "members": []}


@app.patch("/api/projects/{project_id}")
def update_project(project_id: int, request: Request, payload: ProjectUpdate, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Projekte verwalten"})

    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        return JSONResponse(status_code=404, content={"error": "not found"})

    name = _validate_project_name(payload.name, db, exclude_project_id=project_id)
    if isinstance(name, JSONResponse):
        return name

    member_ids = sorted(set(payload.member_ids))
    if member_ids:
        valid_ids = {u.id for u in db.query(User).filter(User.id.in_(member_ids)).all()}
        if not set(member_ids).issubset(valid_ids):
            return JSONResponse(status_code=400, content={"error": "Unbekannte Person ausgewählt"})

    project.name = name
    db.query(ProjectAccess).filter(ProjectAccess.project_id == project.id).delete(synchronize_session=False)
    for uid in member_ids:
        db.add(ProjectAccess(project_id=project.id, user_id=uid))
    db.commit()

    usernames = {u.id: u.username for u in db.query(User).filter(User.id.in_(member_ids)).all()}
    return {
        "id": project.id,
        "name": project.name,
        "members": [{"id": uid, "username": usernames.get(uid, "?")} for uid in member_ids],
    }


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if not _require_admin(db, username):
        return JSONResponse(status_code=403, content={"error": "Nur Admins können Projekte löschen"})

    project = db.query(Project).filter(Project.id == project_id).first()
    if project:
        db.query(ProjectAccess).filter(ProjectAccess.project_id == project.id).delete(synchronize_session=False)
        db.query(PrivateTask).filter(PrivateTask.project_id == project.id).update(
            {PrivateTask.project_id: None}, synchronize_session=False
        )
        db.delete(project)
        db.commit()
    return {"ok": True}


def _validate_plan_payload(payload: PlanEventCreate, db: Session):
    """Validiert Termin-Felder für Anlegen UND Bearbeiten. Gibt entweder ein
    Tupel (datum, datum_ende, uhrzeit, uhrzeit_ende, bezeichnung, location,
    beschreibung, shared_project_id, is_public) oder eine fertige JSONResponse mit
    Fehlermeldung zurück. Datum+Uhrzeit sind Pflicht — datumslose
    "Event-Ideen" gibt es nicht mehr, jeder Termin gehört fest in den Kalender.
    datum_ende ist optional (mehrtägiger Termin, z. B. ein Ausflug); ohne
    Angabe gilt der Termin als eintägig."""
    bezeichnung = payload.bezeichnung.strip()
    if not bezeichnung:
        return JSONResponse(status_code=400, content={"error": "Bezeichnung darf nicht leer sein"})
    if len(bezeichnung) > 60:
        return JSONResponse(status_code=400, content={"error": "Bezeichnung darf maximal 60 Zeichen haben"})

    location = (payload.location or "").strip() or None
    if location and len(location) > 120:
        return JSONResponse(status_code=400, content={"error": "Location darf maximal 120 Zeichen haben"})

    if not payload.datum:
        return JSONResponse(status_code=400, content={"error": "Datum darf nicht leer sein"})
    try:
        event_date = date.fromisoformat(payload.datum)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Ungültiges Datum"})

    event_date_ende = event_date
    if payload.datum_ende:
        try:
            event_date_ende = date.fromisoformat(payload.datum_ende)
        except ValueError:
            return JSONResponse(status_code=400, content={"error": "Ungültiges Bis-Datum"})
        if event_date_ende < event_date:
            return JSONResponse(status_code=400, content={"error": "Bis-Tag darf nicht vor dem Von-Tag liegen"})

    if not payload.uhrzeit:
        return JSONResponse(status_code=400, content={"error": "Uhrzeit darf nicht leer sein"})
    try:
        event_time = dt.strptime(payload.uhrzeit, "%H:%M").time()
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Ungültige Uhrzeit"})

    event_time_ende = None
    if payload.uhrzeit_ende:
        try:
            event_time_ende = dt.strptime(payload.uhrzeit_ende, "%H:%M").time()
        except ValueError:
            return JSONResponse(status_code=400, content={"error": "Ungültige Endzeit"})
        # Die Zeit-Reihenfolge ergibt nur am selben Tag einen Sinn — bei
        # mehrtägigen Terminen darf die Endzeit (am späteren Bis-Tag) auch
        # "vor" der Startzeit liegen, z. B. Start Fr 18:00, Ende So 10:00.
        if event_date_ende == event_date and event_time_ende <= event_time:
            return JSONResponse(status_code=400, content={"error": "Endzeit muss nach der Startzeit liegen"})

    shared_project_id = payload.shared_project_id
    if shared_project_id is not None:
        project = db.query(Project).filter(Project.id == shared_project_id).first()
        if not project:
            return JSONResponse(status_code=400, content={"error": "Projekt nicht gefunden"})

    beschreibung = (payload.beschreibung or "").strip() or None
    return (
        event_date,
        event_date_ende,
        event_time,
        event_time_ende,
        bezeichnung,
        location,
        beschreibung,
        shared_project_id,
        payload.is_public,
    )


def _can_access_plan_event(db: Session, user: User, event: PlanEvent) -> bool:
    """Ein Termin ist standardmäßig nur für die anlegende Person sichtbar —
    erst eine Freigabe für ein Projekt (shared_project_id) oder als öffentlich
    markiert (is_public) zeigt ihn auch anderen. Admins sehen wie überall
    alles, analog zu _can_access_private_task."""
    if event.created_by == user.username or event.is_public or _is_admin_user(user):
        return True
    return bool(event.shared_project_id and event.shared_project_id in _user_project_ids(db, user.id))


def _serialize_plan_event(e: PlanEvent) -> dict:
    return {
        "id": e.id,
        "datum": e.datum.isoformat() if e.datum else None,
        "datum_ende": e.datum_ende.isoformat() if e.datum_ende else None,
        "uhrzeit": e.uhrzeit.strftime("%H:%M") if e.uhrzeit else None,
        "uhrzeit_ende": e.uhrzeit_ende.strftime("%H:%M") if e.uhrzeit_ende else None,
        "bezeichnung": e.bezeichnung,
        "location": e.location,
        "beschreibung": e.beschreibung,
        "shared_project_id": e.shared_project_id,
        "is_public": e.is_public,
        "created_by": e.created_by,
    }


@app.get("/api/plan")
def list_plan_events(request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    me = _user_by_username(db, username)
    if not me:
        return JSONResponse(status_code=404, content={"error": "not found"})

    events = db.query(PlanEvent).order_by(PlanEvent.datum.asc(), PlanEvent.uhrzeit.asc()).all()
    return [_serialize_plan_event(e) for e in events if _can_access_plan_event(db, me, e)]


@app.post("/api/plan")
def create_plan_event(
    request: Request, payload: PlanEventCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    validated = _validate_plan_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    event_date, event_date_ende, event_time, event_time_ende, bezeichnung, location, beschreibung, shared_project_id, is_public = validated

    if not _can_use_private_project(db, me, shared_project_id):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf dieses Projekt"})

    new_event = PlanEvent(
        datum=event_date,
        # eintägig (Ende == Von-Tag) bewusst als NULL gespeichert, nicht als
        # gleiches Datum — hält Alt-Termine und einfache Fälle unverändert.
        datum_ende=event_date_ende if event_date_ende != event_date else None,
        uhrzeit=event_time,
        uhrzeit_ende=event_time_ende,
        bezeichnung=bezeichnung,
        location=location,
        beschreibung=beschreibung,
        shared_project_id=shared_project_id,
        is_public=is_public,
        created_by=username,
    )
    db.add(new_event)
    db.commit()
    db.refresh(new_event)

    return _serialize_plan_event(new_event)


@app.patch("/api/plan/{event_id}")
def update_plan_event(
    event_id: int, request: Request, payload: PlanEventCreate, db: Session = Depends(get_db)
):
    username = get_current_user(request)
    me = _user_by_username(db, username) if username else None
    if not me:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    existing = db.query(PlanEvent).filter(PlanEvent.id == event_id).first()
    if not existing:
        return JSONResponse(status_code=404, content={"error": "not found"})

    # Bearbeiten darf, wer den Termin auch sehen kann — ein privater Termin
    # einer anderen Person bleibt dadurch automatisch geschützt (der Zugriff
    # scheitert schon vorher an _can_access_plan_event).
    if not _can_access_plan_event(db, me, existing):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf diesen Termin"})

    validated = _validate_plan_payload(payload, db)
    if isinstance(validated, JSONResponse):
        return validated
    event_date, event_date_ende, event_time, event_time_ende, bezeichnung, location, beschreibung, shared_project_id, is_public = validated

    if shared_project_id != existing.shared_project_id and not _can_use_private_project(db, me, shared_project_id):
        return JSONResponse(status_code=403, content={"error": "Kein Zugriff auf dieses Projekt"})

    existing.datum = event_date
    existing.datum_ende = event_date_ende if event_date_ende != event_date else None
    existing.uhrzeit = event_time
    existing.uhrzeit_ende = event_time_ende
    existing.bezeichnung = bezeichnung
    existing.location = location
    existing.beschreibung = beschreibung
    existing.shared_project_id = shared_project_id
    existing.is_public = is_public
    db.commit()

    return _serialize_plan_event(existing)


@app.delete("/api/plan/{event_id}")
def delete_plan_event(event_id: int, request: Request, db: Session = Depends(get_db)):
    username = get_current_user(request)
    if not username:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    event = db.query(PlanEvent).filter(PlanEvent.id == event_id).first()
    if event:
        # Löschen dürfen Admins (wie überall) sowie die Person, die den
        # Termin selbst angelegt hat — fremde Termine (auch öffentliche oder
        # projekt-geteilte) darf man weiterhin nur bearbeiten, nicht löschen.
        if event.created_by != username and not _require_admin(db, username):
            return JSONResponse(status_code=403, content={"error": "Nur eigene Termine oder als Admin löschbar"})
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
    db.query(Project).filter(Project.created_by == old_username).update({"created_by": new_username})
    db.query(PrivateTask).filter(PrivateTask.created_by == old_username).update({"created_by": new_username})
    db.query(PlanEvent).filter(PlanEvent.created_by == old_username).update({"created_by": new_username})
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
# Filter/Sortierung auf Tasks & Kosten, …) — bewusst ein generischer
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
            "created_by": r.created_by,
        }
        for r in rows
    ]


@app.get("/api/expenses/log")
def get_expense_log(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

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

    examples = _pairwise_examples(db)
    ledgers = _settlement_ledgers(db)

    return {"pairs": pairs, "netted_pairs": netted_pairs, "merges": merges, "steps": steps, "examples": examples, "ledgers": ledgers}


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
        datum=today_berlin(),
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


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
