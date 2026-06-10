"""Export WCO records to CSV for Colab retraining.

Run from backend/:  python -m app.export_csv
"""
from app.core.database import SessionLocal
from app.models.wco import WCOGenerationRecord
from sqlalchemy import select
import pandas as pd

def main():
    db = SessionLocal()
    try:
        rows = db.scalars(select(WCOGenerationRecord)).all()
        df = pd.DataFrame([{
            "establishment_id": r.establishment_id,
            "week_date": str(r.week_date),
            "quantity_liters": r.quantity_liters,
        } for r in rows])
        df.to_csv("wco_export.csv", index=False)
        print(f"Exported {len(df):,} rows to wco_export.csv")
        print(f"Establishments: {df['establishment_id'].nunique()}")
        print(f"Date range: {df['week_date'].min()} → {df['week_date'].max()}")
    finally:
        db.close()

if __name__ == "__main__":
    main()
