"""Web Push (VAPID) — Abonnements verwalten und Nachrichten verschicken.

Eigenständiges Modul statt in main.py, damit main.py (die FastAPI-Routen)
UND ein CLI-Skript (send_push.py) dieselbe Sende-Logik nutzen können, ohne
sie zu duplizieren.

Die VAPID-Keys liegen als PEM-Dateien neben der App (vapid_private.pem,
vapid_public.pem) — einmalig per generate_vapid_keys() erzeugt, danach nie
mehr neu generieren (bestehende Subscriptions sind an den Public Key
gebunden, ein neues Schlüsselpaar würde sie alle ungültig machen).
"""
import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush
from sqlalchemy.orm import Session

from database import PushSubscription

BASE_DIR = Path(__file__).resolve().parent
VAPID_PRIVATE_KEY_PATH = BASE_DIR / "vapid_private.pem"
VAPID_PUBLIC_KEY_PATH = BASE_DIR / "vapid_public.pem"
# mailto-Kontakt, den Push-Dienste (FCM/APNs-Web-Push-Gateway etc.) im
# Problemfall laut VAPID-Spec kontaktieren dürfen — bei Bedarf auf eine
# echte erreichbare Adresse ändern.
VAPID_CLAIMS_SUB = "mailto:admin@sommercamp.cc"


def generate_vapid_keys() -> None:
    """Einmalig aufrufen (siehe README/Setup), falls noch keine Keys existieren."""
    vapid = Vapid02()
    vapid.generate_keys()
    vapid.save_key(str(VAPID_PRIVATE_KEY_PATH))
    vapid.save_public_key(str(VAPID_PUBLIC_KEY_PATH))


def get_vapid_public_key_b64() -> str:
    """Public Key im base64url-Rohformat (65 Byte, unkomprimierter EC-Punkt) —
    genau das Format, das PushManager.subscribe({applicationServerKey}) im
    Browser erwartet."""
    vapid = Vapid02.from_file(str(VAPID_PRIVATE_KEY_PATH))
    raw = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def save_subscription(db: Session, username: str, subscription: dict) -> None:
    """subscription ist das rohe PushSubscriptionJSON vom Browser:
    {endpoint, keys: {p256dh, auth}}. Ein Endpoint kann sich die Person
    theoretisch neu holen (z. B. nach Browser-Reset) — dann wird die
    bestehende Zeile aktualisiert statt dupliziert."""
    endpoint = subscription["endpoint"]
    keys = subscription["keys"]
    existing = db.query(PushSubscription).filter(PushSubscription.endpoint == endpoint).first()
    if existing:
        existing.username = username
        existing.p256dh = keys["p256dh"]
        existing.auth = keys["auth"]
    else:
        db.add(
            PushSubscription(
                username=username,
                endpoint=endpoint,
                p256dh=keys["p256dh"],
                auth=keys["auth"],
            )
        )
    db.commit()


def remove_subscription(db: Session, endpoint: str) -> None:
    db.query(PushSubscription).filter(PushSubscription.endpoint == endpoint).delete()
    db.commit()


def send_to_all(db: Session, title: str, body: str) -> dict:
    """Schickt an alle gespeicherten Subscriptions, entfernt dabei
    automatisch die, für die der Push-Dienst eine (dauerhaft) ungültige
    Subscription meldet (404/410 — Browser-Deinstallation, abgelaufen o.ä.).
    Gibt eine kleine Zusammenfassung zurück, u. a. fürs CLI-Skript."""
    subs = db.query(PushSubscription).all()
    payload = json.dumps({"title": title, "body": body})
    sent = 0
    removed = 0
    failed = 0
    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=payload,
                vapid_private_key=str(VAPID_PRIVATE_KEY_PATH),
                vapid_claims={"sub": VAPID_CLAIMS_SUB},
            )
            sent += 1
        except WebPushException as e:
            status = e.response.status_code if e.response is not None else None
            if status in (404, 410):
                db.query(PushSubscription).filter(PushSubscription.id == sub.id).delete()
                removed += 1
            else:
                failed += 1
        except Exception:
            # Alles andere (kaputte/inkompatible gespeicherte Keys, Netzwerk-
            # Fehler vorm eigentlichen Request, …) darf nicht den ganzen
            # Versand an alle übrigen Subscriptions abreißen lassen — eine
            # einzelne kaputte Zeile zählt nur als "failed", nicht als
            # "removed" (im Zweifel nicht ungefragt löschen).
            failed += 1
    db.commit()
    return {"sent": sent, "removed": removed, "failed": failed, "total": len(subs)}
