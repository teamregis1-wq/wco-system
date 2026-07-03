from fastapi import APIRouter, Depends, HTTPException, Query
from geoalchemy2.functions import ST_SetSRID, ST_MakePoint
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.database import get_db
from app.core.security import get_current_user, require_role
from app.models.establishment import Establishment
from app.schemas.schemas import EstablishmentCreate, EstablishmentOut, EstablishmentUpdate

router = APIRouter(prefix="/establishments", tags=["establishments"])


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
    estab = Establishment(**payload.model_dump())
    _set_geom(estab)
    db.add(estab)
    log_action(db, current_user.email, current_user.id, "create", "establishment",
               details=payload.name)
    db.commit()
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
    for key, value in updates.items():
        setattr(estab, key, value)
    if "latitude" in updates or "longitude" in updates:
        _set_geom(estab)
    action = "delete" if updates.get("is_active") is False else "update"
    log_action(db, current_user.email, current_user.id, action, "establishment",
               estab_id, details=estab.name)
    db.commit()
    db.refresh(estab)
    return estab


@router.post("/bulk", status_code=201)
def bulk_create_establishments(
    payload: list[EstablishmentCreate],
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    """Bulk-import establishments; skips rows with a duplicate wco_code."""
    if not payload:
        raise HTTPException(status_code=400, detail="No establishments provided")
    imported, skipped = 0, 0
    for item in payload:
        exists = db.scalar(
            select(Establishment).where(Establishment.wco_code == item.wco_code)
        )
        if exists:
            skipped += 1
            continue
        estab = Establishment(**item.model_dump())
        _set_geom(estab)
        db.add(estab)
        imported += 1
    if imported:
        log_action(db, current_user.email, current_user.id, "create", "establishment",
                   details=f"bulk import {imported} establishments ({skipped} skipped)")
        db.commit()
    return {"imported": imported, "skipped": skipped}


@router.delete("/{estab_id}", status_code=204)
def soft_delete_establishment(
    estab_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin")),
):
    estab = db.get(Establishment, estab_id)
    if not estab:
        raise HTTPException(status_code=404, detail="Establishment not found")
    log_action(db, current_user.email, current_user.id, "delete", "establishment",
               estab_id, details=estab.name)
    estab.is_active = False
    db.commit()
