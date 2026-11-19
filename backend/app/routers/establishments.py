from fastapi import APIRouter, Depends, HTTPException, Query
from geoalchemy2.functions import ST_SetSRID, ST_MakePoint
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.cache import invalidate_gis_cache
from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_user, require_role
from app.models.establishment import Establishment
from app.schemas.schemas import (
    EstablishmentCreate, EstablishmentOut, EstablishmentUpdate, _check_study_area,
)
from app.services.retraining import notify_training_data_changed

router = APIRouter(prefix="/establishments", tags=["establishments"])

MAX_BULK_ESTABLISHMENTS = 5_000


def _new_establishment(payload: EstablishmentCreate) -> Establishment:
    data = payload.model_dump()
    data["data_source"] = data["data_source"] or settings.default_data_source
    estab = Establishment(**data)
    _set_geom(estab)
    return estab


def _code_taken(db: Session, code: str) -> bool:
    return db.scalar(select(Establishment.id).where(
        func.lower(Establishment.wco_code) == code.lower())) is not None


def _set_geom(estab: Establishment) -> None:
    estab.geom = ST_SetSRID(ST_MakePoint(estab.longitude, estab.latitude), 4326)


@router.get("", response_model=list[EstablishmentOut])
def list_establishments(
    type: str | None = Query(None),
    barangay: str | None = Query(None),
    active_only: bool = Query(True),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    stmt = select(Establishment)
    if active_only:
        stmt = stmt.where(Establishment.is_active.is_(True))
    if type:
        stmt = stmt.where(Establishment.type == type)
    if barangay:
        stmt = stmt.where(Establishment.barangay == barangay)
    return list(db.scalars(stmt).all())


@router.get("/{estab_id}", response_model=EstablishmentOut)
def get_establishment(
    estab_id: int,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    estab = db.get(Establishment, estab_id)
    if not estab:
        raise HTTPException(status_code=404, detail="Establishment not found")
    return estab


@router.post("", response_model=EstablishmentOut, status_code=201)
def create_establishment(
    payload: EstablishmentCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    if _code_taken(db, payload.wco_code):
        raise HTTPException(status_code=409, detail=f"WCO code {payload.wco_code} is already in use.")
    estab = _new_establishment(payload)
    db.add(estab)
    log_action(db, current_user.email, current_user.id, "create", "establishment",
               details=payload.name)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f"WCO code {payload.wco_code} is already in use.")
    invalidate_gis_cache()
    db.refresh(estab)
    return estab


@router.patch("/{estab_id}", response_model=EstablishmentOut)
def update_establishment(
    estab_id: int,
    payload: EstablishmentUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    estab = db.get(Establishment, estab_id)
    if not estab:
        raise HTTPException(status_code=404, detail="Establishment not found")
    updates = payload.model_dump(exclude_unset=True)
    # Explicit nulls for NOT NULL columns are not "clear the value"; ignore them.
    for key in ("name", "type", "latitude", "longitude", "consent_given", "is_active", "data_source"):
        if key in updates and updates[key] is None:
            updates.pop(key)
    try:
        _check_study_area(updates.get("latitude", estab.latitude),
                          updates.get("longitude", estab.longitude))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    was_active = estab.is_active
    for key, value in updates.items():
        setattr(estab, key, value)
    if "latitude" in updates or "longitude" in updates:
        _set_geom(estab)
    action = "delete" if updates.get("is_active") is False else "update"
    log_action(db, current_user.email, current_user.id, action, "establishment",
               estab_id, details=estab.name)
    db.commit()
    invalidate_gis_cache()
    db.refresh(estab)
    if estab.is_active != was_active:
        # Training uses active establishments only, so this changes the training data.
        notify_training_data_changed(
            "establishment.reactivate" if estab.is_active else "establishment.deactivate",
            current_user)
    return estab


@router.post("/bulk", status_code=201)
def bulk_create_establishments(
    payload: list[EstablishmentCreate],
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    """Bulk-import establishments (all-or-nothing).

    Rows whose wco_code already exists (case-insensitive), or repeats an
    earlier row in the same request, are skipped — never overwritten.
    """
    if not payload:
        raise HTTPException(status_code=400, detail="No establishments provided")
    if len(payload) > MAX_BULK_ESTABLISHMENTS:
        raise HTTPException(status_code=413,
                            detail=f"At most {MAX_BULK_ESTABLISHMENTS:,} establishments per import.")
    existing = {c.lower() for c in db.scalars(select(Establishment.wco_code)).all()}
    seen: set[str] = set()
    imported, skipped, dup_in_request = 0, 0, 0
    for item in payload:
        key = item.wco_code.lower()
        if key in existing:
            skipped += 1
            continue
        if key in seen:
            dup_in_request += 1
            continue
        seen.add(key)
        db.add(_new_establishment(item))
        imported += 1
    if imported:
        log_action(db, current_user.email, current_user.id, "create", "establishment",
                   details=f"bulk import {imported} establishments ({skipped} skipped, "
                           f"{dup_in_request} duplicated within the file)")
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409,
                                detail="Import conflicted with establishments added concurrently; nothing was imported.")
        invalidate_gis_cache()
    return {"imported": imported, "skipped": skipped, "duplicates_in_request": dup_in_request}


@router.delete("/{estab_id}", status_code=204)
def soft_delete_establishment(
    estab_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin")),
):
    estab = db.get(Establishment, estab_id)
    if not estab:
        raise HTTPException(status_code=404, detail="Establishment not found")
    was_active = estab.is_active
    log_action(db, current_user.email, current_user.id, "delete", "establishment",
               estab_id, details=estab.name)
    estab.is_active = False
    db.commit()
    invalidate_gis_cache()
    if was_active:
        notify_training_data_changed("establishment.deactivate", current_user)
