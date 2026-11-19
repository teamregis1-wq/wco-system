"""Export WCO records to CSV (for archiving or the Colab notebook).

    cd backend
    ./venv/bin/python -m scripts.export_csv [--out PATH]   # default: data/wco_export_<YYYYMMDD>.csv

Columns: establishment_id, wco_code, week_date, quantity_liters, data_source.

establishment_id is the row id in THIS database only — ids differ between
databases (the archived data/wco_export.csv uses ids 551–670). Use wco_code
to match establishments across databases; never assume ids line up.
"""
import argparse
import csv
from collections import Counter
from datetime import date

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
        header = ["establishment_id", "wco_code", "week_date", "quantity_liters", "data_source"]
        with open(args.out, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(header)
            for r in rows:
                w.writerow([r[0], r[1], r[2].isoformat(), r[3], r[4]])
        print(f"Exported {len(rows):,} rows to {args.out}")
        if rows:
            print(f"Establishments: {len({r[0] for r in rows})}")
            print(f"Date range: {min(r[2] for r in rows)} → {max(r[2] for r in rows)}")
            print(f"By data_source: {dict(Counter(r[4] for r in rows))}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
