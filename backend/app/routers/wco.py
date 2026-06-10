from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.database import get_db
from app.core.security import get_current_user, require_role
from app.models.wco import WCOGenerationRecord
from app.schemas.schemas import WCORecordCreate, WCORecordOut

router = APIRouter(prefix="/wco", tags=["wco"])


@router.get("/records", response_model=list[WCORecordOut])
def list_records(
    establishment_id: int = Query(...),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    stmt = (
        select(WCOGenerationRecord)
        .where(WCOGenerationRecord.establishment_id == establishment_id)
        .order_by(WCOGenerationRecord.week_date.desc())
    )
    return list(db.scalars(stmt).all())


@router.post("/records", response_model=WCORecordOut, status_code=201)
def create_record(
    payload: WCORecordCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    record = WCOGenerationRecord(**payload.model_dump())
    db.add(record)
    log_action(db, current_user.email, current_user.id, "create", "wco_record",
               resource_id=payload.establishment_id,
               details=f"{payload.quantity_liters}L week={payload.week_date}")
    db.commit()
    db.refresh(record)
    return record


@router.delete("/records/{record_id}", status_code=204)
def delete_record(
    record_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    record = db.get(WCOGenerationRecord, record_id)
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")
    log_action(db, current_user.email, current_user.id, "delete", "wco_record", record_id)
    db.delete(record)
    db.commit()
