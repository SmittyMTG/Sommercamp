from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, Date, Time, Numeric, ForeignKey, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from passlib.context import CryptContext
from fastapi import Depends
from datetime import datetime, date
from zoneinfo import ZoneInfo
import re
import uuid

# Server läuft in UTC, Nutzer:innen sind in Deutschland — date.today() liefert
# rund um Mitternacht das falsche Datum (siehe today_berlin() in main.py).
BERLIN_TZ = ZoneInfo("Europe/Berlin")


def _today_berlin() -> date:
    return datetime.now(BERLIN_TZ).date()

# SQLite DB
# check_same_thread=False: Routen laufen als normale (sync) Handler in Starlettes
# Threadpool, nicht mehr alle im einen Event-Loop-Thread — ohne dieses Flag
# wirft sqlite3, sobald eine gepoolte Connection in einem anderen Thread als
# ihrem Erstellungs-Thread wiederverwendet wird. Der SQLAlchemy-Pool serialisiert
# den Zugriff pro Connection ohnehin (nie zwei Threads gleichzeitig), das ist der
# offiziell empfohlene Weg für SQLite + FastAPI-Threadpool.
# pool_size/max_overflow angehoben (Standard 5+10=15 war zu knapp fürs
# Sekunden-Polling mehrerer gleichzeitiger Nutzer, siehe QueuePool-Timeouts im Log).
DATABASE_URL = "sqlite:///./users.db"
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    pool_size=20,
    max_overflow=20,
)
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
    # Profilbild: relativer /static-Pfad inkl. Cache-Busting-Query, NULL solange
    # kein Bild hochgeladen wurde (siehe POST /api/me/avatar in main.py).
    avatar_path = Column(String, nullable=True)
    # Feste Namensfarbe (Hex), überall im UI verwendet, wo der Username auftaucht
    # (Namens-Tag, Kachel-Rand, Geldfluss-Diagramm, Profil-Button-Rand). Admin-
    # verwaltbar (siehe PATCH /api/users/{id}/color); neue User bekommen beim
    # Anlegen automatisch eine Farbe aus einer festen Palette zugewiesen.
    color = Column(String(7), nullable=True)
    # Frei formbarer JSON-Blob für UI-Zustand, der pro User über Geräte hinweg
    # erhalten bleiben soll (zuletzt offener Screen/Scroll, aktive Filter/
    # Sortierung auf Tasks & Kosten, …) — siehe GET/PATCH /api/me/ui-state in
    # main.py. Bewusst ein einziges Blob-Feld statt einzelner Spalten pro
    # Einstellung, damit neue UI-Zustände ohne Migration dazukommen können.
    ui_state = Column(Text, nullable=True)


# Sessions in der DB statt nur im Prozessspeicher (siehe auth.py) — sonst wirft
# jeder Server-Neustart (Deploy, Crash) ALLE eingeloggten Geräte gleichzeitig
# raus, weil ein reines In-Memory-Dict den Neustart nicht übersteht.
class UserSession(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True, index=True)
    token = Column(String(64), unique=True, nullable=False, index=True)
    username = Column(String, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# Web-Push-Abonnement eines Browsers/Geräts (siehe push.py). endpoint ist pro
# Browser-Installation eindeutig (daher unique) — meldet sich dieselbe
# Person erneut an (z. B. nach Cache-Reset), wird die Zeile aktualisiert
# statt dupliziert. username ist rein informativ (wer hat's aktiviert),
# /api/push/send schickt bewusst an ALLE gespeicherten Abos.
class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, nullable=True, index=True)
    endpoint = Column(Text, nullable=False, unique=True)
    p256dh = Column(String, nullable=False)
    auth = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


# Kategorie-Tag für Aufgaben (z. B. "Einkauf", "Aufbau") — erweiterbare Liste
# aus Farbe + Kurzname, direkt beim Anlegen einer Aufgabe mit erstellbar.
class TaskCategory(Base):
    __tablename__ = "task_categories"
    id = Column(Integer, primary_key=True, index=True)
    farbe = Column(String(20), nullable=False)
    bezeichnung = Column(String(16), nullable=False, unique=True)


