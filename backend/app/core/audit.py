from sqlalchemy.orm import Session
from app.models.audit import AuditLog


def log_action(
    db: Session,
    user_email: str,
    user_id: int | None,
    action: str,
    resource_type: str,
    resource_id: int | None = None,
    details: str | None = None,
) -> None:
    db.add(AuditLog(
        user_id=user_id,
        user_email=user_email,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        details=details,
    ))
    # Caller is responsible for committing the session.
