from fastapi import Depends, HTTPException, status, Request, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from .database import SessionLocal, User
from fastapi.responses import RedirectResponse
import secrets

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Session management
SECRET_KEY = secrets.token_urlsafe(32)
session_storage = {}

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

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
def login(request: Request, response: Response, username: str, password: str, db: Session = Depends(get_db)):
    user = authenticate_user(db, username, password)
    if not user:
        return False
    session_token = secrets.token_urlsafe(32)
    session_storage[session_token] = username
    response.set_cookie(key="session_token", value=session_token, httponly=True)
    return True

# Logout
def logout(response: Response):
    response.delete_cookie(key="session_token")

# Check session
def get_current_user(request: Request):
    session_token = request.cookies.get("session_token")
    if not session_token or session_token not in session_storage:
        return None
    return session_storage[session_token]