"""Export WCO records to CSV (for archiving or the Colab notebook).

    cd backend
    ./venv/bin/python -m scripts.export_csv [--out PATH]   # default: data/wco_export_<YYYYMMDD>.csv

Columns: establishment_id, wco_code, week_date, quantity_liters, data_source.

establishment_id is the row id in THIS database only — ids differ between
databases (the archived data/wco_export.csv uses ids 551–670). Use wco_code
to match establishments across databases; never assume ids line up.
"""
import argparse
from datetime import date

import pandas as pd
from sqlalchemy import select

from app.core.database import SessionLocal
from app.models import Establishment, WCOGenerationRecord


def main(argv=None):
    ap = argparse.ArgumentParser()
    # Dated default so the archived data/wco_export.csv is never overwritten by accident.
    ap.add_argument("--out", default=f"data/wco_export_{date.today():%Y%m%d}.csv")
    args = ap.parse_args(argv)
    db = SessionLocal()
    try:
        rows = db.execute(
            select(WCOGenerationRecord.establishment_id, Establishment.wco_code,
                   WCOGenerationRecord.week_date, WCOGenerationRecord.quantity_liters,
                   WCOGenerationRecord.data_source)
            .join(Establishment, Establishment.id == WCOGenerationRecord.establishment_id)
            .order_by(WCOGenerationRecord.establishment_id, WCOGenerationRecord.week_date)
        ).all()
        df = pd.DataFrame(rows, columns=["establishment_id", "wco_code", "week_date",
                                         "quantity_liters", "data_source"])
        df["week_date"] = df["week_date"].astype(str)
        df.to_csv(args.out, index=False)
        print(f"Exported {len(df):,} rows to {args.out}")
        if len(df):
            print(f"Establishments: {df['establishment_id'].nunique()}")
            print(f"Date range: {df['week_date'].min()} → {df['week_date'].max()}")
            print(f"By data_source: {df['data_source'].value_counts().to_dict()}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
