from pathlib import Path

from fastapi import FastAPI, Request, Depends, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import SessionLocal, User, ShoppingItem, get_db
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


# --- Live-Updates Einkaufsliste ---
class ShoppingConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active:
            self.active.remove(websocket)

    async def broadcast(self, message: dict):
        dead = []
        for connection in self.active:
            try:
                await connection.send_json(message)
            except Exception:
                dead.append(connection)
        for connection in dead:
            self.disconnect(connection)


shopping_manager = ShoppingConnectionManager()


@app.websocket("/ws/shopping")
async def shopping_ws(websocket: WebSocket):
    user = get_current_user(websocket)
    if not user:
        await websocket.close(code=1008)
        return

    await shopping_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        shopping_manager.disconnect(websocket)


# --- Schemas ---
class ShoppingItemCreate(BaseModel):
    name: str


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

    payload = {
        "id": new_item.id,
        "name": new_item.name,
        "done": new_item.done,
        "added_by": new_item.added_by,
    }
    await shopping_manager.broadcast({"type": "created", "item": payload})
    return payload


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
    payload = {"id": item.id, "done": item.done}
    await shopping_manager.broadcast({"type": "toggled", "item": payload})
    return payload


@app.delete("/api/shopping/{item_id}")
async def delete_shopping_item(item_id: int, request: Request, db: Session = Depends(get_db)):
    user = get_current_user(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    item = db.query(ShoppingItem).filter(ShoppingItem.id == item_id).first()
    if item:
        db.delete(item)
        db.commit()
        await shopping_manager.broadcast({"type": "deleted", "item": {"id": item_id}})
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
