from sqlalchemy import create_engine, Column, Integer, String
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from passlib.context import CryptContext

# SQLite DB
DATABASE_URL = "sqlite:///./users.db"
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# User model
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)

# Create tables
Base.metadata.create_all(bind=engine)

# Add a test user (run once)
def add_test_user():
    db = SessionLocal()
    hashed_password = pwd_context.hash("password123")
    db_user = User(username="admin", hashed_password=hashed_password)
    db.add(db_user)
    db.commit()
    db.close()

# Uncomment to create a test user:
# add_test_user()