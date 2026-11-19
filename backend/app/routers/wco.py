"""Weekly WCO generation records: CRUD, bulk import, and aggregates.

Every successful write to training data (create / bulk import / edit /
delete) schedules automatic batch retraining AFTER the commit succeeds.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.cache import invalidate_gis_cache
from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_user, require_role
from app.models.establishment import Establishment
from app.models.wco import WCOGenerationRecord
from app.schemas.schemas import (
    WCORecordCreate, WCORecordOut, WCORecordUpdate, WeeklyTotalOut,
    WCOSummaryOut, WCOCompletenessOut, MonthlyTotalOut,
)
from app.services.retraining import notify_training_data_changed

router = APIRouter(prefix="/wco", tags=["wco"])

MAX_BULK_RECORDS = 20_000
_DUPLICATE_MSG = "A record for this establishment and week already exists."


def _active_establishment_or_error(db: Session, establishment_id: int) -> Establishment:
    estab = db.get(Establishment, establishment_id)
    if estab is None:
        raise HTTPException(status_code=404, detail=f"Establishment {establishment_id} not found.")
    if not estab.is_active:
        raise HTTPException(status_code=409,
                            detail=f"Establishment {estab.wco_code} is inactive; reactivate it first.")
    return estab


@router.get("/weekly-totals", response_model=list[WeeklyTotalOut])
def weekly_totals(
    weeks: int = Query(26, le=104),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Aggregate total WCO liters per week across all establishments."""
    rows = db.execute(
        select(
            WCOGenerationRecord.week_date,
            func.sum(WCOGenerationRecord.quantity_liters).label("total_liters"),
            func.count(WCOGenerationRecord.establishment_id).label("count"),
        )
        .join(Establishment, Establishment.id == WCOGenerationRecord.establishment_id)
        .where(Establishment.is_active.is_(True))
        .group_by(WCOGenerationRecord.week_date)
        .order_by(WCOGenerationRecord.week_date.desc())
        .limit(weeks)
    ).all()
    return [
        {"week_date": str(r.week_date), "total_liters": round(r.total_liters, 1), "count": r.count}
        for r in reversed(rows)
    ]


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
    _active_establishment_or_error(db, payload.establishment_id)
    existing = db.scalar(
        select(WCOGenerationRecord.id).where(
            WCOGenerationRecord.establishment_id == payload.establishment_id,
            WCOGenerationRecord.week_date == payload.week_date,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail=_DUPLICATE_MSG)
    data = payload.model_dump()
    data["data_source"] = data["data_source"] or settings.default_data_source
    record = WCOGenerationRecord(**data)
    db.add(record)
    log_action(db, current_user.email, current_user.id, "create", "wco_record",
               resource_id=payload.establishment_id,
               details=f"{payload.quantity_liters}L week={payload.week_date} source={data['data_source']}")
    try:
        db.commit()
    except IntegrityError:
        # Lost a race with a concurrent insert of the same week (unique constraint).
        db.rollback()
        raise HTTPException(status_code=409, detail=_DUPLICATE_MSG)
    invalidate_gis_cache()
    db.refresh(record)
    notify_training_data_changed("wco_record.create", current_user)
    return record


@router.post("/records/bulk", status_code=201)
def bulk_create_records(
    payload: list[WCORecordCreate],
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    """Bulk-import WCO records (all-or-nothing).

    Rows whose (establishment, week) already exists in the database, or that
    repeat an earlier row of the same request, are rejected and counted in
    ``skipped`` / ``duplicates_in_request`` — never inserted twice and never
    overwriting an existing record.
    """
    if not payload:
        raise HTTPException(status_code=400, detail="No records provided")
    if len(payload) > MAX_BULK_RECORDS:
        raise HTTPException(status_code=413,
                            detail=f"At most {MAX_BULK_RECORDS:,} records per import.")

    estab_ids = {item.establishment_id for item in payload}
    found = {e.id: e for e in db.scalars(
        select(Establishment).where(Establishment.id.in_(estab_ids))).all()}
    missing = sorted(estab_ids - found.keys())
    if missing:
        raise HTTPException(status_code=404,
                            detail=f"Unknown establishment id(s): {missing[:20]}")
    inactive = sorted(e.wco_code for e in found.values() if not e.is_active)
    if inactive:
        raise HTTPException(status_code=409,
                            detail=f"Inactive establishment(s): {inactive[:20]}")

    # One query for all existing (establishment, week) pairs of these establishments.
    existing = set(db.execute(
        select(WCOGenerationRecord.establishment_id, WCOGenerationRecord.week_date)
        .where(WCOGenerationRecord.establishment_id.in_(estab_ids))
    ).all())

    seen: set = set()
    imported, skipped, dup_in_request = 0, 0, 0
    for item in payload:
        key = (item.establishment_id, item.week_date)
        if key in existing:
            skipped += 1
            continue
        if key in seen:
            dup_in_request += 1
            continue
        seen.add(key)
        data = item.model_dump()
        data["data_source"] = data["data_source"] or settings.default_data_source
        db.add(WCOGenerationRecord(**data))
        imported += 1

    job_id = None
    if imported:
        log_action(db, current_user.email, current_user.id, "create", "wco_record",
                   details=(f"bulk import {imported} records ({skipped} already existed, "
                            f"{dup_in_request} duplicated within the file)"))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409,
                                detail="Import conflicted with records added concurrently; nothing was imported. Retry.")
        invalidate_gis_cache()
        job_id = notify_training_data_changed("wco_record.bulk_import", current_user)
    return {"imported": imported, "skipped": skipped,
            "duplicates_in_request": dup_in_request, "retraining_job_id": job_id}


@router.patch("/records/{record_id}", response_model=WCORecordOut)
def update_record(
    record_id: int,
    payload: WCORecordUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    record = db.get(WCOGenerationRecord, record_id)
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")
    updates = payload.model_dump(exclude_unset=True)
    if "data_source" in updates and updates["data_source"] is None:
        updates.pop("data_source")
    new_week = updates.get("week_date", record.week_date)
    new_end = updates.get("week_end_date", record.week_end_date)
    if new_end is not None and new_end < new_week:
        raise HTTPException(status_code=422, detail="week_end_date must be on or after week_date")
    if new_week != record.week_date:
        clash = db.scalar(select(WCOGenerationRecord.id).where(
            WCOGenerationRecord.establishment_id == record.establishment_id,
            WCOGenerationRecord.week_date == new_week,
            WCOGenerationRecord.id != record.id,
        ))
        if clash:
            raise HTTPException(status_code=409, detail=_DUPLICATE_MSG)
    before = f"{record.quantity_liters}L week={record.week_date}"
    for k, v in updates.items():
        setattr(record, k, v)
    record.updated_at = datetime.now(timezone.utc)
    log_action(db, current_user.email, current_user.id, "update", "wco_record", record_id,
               details=f"{before} → {record.quantity_liters}L week={record.week_date}")
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=_DUPLICATE_MSG)
    invalidate_gis_cache()
    db.refresh(record)
    notify_training_data_changed("wco_record.update", current_user)
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
    log_action(db, current_user.email, current_user.id, "delete", "wco_record", record_id,
               details=f"establishment={record.establishment_id} week={record.week_date} "
                       f"{record.quantity_liters}L")
    db.delete(record)
    db.commit()
    invalidate_gis_cache()
    notify_training_data_changed("wco_record.delete", current_user)


@router.get("/summary", response_model=WCOSummaryOut)
def wco_summary(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Month-to-date and year-to-date WCO totals plus last data entry date."""
    from datetime import date as date_cls
    today = date_cls.today()
    month_start = today.replace(day=1)
    year_start = today.replace(month=1, day=1)

    def active(stmt):
        return (stmt.join(Establishment, Establishment.id == WCOGenerationRecord.establishment_id)
                .where(Establishment.is_active.is_(True)))

    month_total = db.scalar(active(
        select(func.sum(WCOGenerationRecord.quantity_liters))
        .where(WCOGenerationRecord.week_date >= month_start)
    )) or 0.0

    ytd_total = db.scalar(active(
        select(func.sum(WCOGenerationRecord.quantity_liters))
        .where(WCOGenerationRecord.week_date >= year_start)
    )) or 0.0

    last_rec = db.scalar(active(select(func.max(WCOGenerationRecord.week_date))))
    source_counts = dict(db.execute(active(
        select(WCOGenerationRecord.data_source, func.count(WCOGenerationRecord.id))
        .group_by(WCOGenerationRecord.data_source)
    )).all())

    return {
        "month_total_liters": round(float(month_total), 1),
        "ytd_total_liters": round(float(ytd_total), 1),
        "current_month": today.month,
        "current_year": today.year,
        "last_updated": str(last_rec) if last_rec else None,
        "data_source_counts": {k: int(v) for k, v in source_counts.items()},
    }


@router.get("/completeness/{establishment_id}", response_model=WCOCompletenessOut)
def wco_completeness(
    establishment_id: int,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Percentage of expected weeks that have a WCO record for this establishment."""
    records = db.scalars(
        select(WCOGenerationRecord)
        .where(WCOGenerationRecord.establishment_id == establishment_id)
        .order_by(WCOGenerationRecord.week_date)
    ).all()

    if not records:
        return {
            "establishment_id": establishment_id,
            "weeks_with_data": 0, "expected_weeks": 0,
            "completeness_pct": 0.0,
            "first_record_date": None, "last_record_date": None,
        }

    first = records[0].week_date
    last  = records[-1].week_date
    expected = max(1, ((last - first).days // 7) + 1)

    return {
        "establishment_id": establishment_id,
        "weeks_with_data": len(records),
        "expected_weeks": expected,
        "completeness_pct": round(len(records) / expected * 100, 1),
        "first_record_date": str(first),
        "last_record_date": str(last),
    }


@router.get("/monthly/{establishment_id}", response_model=list[MonthlyTotalOut])
def wco_monthly(
    establishment_id: int,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Monthly WCO totals for a single establishment."""
    from sqlalchemy import extract
    rows = db.execute(
        select(
            extract("year",  WCOGenerationRecord.week_date).label("year"),
            extract("month", WCOGenerationRecord.week_date).label("month"),
            func.sum(WCOGenerationRecord.quantity_liters).label("total_liters"),
            func.count(WCOGenerationRecord.id).label("record_count"),
        )
        .where(WCOGenerationRecord.establishment_id == establishment_id)
        .group_by("year", "month")
        .order_by("year", "month")
    ).all()
    return [
        {"year": int(r.year), "month": int(r.month),
         "total_liters": round(r.total_liters, 1), "record_count": r.record_count}
        for r in rows
    ]


@router.get("/last-collection")
def last_collection_dates(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Returns {establishment_id: last_week_date_str} for all establishments that have records."""
    rows = db.execute(
        select(
            WCOGenerationRecord.establishment_id,
            func.max(WCOGenerationRecord.week_date).label("last_date"),
        ).group_by(WCOGenerationRecord.establishment_id)
    ).all()
    return {r.establishment_id: str(r.last_date) for r in rows}
