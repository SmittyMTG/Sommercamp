from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, Date, Time, Numeric, ForeignKey, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from passlib.context import CryptContext
from fastapi import Depends
from datetime import datetime, date

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
    role = Column(String)


# Woher-Tag für Einkaufslisten-Items: erweiterbare Liste aus Farbe + Kurzname
# (z. B. "Rewe", "Aldi", "Bau"), wird direkt beim Anlegen eines Items mit erstellt.
class ShoppingSource(Base):
    __tablename__ = "shopping_sources"
    id = Column(Integer, primary_key=True, index=True)
    farbe = Column(String(20), nullable=False)
    bezeichnung = Column(String(16), nullable=False, unique=True)


# NEU: Einkaufslisten-Eintrag
class ShoppingItem(Base):
    __tablename__ = "shopping_items"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    done = Column(Boolean, default=False)
    added_by = Column(String, nullable=True)
    woher_id = Column(Integer, ForeignKey("shopping_sources.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# Packliste: privat pro User — owner_username entscheidet, wer die Zeile sehen
# und ändern darf. Anders als bei ShoppingItem.added_by (nur Info) ist das hier
# eine echte Zugriffskontrolle.
class PackItem(Base):
    __tablename__ = "pack_items"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    done = Column(Boolean, default=False)
    owner_username = Column(String, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# Camp-Plan-Termin: nur Admins legen Termine an, sichtbar für alle.
class PlanEvent(Base):
    __tablename__ = "plan_events"
    id = Column(Integer, primary_key=True, index=True)
    datum = Column(Date, nullable=False)
    uhrzeit = Column(Time, nullable=False)
    bezeichnung = Column(String(60), nullable=False)
    location = Column(String(120), nullable=True)
    beschreibung = Column(Text, nullable=True)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# Ausgabe: ein Schulden-Eintrag "schuldner_id schuldet glaubiger_id cash Euro"
# (schuldner_id == glaubiger_id ist erlaubt: Eintrag für sich selbst, z. B. eigener
# Snackkauf ohne Beteiligte — zählt fürs Leaderboard, ist aber keine echte Schuld.)
class Ausgabe(Base):
    __tablename__ = "ausgaben"
    id = Column(Integer, primary_key=True, index=True)
    glaubiger_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    schuldner_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    cash = Column(Numeric(10, 2), nullable=False)
    betreff = Column(String(40), nullable=False)
    datum = Column(Date, nullable=False, default=date.today)
    gezahlt = Column(Boolean, nullable=False, default=False)
    # Normale Ausgaben behalten für immer status="offen" (Default) und werden nie
    # angefasst. Nur Tilgungseinträge (Rückzahlungen, erzeugt beim Bestätigen einer
    # offenen Zahlung) durchlaufen "pending" -> "getilgt", sobald der Gläubiger den
    # Empfang bestätigt hat.
    status = Column(String(20), nullable=False, default="offen")
    created_at = Column(DateTime, default=datetime.utcnow)


# Create tables
Base.metadata.create_all(bind=engine)


# create_all legt nur fehlende TABELLEN an, keine fehlenden SPALTEN auf bereits
# bestehenden Tabellen. Diese kleine Selbst-Migration holt neue Spalten nach,
# damit weder hier noch auf dem Server manuell ALTER TABLE gefahren werden muss.
def _ensure_column(table: str, column: str, ddl_type: str, default_sql: str = ""):
    with engine.connect() as conn:
        existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type} {default_sql}")
            conn.commit()


_ensure_column("ausgaben", "gezahlt", "BOOLEAN", "DEFAULT 0")
_ensure_column("ausgaben", "status", "TEXT", "DEFAULT 'offen'")
_ensure_column("shopping_items", "woher_id", "INTEGER")

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Add a test user (run once)
def add_test_user(pUsername, pPassword, pRole):
    db = SessionLocal()
    hashed_password = pwd_context.hash(pPassword)
    db_user = User(username=pUsername, hashed_password=hashed_password, role=pRole)
    db.add(db_user)
    db.commit()
    db.close()
