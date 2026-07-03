from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.database import get_db
from app.core.security import get_current_user, require_role
from app.models.wco import WCOGenerationRecord
from app.schemas.schemas import (
    WCORecordCreate, WCORecordOut, WCORecordUpdate, WeeklyTotalOut,
    WCOSummaryOut, WCOCompletenessOut, MonthlyTotalOut,
)

router = APIRouter(prefix="/wco", tags=["wco"])


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
    existing = db.scalar(
        select(WCOGenerationRecord).where(
            WCOGenerationRecord.establishment_id == payload.establishment_id,
            WCOGenerationRecord.week_date == payload.week_date,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="A record for this establishment and week already exists.")
    record = WCOGenerationRecord(**payload.model_dump())
    db.add(record)
    log_action(db, current_user.email, current_user.id, "create", "wco_record",
               resource_id=payload.establishment_id,
               details=f"{payload.quantity_liters}L week={payload.week_date}")
    db.commit()
    db.refresh(record)
    return record


@router.post("/records/bulk", status_code=201)
def bulk_create_records(
    payload: list[WCORecordCreate],
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    """Bulk-import WCO records; silently skips duplicate week+establishment pairs."""
    if not payload:
        raise HTTPException(status_code=400, detail="No records provided")
    imported, skipped = 0, 0
    for item in payload:
        exists = db.scalar(
            select(WCOGenerationRecord).where(
                WCOGenerationRecord.establishment_id == item.establishment_id,
                WCOGenerationRecord.week_date == item.week_date,
            )
        )
        if exists:
            skipped += 1
            continue
        db.add(WCOGenerationRecord(**item.model_dump()))
        imported += 1
    if imported:
        log_action(db, current_user.email, current_user.id, "create", "wco_record",
                   details=f"bulk import {imported} records ({skipped} skipped)")
        db.commit()
    return {"imported": imported, "skipped": skipped}


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
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(record, k, v)
    log_action(db, current_user.email, current_user.id, "update", "wco_record", record_id)
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

    month_total = db.scalar(
        select(func.sum(WCOGenerationRecord.quantity_liters))
        .where(WCOGenerationRecord.week_date >= month_start)
    ) or 0.0

    ytd_total = db.scalar(
        select(func.sum(WCOGenerationRecord.quantity_liters))
        .where(WCOGenerationRecord.week_date >= year_start)
    ) or 0.0

    last_rec = db.scalar(select(func.max(WCOGenerationRecord.week_date)))

    return {
        "month_total_liters": round(float(month_total), 1),
        "ytd_total_liters": round(float(ytd_total), 1),
        "current_month": today.month,
        "current_year": today.year,
        "last_updated": str(last_rec) if last_rec else None,
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
