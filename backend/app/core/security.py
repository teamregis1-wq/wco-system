"""Authentication helpers: password hashing and JWT tokens.

Passwords are hashed with bcrypt (never stored in plaintext). Tokens are
signed JWTs carrying the user id, role and a fingerprint of the password they
were issued under; changing or resetting a password therefore ends every
existing session. The get_current_user dependency decodes the token on
protected routes.
"""
import hashlib
import hmac
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# tokenUrl must match the login route path so the Swagger "Authorize" button works.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.api_v1_prefix}/auth/login")


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def password_fingerprint(hashed_password: str) -> str:
    """Keyed digest of the stored hash (reveals nothing about the password).

    Embedded in every token; when the password changes, the fingerprint no
    longer matches and tokens issued before the change are rejected.
    """
    return hmac.new(settings.jwt_secret.encode(), hashed_password.encode(),
                    hashlib.sha256).hexdigest()[:16]


def create_access_token(*, user_id: int, role: str, hashed_password: str) -> str:
    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=settings.access_token_expire_minutes)
    # "role" is informational for the client only; authorization always uses
    # the role stored in the database (see get_current_user / require_role).
    payload = {"sub": str(user_id), "role": role, "iat": now, "exp": expire,
               "pwv": password_fingerprint(hashed_password)}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """Decode the JWT and return the matching User. Raises 401 if invalid."""
    # Imported here to avoid a circular import (models import database, not security).
    from app.models.user import User

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
        user_id = int(payload.get("sub"))
    except (JWTError, TypeError, ValueError):
        raise credentials_exception

    user = db.get(User, user_id)
    if user is None:
        raise credentials_exception
    if not hmac.compare_digest(str(payload.get("pwv", "")),
                               password_fingerprint(user.hashed_password)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your session has ended because the password was changed. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_role(*allowed_roles: str):
    """Dependency factory: restrict a route to specific roles.

    Usage:  @router.post(..., dependencies=[Depends(require_role("admin"))])
    """
    def checker(current_user=Depends(get_current_user)):
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        return current_user

    return checker
