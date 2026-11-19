"""Explicitly label existing rows' provenance (e.g. mark the demo dataset synthetic).

    cd backend
    ./venv/bin/python -m scripts.label_data_source --source synthetic            # dry run
    ./venv/bin/python -m scripts.label_data_source --source synthetic --commit   # write

Only rows currently labelled 'unspecified' are changed — a row already marked
'synthetic' or 'observed' is never relabelled. Optionally restrict to
establishment codes with --codes RS001,FF002. Writes one audit-log entry.
No rows are deleted and no quantities are touched.
"""
import argparse
import sys

from sqlalchemy import func, select, update

from app.core.audit import log_action
from app.core.database import SessionLocal, safe_url, engine
from app.models import Establishment, WCOGenerationRecord


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, choices=["synthetic", "observed"])
    ap.add_argument("--codes", default=None, help="comma-separated wco_codes (default: all)")
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args(argv)

    db = SessionLocal()
    try:
        estab_q = select(Establishment.id).where(Establishment.data_source == "unspecified")
        rec_q = (select(WCOGenerationRecord.id)
                 .where(WCOGenerationRecord.data_source == "unspecified"))
        if args.codes:
            codes = [c.strip().lower() for c in args.codes.split(",") if c.strip()]
            ids = select(Establishment.id).where(func.lower(Establishment.wco_code).in_(codes))
            estab_q = estab_q.where(Establishment.id.in_(ids))
            rec_q = rec_q.where(WCOGenerationRecord.establishment_id.in_(ids))
        n_e = db.scalar(select(func.count()).select_from(estab_q.subquery()))
        n_r = db.scalar(select(func.count()).select_from(rec_q.subquery()))
        print(f"Database: {safe_url(str(engine.url))}")
        print(f"Would label as '{args.source}': {n_e} establishments, {n_r:,} WCO records "
              f"(currently 'unspecified')")
        if not args.commit:
            print("Dry run. Re-run with --commit to apply.")
            return 0
        db.execute(update(Establishment).where(Establishment.id.in_(estab_q))
                   .values(data_source=args.source))
        db.execute(update(WCOGenerationRecord).where(WCOGenerationRecord.id.in_(rec_q))
                   .values(data_source=args.source))
        log_action(db, "scripts/label_data_source", None, "update", "wco_record",
                   details=f"labelled {n_e} establishments and {n_r} records as {args.source}")
        db.commit()
        print("Done.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
