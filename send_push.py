#!/usr/bin/env python3
"""CLI zum schnellen Verschicken einer Web-Push-Nachricht an alle Abos.

Nutzung:
    venv/bin/python3 send_push.py "Titel" "Nachrichtentext"

Läuft direkt gegen dieselbe DB/Sende-Logik wie /api/push/send (siehe
push.py) — kein HTTP-Umweg, kein Login nötig, da lokal auf dem Server
ausgeführt (Voraussetzung: Shell-Zugriff, den ein Admin ohnehin hat).
"""
import sys

from database import SessionLocal
import push


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Nutzung: {sys.argv[0]} <Titel> <Text>", file=sys.stderr)
        sys.exit(1)

    title, body = sys.argv[1], sys.argv[2]
    db = SessionLocal()
    try:
        result = push.send_to_all(db, title, body)
    finally:
        db.close()

    print(f"Verschickt: {result['sent']}/{result['total']}", end="")
    if result["removed"]:
        print(f", {result['removed']} ungültige Abos entfernt", end="")
    if result["failed"]:
        print(f", {result['failed']} fehlgeschlagen", end="")
    print()


if __name__ == "__main__":
    main()
