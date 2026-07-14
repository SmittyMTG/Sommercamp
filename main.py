from fastapi import FastAPI, Request, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from database import SessionLocal, User
from auth import login, logout, get_current_user
import uvicorn

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

templates = Jinja2Templates(directory="templates")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


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


@app.get("/calculator", response_class=HTMLResponse)
async def calculator(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse("calculator.html", {"request": request, "user": user})


@app.post("/calculate")
async def calculate(
    request: Request,
    num1: float = Form(...),
    num2: float = Form(...),
    operation: str = Form(...),
):
    if operation == "add":
        result = num1 + num2
    elif operation == "subtract":
        result = num1 - num2
    elif operation == "multiply":
        result = num1 * num2
    elif operation == "divide":
        result = num1 / num2 if num2 != 0 else "Error: Division by zero"
    else:
        result = "Invalid operation"

    return HTMLResponse(f"<div>{result}</div>")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
