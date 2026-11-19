"""Authentication routes: register, login, user management (admin)."""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy import select, func, desc
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.database import get_db
from app.core.security import (
    create_access_token, get_current_user, require_role,
    hash_password, verify_password,
)
from app.models.audit import AuditLog
from app.models.user import User
from app.models.establishment import Establishment
from app.models.wco import WCOGenerationRecord
from app.core.config import settings
from app.schemas.schemas import (
    AdminUserCreate, AuditLogOut, RoleLiteral, Token, UserCreate, UserOut,
)

router = APIRouter(prefix="/auth", tags=["auth"])


class RoleUpdate(BaseModel):
    role: RoleLiteral


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


def _find_user_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))


def _create_user(db: Session, email: str, full_name: str, password: str, role: str) -> User:
    if _find_user_by_email(db, email):
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(
        email=email.strip().lower(),
        full_name=full_name.strip(),
        hashed_password=hash_password(password),
        role=role,
    )
    db.add(user)
    return user


@router.post("/register", response_model=UserOut, status_code=201)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    """Public self-registration. Always creates a **viewer** account.

    Earlier versions trusted a client-supplied ``role``, which let anyone
    register as ``admin``. Privileged accounts are now created only by an
    admin through ``POST /auth/users``.
    """
    if not settings.allow_public_registration:
        raise HTTPException(status_code=403, detail="Self-registration is disabled. Ask an administrator for an account.")
    if payload.role != "viewer":
        raise HTTPException(
            status_code=403,
            detail="Public registration can only create viewer accounts. An admin can change roles later.",
        )
    user = _create_user(db, payload.email, payload.full_name, payload.password, "viewer")
    db.commit()
    db.refresh(user)
    return user


@router.post("/users", response_model=UserOut, status_code=201)
def admin_create_user(
    payload: AdminUserCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """Admin-only: create a user with any role."""
    user = _create_user(db, payload.email, payload.full_name, payload.password, payload.role)
    db.flush()
    log_action(db, current_user.email, current_user.id, "create", "user",
               user.id, details=f"{user.email} ({payload.role})")
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=Token)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = _find_user_by_email(db, form.username)
    if not user or not verify_password(form.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Incorrect email or password")
    # Include the user so the frontend doesn't need a follow-up /auth/me call.
    return Token(
        access_token=create_access_token(user_id=user.id, role=user.role),
        user=user,
    )


@router.get("/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)):
    return current_user


@router.patch("/me/password")
def change_password(
    payload: PasswordChange,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not verify_password(payload.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    current_user.hashed_password = hash_password(payload.new_password)
    db.commit()
    return {"message": "Password updated successfully."}


# ── Admin-only user management ─────────────────────────────────────────────────

@router.get("/users", response_model=list[UserOut],
            dependencies=[Depends(require_role("admin"))])
def list_users(db: Session = Depends(get_db)):
    return db.scalars(select(User).order_by(User.created_at)).all()


@router.patch("/users/{user_id}/role", response_model=UserOut)
def update_role(
    user_id: int,
    payload: RoleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot change your own role.")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    old_role = user.role
    user.role = payload.role
    log_action(db, current_user.email, current_user.id, "update", "user",
               user_id, details=f"role {old_role} → {payload.role} for {user.email}")
    db.commit()
    db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account.")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    log_action(db, current_user.email, current_user.id, "delete", "user",
               user_id, details=user.email)
    db.delete(user)
    db.commit()


@router.get("/system-stats", dependencies=[Depends(require_role("admin"))])
def system_stats(db: Session = Depends(get_db)):
    return {
        "total_users":           db.scalar(select(func.count(User.id))),
        "total_establishments":  db.scalar(select(func.count(Establishment.id))),
        "active_establishments": db.scalar(select(func.count(Establishment.id)).where(Establishment.is_active.is_(True))),
        "total_wco_records":     db.scalar(select(func.count(WCOGenerationRecord.id))),
        "total_wco_liters":      round(db.scalar(select(func.sum(WCOGenerationRecord.quantity_liters))) or 0, 1),
    }


@router.get("/audit-logs", response_model=list[AuditLogOut],
            dependencies=[Depends(require_role("admin"))])
def list_audit_logs(
    resource_type: str | None = Query(None),
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
):
    stmt = select(AuditLog).order_by(desc(AuditLog.created_at)).limit(limit)
    if resource_type:
        stmt = stmt.where(AuditLog.resource_type == resource_type)
    return db.scalars(stmt).all()