# Projekt-Tag für die private "Tasks"-Seite (main.py: /api/private-tasks): eine
# Aufgabe ohne project_id gilt als "privat" (nur für created_by sichtbar), mit
# project_id als geteilt mit allen Usern, die eine ProjectAccess-Zeile dafür
# haben. Admin-verwaltbar (anlegen + Mitglieder pflegen), s. /api/projects.
class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(60), nullable=False, unique=True)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class ProjectAccess(Base):
    __tablename__ = "project_access"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)


# Private Tasks-Seite (main.py: /api/private-tasks): Sichtbarkeit läuft über
# created_by ("privat") bzw. Projekt-Mitgliedschaft (project_id).
class PrivateTask(Base):
    __tablename__ = "private_tasks"
    id = Column(Integer, primary_key=True, index=True)
    titel = Column(String(80), nullable=False)
    beschreibung = Column(Text, nullable=True)
    done = Column(Boolean, nullable=False, default=False)
    deadline = Column(DateTime, nullable=True)
    category_id = Column(Integer, ForeignKey("task_categories.id"), nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    # Gegenteil von "privat": für ALLE sichtbar, unabhängig von Projekt-
    # Mitgliedschaft (siehe _can_access_private_task in main.py).
    is_public = Column(Boolean, nullable=False, default=False)
    created_by = Column(String, nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# Verantwortliche einer privaten Task — mehrere Personen möglich.
class PrivateTaskAssignee(Base):
    __tablename__ = "private_task_assignees"
    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("private_tasks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)


class PrivateTaskSubitem(Base):
    __tablename__ = "private_task_subitems"
    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("private_tasks.id"), nullable=False, index=True)
    titel = Column(String(120), nullable=False)
    done = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


# Camp-Plan-Termin: nur Admins legen Termine an. Standardmäßig nur für die
# anlegende Person selbst sichtbar — erst durch Freigabe für ein Projekt
# (shared_project_id) sehen auch dessen Mitglieder den Termin (siehe
# _can_access_plan_event in main.py, analog zu _can_access_private_task).
class PlanEvent(Base):
    __tablename__ = "plan_events"
    id = Column(Integer, primary_key=True, index=True)
    # Optional: ohne Datum ist der Termin "noch offen" (siehe Panel im Camp-Plan)
    # und wird erst per Schnellaktion/Bearbeiten fest auf einen Tag gelegt.
    datum = Column(Date, nullable=True)
    # Optionales Ende eines mehrtägigen Termins (z. B. ein Ausflug über 3 Tage)
    # — NULL heißt eintägig (Ende = datum). Muss main.py zufolge >= datum sein.
    datum_ende = Column(Date, nullable=True)
    # Ohne Datum ergibt eine Uhrzeit keinen Sinn — daher ebenfalls optional,
    # serverseitig erzwungen: nur zusammen mit datum gesetzt (main.py).
    uhrzeit = Column(Time, nullable=True)
    # Ende der Uhrzeitspanne, optional — ohne Angabe ist der Termin nur ein
    # Zeitpunkt ohne Dauer (main.py erzwingt uhrzeit_ende > uhrzeit, falls gesetzt).
    uhrzeit_ende = Column(Time, nullable=True)
    bezeichnung = Column(String(60), nullable=False)
    location = Column(String(120), nullable=True)
    beschreibung = Column(Text, nullable=True)
    # Projekt, für das dieser Termin freigegeben wurde — NULL heißt "nur für
    # created_by sichtbar" (siehe _can_access_plan_event in main.py).
    shared_project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    # Gegenteil von "privat": für ALLE sichtbar, unabhängig von Projekt-
    # Mitgliedschaft (siehe _can_access_plan_event in main.py).
    is_public = Column(Boolean, nullable=False, default=False)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# Ausgabe: ein Schulden-Eintrag "schuldner_id schuldet glaubiger_id cash Euro"
# (schuldner_id == glaubiger_id ist erlaubt: Eintrag für sich selbst, z. B. eigener
# Snackkauf ohne Beteiligte — ist aber keine echte Schuld.)
class Ausgabe(Base):
    __tablename__ = "ausgaben"
    id = Column(Integer, primary_key=True, index=True)
    # index=True: glaubiger_id/schuldner_id/status/datum werden bei jedem 3-Sekunden
    # Kosten-Poll gefiltert bzw. gruppiert (list_expenses, get_expense_balance u.a.)
    # — ohne Index wäre das ab wachsender Ausgaben-Historie ein Full-Table-Scan pro Poll.
    glaubiger_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    schuldner_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    cash = Column(Numeric(10, 2), nullable=False)
    betreff = Column(String(40), nullable=False)
    datum = Column(Date, nullable=False, default=_today_berlin, index=True)
    gezahlt = Column(Boolean, nullable=False, default=False)
    # Normale Ausgaben behalten für immer status="offen" (Default) und werden nie
    # angefasst. Nur Tilgungseinträge (Rückzahlungen, erzeugt beim Bestätigen einer
    # offenen Zahlung) durchlaufen "pending" -> "getilgt", sobald der Gläubiger den
    # Empfang bestätigt hat.
    status = Column(String(20), nullable=False, default="offen", index=True)
    # Verbindet alle Zeilen, die in einem einzigen "Ausgabe hinzufügen"-Vorgang
    # entstanden sind (ein Eintrag pro betroffener Person). Ermöglicht Bearbeiten/
    # Löschen der ganzen Ausgabe statt nur einer einzelnen Schuldner-Zeile.
    batch_id = Column(String(36), nullable=True, index=True)
    # True, wenn der Betrag beim Anlegen/Bearbeiten explizit fest eingetragen wurde;
    # False, wenn er sich aus der Gleichverteilung des Rests ("auto") ergab. Steuert,
    # ob das Bearbeiten-Formular den Betrag vorausfüllt (fest) oder leer lässt, damit
    # er bei jeder Bearbeitung neu aufgeteilt wird (auto).
    fixed = Column(Boolean, nullable=False, default=True)
    # Wer die Ausgabe ursprünglich angelegt hat — bestimmt, wer sie später
    # bearbeiten/löschen darf (neben Admins). NULL bei Alt-Ausgaben von vor
    # Einführung dieses Felds; die bleiben bewusst nur admin-verwaltbar, da der
    # echte Ersteller nicht mehr rekonstruierbar ist. Bleibt beim Bearbeiten
    # unverändert (auch wenn ein Admin die Ausgabe einer anderen Person editiert).
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# Aktivitäts-Log: EIN Eintrag pro Aktion, mit auslösendem UND betroffenem
# Account getrennt (z. B. "Person B schließt eine Aufgabe von Person A" ->
# actor=B, affected=A). affected_username ist NULL, wenn niemand konkret
# betroffen ist (z. B. eine Aufgabe ohne Zuweisung wird angelegt).
class ActivityLog(Base):
    __tablename__ = "activity_log"
    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    actor_username = Column(String, nullable=False, index=True)
    affected_username = Column(String, nullable=True, index=True)
    action = Column(String(40), nullable=False)
    message = Column(String(200), nullable=False)


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
_ensure_column("ausgaben", "batch_id", "TEXT")
_ensure_column("ausgaben", "fixed", "BOOLEAN", "DEFAULT 1")
_ensure_column("ausgaben", "created_by", "TEXT")
_ensure_column("users", "avatar_path", "TEXT")
_ensure_column("users", "color", "TEXT")
_ensure_column("users", "ui_state", "TEXT")
_ensure_column("plan_events", "uhrzeit_ende", "TIME")
_ensure_column("plan_events", "shared_project_id", "INTEGER")
_ensure_column("plan_events", "datum_ende", "DATE")
_ensure_column("plan_events", "is_public", "BOOLEAN", "DEFAULT 0")
_ensure_column("private_tasks", "is_public", "BOOLEAN", "DEFAULT 0")


# Analoge Selbst-Migration für Indizes: index=True auf einer Column wirkt nur bei
# create_all für neue Tabellen, holt auf bereits bestehenden Tabellen (wie oben bei
# _ensure_column) nichts nach. CREATE INDEX IF NOT EXISTS ist gefahrlos erneut
# ausführbar, daher kein Existenz-Check nötig.
def _ensure_index(name: str, table: str, column: str):
    with engine.connect() as conn:
        conn.exec_driver_sql(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({column})")
        conn.commit()


_ensure_index("ix_ausgaben_glaubiger_id", "ausgaben", "glaubiger_id")
_ensure_index("ix_ausgaben_schuldner_id", "ausgaben", "schuldner_id")
_ensure_index("ix_ausgaben_status", "ausgaben", "status")
_ensure_index("ix_ausgaben_datum", "ausgaben", "datum")


def _relax_plan_events_not_null():
    """plan_events.datum und .uhrzeit waren ursprünglich NOT NULL; seit "noch
    offene" (datums-/uhrzeitlose) Termine möglich sind, müssen beide Spalten
    NULL erlauben. SQLite kennt kein ALTER COLUMN für Constraints, daher wird
    die Tabelle bei Bedarf einmalig neu aufgebaut (Rename, Neuanlage mit
    lockerem Schema, Daten kopieren, alte Tabelle löschen). Läuft nur, wenn
    noch mindestens eine der beiden Spalten NOT NULL ist, ist also bei jedem
    weiteren Start ein No-Op.
    """
    with engine.connect() as conn:
        info = conn.exec_driver_sql("PRAGMA table_info(plan_events)").fetchall()
        by_name = {row[1]: row for row in info}
        still_not_null = any(by_name[c][3] == 1 for c in ("datum", "uhrzeit") if c in by_name)
        if not still_not_null:
            return

        conn.exec_driver_sql("ALTER TABLE plan_events RENAME TO plan_events_old")
        conn.exec_driver_sql(
            """
            CREATE TABLE plan_events (
                id INTEGER PRIMARY KEY,
                datum DATE,
                uhrzeit TIME,
                bezeichnung VARCHAR(60) NOT NULL,
                location VARCHAR(120),
                beschreibung TEXT,
                created_by VARCHAR,
                created_at DATETIME
            )
            """
        )
        conn.exec_driver_sql(
            "INSERT INTO plan_events (id, datum, uhrzeit, bezeichnung, location, beschreibung, "
            "created_by, created_at) "
            "SELECT id, datum, uhrzeit, bezeichnung, location, beschreibung, created_by, created_at "
            "FROM plan_events_old"
        )
        conn.exec_driver_sql("DROP TABLE plan_events_old")
        conn.commit()


_relax_plan_events_not_null()


def _backfill_expense_batch_ids():
    """Einmaliger Nachtrag für Ausgaben, die vor Einführung von batch_id angelegt
    wurden: gruppiert anhand (glaubiger_id, datum, betreff) — exakt so, wie sie
    beim Anlegen ursprünglich zusammengehörten — und vergibt je Gruppe eine
    gemeinsame batch_id. Läuft nur für Zeilen mit batch_id IS NULL, ist also bei
    jedem Start ungefährlich erneut ausführbar (No-Op nach dem ersten Mal).
    """
    db = SessionLocal()
    try:
        rows = (
            db.query(Ausgabe)
            .filter(Ausgabe.batch_id.is_(None), Ausgabe.status == "offen")
            .all()
        )
        groups = {}
        for r in rows:
            groups.setdefault((r.glaubiger_id, r.datum, r.betreff), []).append(r)
        for group_rows in groups.values():
            batch_id = uuid.uuid4().hex
            for r in group_rows:
                r.batch_id = batch_id
        if groups:
            db.commit()
    finally:
        db.close()


_backfill_expense_batch_ids()


def _backfill_expense_log_messages():
    """Einmaliger Nachtrag für "expense_created"-Logeinträge von vor dem Fix, der
    die betroffene Person namentlich statt mit dem nichtssagenden "für dich"
    nennt (create_expense in main.py) — bei aufgeteilten Ausgaben sahen sonst
    mehrere Log-Zeilen identisch aus. affected_username trägt die betroffene
    Person schon korrekt (nur der Freitext war falsch), außer bei einer
    Eigenausgabe (Zahler == Beteiligter): dort ist affected_username laut
    log_action() bewusst NULL, die betroffene Person war dann aber immer der
    Zahler selbst (actor_username). Läuft nur für Zeilen mit dem alten
    Nachrichten-Suffix, ist also bei jedem Start ungefährlich erneut ausführbar
    (No-Op nach dem ersten Mal).
    """
    db = SessionLocal()
    try:
        old_suffix = " für dich bezahlt"
        rows = (
            db.query(ActivityLog)
            .filter(ActivityLog.action == "expense_created", ActivityLog.message.like(f"%{old_suffix}"))
            .all()
        )
        for r in rows:
            beneficiary_name = r.affected_username or r.actor_username
            r.message = r.message[: -len(old_suffix)] + f" für {beneficiary_name} bezahlt"
        if rows:
            db.commit()
    finally:
        db.close()


_backfill_expense_log_messages()


def _consolidate_expense_created_logs():
    """Frühere expense_created-Einträge hatten einen Eintrag PRO beteiligter
    Person mit deren Anteil (z. B. "X hat 5,00 € für „Kino“ für Y bezahlt") —
    seit dem Wechsel auf einen Gesamtbetrags-Eintrag pro Ausgabe (siehe
    create_expense in main.py) sehen alte Einträge dadurch anders aus als
    neue. Fasst Gruppen von Alt-Einträgen (gleicher Zahler + Betreff,
    innerhalb weniger Sekunden entstanden — sie stammen aus derselben
    Anfrage, ein Eintrag je beteiligter Person) zu einem einzigen Eintrag mit
    der Summe zusammen. Der Regex matcht nur das alte "... für NAME bezahlt"-
    Format, neue Gesamtbetrags-Einträge ("... bezahlt" ohne "für NAME" davor)
    bleiben unangetastet — läuft also bei jedem Start ungefährlich erneut
    aus (No-Op nach dem ersten Mal, sobald keine Alt-Einträge mehr übrig sind).
    """
    db = SessionLocal()
    try:
        rows = (
            db.query(ActivityLog)
            .filter(ActivityLog.action == "expense_created")
            .order_by(ActivityLog.id.asc())
            .all()
        )
        pattern = re.compile(r"^(.+?) hat ([\d.,]+) € für „(.+)“ für .+ bezahlt$")

        groups = []
        current = None
        for r in rows:
            m = pattern.match(r.message)
            if not m:
                current = None
                continue
            actor, amount_str, betreff = m.group(1), m.group(2), m.group(3)
            amount = float(amount_str.replace(".", "").replace(",", "."))
            if (
                current
                and current["actor"] == actor
                and current["betreff"] == betreff
                and (r.created_at - current["last_time"]).total_seconds() <= 5
            ):
                current["rows"].append(r)
                current["total"] += amount
                current["last_time"] = r.created_at
            else:
                current = {"actor": actor, "betreff": betreff, "total": amount, "rows": [r], "last_time": r.created_at}
                groups.append(current)

        changed = False
        for g in groups:
            # Auch Gruppen mit nur einer Zeile (Ausgabe mit nur einer
            # beteiligten Person) müssen umgeschrieben werden — sonst bleibt
            # bei denen das alte "... für NAME bezahlt"-Format stehen, weil
            # es ja nichts zum Zusammenfassen gibt.
            keep = g["rows"][0]
            total_str = f"{g['total']:.2f} €".replace(".", ",")
            keep.message = f"{g['actor']} hat {total_str} für „{g['betreff']}“ bezahlt"
            for extra in g["rows"][1:]:
                db.delete(extra)
            changed = True
        if changed:
            db.commit()
    finally:
        db.close()


_consolidate_expense_created_logs()

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
    try:
        hashed_password = pwd_context.hash(pPassword)
        db_user = User(username=pUsername, hashed_password=hashed_password, role=pRole)
        db.add(db_user)
        db.commit()
    finally:
        db.close()
