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
    from_id: int
    to_id: int


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

    rows = (
        db.query(Ausgabe)
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
            "gezahlt": r.gezahlt,
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

    # Nur offene (unbezahlte) Fremd-Schulden zählen für den Saldo — Einträge, wo
    # man sich selbst als Schuldner eingetragen hat, sind keine echte Schuld.
    open_others = Ausgabe.schuldner_id != Ausgabe.glaubiger_id
    owed_to_me = (
        db.query(func.sum(Ausgabe.cash))
        .filter(Ausgabe.glaubiger_id == me.id, Ausgabe.gezahlt.is_(False), open_others)
        .scalar()
        or 0
    )
    i_owe = (
        db.query(func.sum(Ausgabe.cash))
        .filter(Ausgabe.schuldner_id == me.id, Ausgabe.gezahlt.is_(False), open_others)
        .scalar()
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
            gezahlt=False,
        )
        db.add(row)
        created.append(row)
    db.commit()

    return {"created": len(created), "share": share, "betreff": betreff}


@app.get("/api/expenses/open")
async def get_open_settlements(request: Request, db: Session = Depends(get_db)):
    """
    Fasst alle offenen (unbezahlten) Schulden zu Netto-Salden pro Person zusammen
    und schlägt die minimale Anzahl an Überweisungen vor, um alle auszugleichen
    (klassischer Greedy-Algorithmus: größter Gläubiger tilgt größten Schuldner).
    """
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    rows = (
        db.query(Ausgabe)
        .filter(Ausgabe.gezahlt.is_(False), Ausgabe.schuldner_id != Ausgabe.glaubiger_id)
        .all()
    )
    usernames = {u.id: u.username for u in db.query(User).all()}

    net: dict[int, float] = {}
    for r in rows:
        cash = float(r.cash)
        net[r.glaubiger_id] = net.get(r.glaubiger_id, 0.0) + cash
        net[r.schuldner_id] = net.get(r.schuldner_id, 0.0) - cash

    creditors = sorted(([uid, amt] for uid, amt in net.items() if amt > 0.005), key=lambda x: -x[1])
    debtors = sorted(([uid, -amt] for uid, amt in net.items() if amt < -0.005), key=lambda x: -x[1])

    settlements = []
    i = j = 0
    while i < len(creditors) and j < len(debtors):
        cred_id, cred_amt = creditors[i]
        deb_id, deb_amt = debtors[j]
        amount = round(min(cred_amt, deb_amt), 2)
        if amount > 0.005:
            settlements.append(
                {
                    "from_id": deb_id,
                    "from": usernames.get(deb_id, "?"),
                    "to_id": cred_id,
                    "to": usernames.get(cred_id, "?"),
                    "amount": amount,
                }
            )
        creditors[i][1] -= amount
        debtors[j][1] -= amount
        if creditors[i][1] <= 0.005:
            i += 1
        if debtors[j][1] <= 0.005:
            j += 1

    return settlements


@app.post("/api/expenses/settle")
async def settle_expenses(
    request: Request, payload: SettleRequest, db: Session = Depends(get_db)
):
    """
    Markiert alle offenen Einträge zwischen zwei Personen (in beide Richtungen)
    als bezahlt. Die Vorschläge aus /api/expenses/open sind bereits Netto-Salden,
    daher gleicht eine bestätigte Zahlung die komplette Historie der beiden aus.
    """
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    updated = (
        db.query(Ausgabe)
        .filter(
            Ausgabe.gezahlt.is_(False),
            or_(
                and_(Ausgabe.glaubiger_id == payload.to_id, Ausgabe.schuldner_id == payload.from_id),
                and_(Ausgabe.glaubiger_id == payload.from_id, Ausgabe.schuldner_id == payload.to_id),
            ),
        )
        .update({"gezahlt": True}, synchronize_session=False)
    )
    db.commit()
    return {"updated": updated}


@app.get("/api/expenses/leaderboard")
async def get_expense_leaderboard(request: Request, db: Session = Depends(get_db)):
    if not get_current_user(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    totals = dict(
        db.query(Ausgabe.schuldner_id, func.sum(Ausgabe.cash))
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
