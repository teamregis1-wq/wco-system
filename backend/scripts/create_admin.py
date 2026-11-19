"""Create an admin account, or reset an existing account's password / promote it.

    cd backend
    ./venv/bin/python -m scripts.create_admin --email you@example.com --name "Your Name"

The password is read with a hidden prompt (or from the ADMIN_PASSWORD
environment variable for non-interactive use) and is never printed. Use this
on a new Supabase project, or to rotate the old development password.
"""
import argparse
import getpass
import os
import sys

from sqlalchemy import func, select

from app.core.audit import log_action
from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models import User


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--email", required=True)
    ap.add_argument("--name", default="Administrator")
    ap.add_argument("--role", default="admin", choices=["admin", "researcher", "viewer"])
    args = ap.parse_args(argv)

    password = os.environ.get("ADMIN_PASSWORD")
    if not password:
        password = getpass.getpass("New password (min 12 characters): ")
        if password != getpass.getpass("Repeat password: "):
            print("Passwords do not match.")
            return 1
    if len(password) < 12:
        print("Use at least 12 characters.")
        return 1

    email = args.email.strip().lower()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(func.lower(User.email) == email))
        if user is None:
            user = User(email=email, full_name=args.name, role=args.role,
                        hashed_password=hash_password(password))
            db.add(user)
            action = "created"
        else:
            user.hashed_password = hash_password(password)
            user.role = args.role
            action = "updated (password reset, role set)"
        db.flush()
        log_action(db, "scripts/create_admin", None, "update", "user", user.id,
                   details=f"{email} {action} as {args.role}")
        db.commit()
    print(f"{email} {action} as {args.role}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
