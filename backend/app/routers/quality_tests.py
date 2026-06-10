from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.database import get_db
from app.core.security import require_role, get_current_user
from app.models.wco import WCOQualityTest
from app.schemas.schemas import QualityTestCreate, QualityTestOut

router = APIRouter(prefix="/quality-tests", tags=["quality-tests"])


@router.get("", response_model=list[QualityTestOut])
def list_quality_tests(
    establishment_id: int = Query(...),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    stmt = (
        select(WCOQualityTest)
        .where(WCOQualityTest.establishment_id == establishment_id)
        .order_by(WCOQualityTest.sample_date.desc())
    )
    return list(db.scalars(stmt).all())


@router.post("", response_model=QualityTestOut, status_code=201)
def create_quality_test(
    payload: QualityTestCreate,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    test = WCOQualityTest(**payload.model_dump())
    db.add(test)
    log_action(db, current_user.email, current_user.id, "create", "quality_test",
               resource_id=payload.establishment_id,
               details=f"FFA={payload.ffa_pct}% Visc={payload.viscosity_cp}cp Dens={payload.density_gml}g/mL")
    db.commit()
    db.refresh(test)
    return test


@router.delete("/{test_id}", status_code=204)
def delete_quality_test(
    test_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(require_role("admin", "researcher")),
):
    test = db.get(WCOQualityTest, test_id)
    if not test:
        raise HTTPException(status_code=404, detail="Quality test not found")
    log_action(db, current_user.email, current_user.id, "delete", "quality_test", test_id)
    db.delete(test)
    db.commit()
