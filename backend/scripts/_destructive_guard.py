"""Shared safety gate for the legacy seed scripts that WIPE data tables."""
import sys

from sqlalchemy import inspect
from sqlalchemy.engine import make_url

FLAG = "--i-understand-this-deletes-data"


def confirm_destructive(engine, script: str) -> None:
    url = make_url(str(engine.url))
    host = url.host or url.database or "local"
    if FLAG not in sys.argv:
        print(f"{script} DELETES establishments, WCO records and related data before re-seeding.\n"
              f"For demos use the additive loader instead:  python -m scripts.load_demo_data\n"
              f"To proceed anyway (after a backup) re-run with {FLAG}")
        sys.exit(2)
    answer = input(f"Type the database host ({host}) to confirm wiping its data: ").strip()
    if answer != host:
        print("Confirmation did not match. Nothing was changed.")
        sys.exit(2)
    if "establishments" not in inspect(engine).get_table_names():
        print("Tables are missing — run `alembic upgrade head` first (do not create tables by hand).")
        sys.exit(2)


def seed_password(env_var: str) -> str | None:
    import os
    pw = os.environ.get(env_var)
    if pw and len(pw) >= 12:
        return pw
    if pw:
        print(f"{env_var} is shorter than 12 characters — skipping that account.")
    return None
