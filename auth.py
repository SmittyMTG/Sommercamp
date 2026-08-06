from fastapi import Depends, HTTPException, status, Request, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from database import SessionLocal, User, UserSession
from fastapi.responses import RedirectResponse
import secrets

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Sessions werden nicht mehr im Prozessspeicher gehalten, sondern in der DB
# (siehe UserSession) — dadurch bleibt man auch über einen Server-Neustart
# hinweg eingeloggt, ein Gerät muss sich also wirklich nur einmal anmelden.
SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 60  # 60 Tage

# Verify password
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

# Get user by username
def get_user(db: Session, username: str):
    return db.query(User).filter(User.username == username).first()

# Authenticate user
def authenticate_user(db: Session, username: str, password: str):
    user = get_user(db, username)
    if not user or not verify_password(password, user.hashed_password):
        return False
    return user

# Login
def login(request: Request, response: Response, username: str, password: str, db: Session):
    user = authenticate_user(db, username, password)
    if not user:
        return False
    session_token = secrets.token_urlsafe(32)
    db.add(UserSession(token=session_token, username=username))
    db.commit()
    response.set_cookie(
        key="session_token",
        value=session_token,
        httponly=True,
        max_age=SESSION_COOKIE_MAX_AGE,
        samesite="lax",
    )
    return True

# Logout
def logout(request: Request, response: Response):
    session_token = request.cookies.get("session_token")
    if session_token:
        db = SessionLocal()
        try:
            db.query(UserSession).filter(UserSession.token == session_token).delete()
            db.commit()
        finally:
            db.close()
    response.delete_cookie(key="session_token")

# Check session
def get_current_user(request: Request):
    session_token = request.cookies.get("session_token")
    if not session_token:
        return None
    db = SessionLocal()
    try:
        row = db.query(UserSession).filter(UserSession.token == session_token).first()
        return row.username if row else None
    finally:
        db.close()
