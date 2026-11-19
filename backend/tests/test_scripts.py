"""Operational scripts: demo loader, provenance labelling, export, seed guards."""
from datetime import date, timedelta

import pytest
from sqlalchemy import func, select

from app.models import Establishment, WCOGenerationRecord
from app.models.ml import ModelTrainingJob
from conftest import make_establishment
from scripts import export_csv, label_data_source, load_demo_data

END = date(2026, 11, 9)   # a Monday in the past


def count(db, model):
    db.expire_all()
    return db.scalar(select(func.count()).select_from(model))


def test_demo_loader_dry_run_writes_nothing(db):
    assert load_demo_data.main(["--limit", "5", "--end-date", str(END)]) == 0
    assert count(db, Establishment) == 0 and count(db, WCOGenerationRecord) == 0


def test_demo_loader_commit_is_additive_labelled_and_idempotent(db):
    assert load_demo_data.main(["--commit", "--limit", "5", "--end-date", str(END)]) == 0
    assert count(db, Establishment) == 5 and count(db, WCOGenerationRecord) == 5 * 52
    e = db.scalar(select(Establishment).where(Establishment.wco_code == "RS001"))
    assert e.data_source == "synthetic" and e.consent_given is False
    assert "Cafe Lucia" not in e.name                     # generic names by default
    recs = db.scalars(select(WCOGenerationRecord).where(WCOGenerationRecord.establishment_id == e.id)
                      .order_by(WCOGenerationRecord.week_date)).all()
    assert recs[-1].week_date == END and all(r.data_source == "synthetic" for r in recs)
    assert all((b.week_date - a.week_date).days == 7 for a, b in zip(recs, recs[1:]))
    assert all(0 <= r.quantity_liters <= 10_000 for r in recs)
    assert db.scalar(select(ModelTrainingJob.status)) == "pending"   # retraining queued

    # Second run: nothing new, nothing modified.
    before = {r.id: r.quantity_liters for r in db.scalars(select(WCOGenerationRecord))}
    assert load_demo_data.main(["--commit", "--limit", "5", "--end-date", str(END)]) == 0
    db.expire_all()
    after = {r.id: r.quantity_liters for r in db.scalars(select(WCOGenerationRecord))}
    assert before == after


def test_demo_loader_is_reproducible(db):
    a = load_demo_data.fresh_series("FF007", "fast_food", 52, END, 42)
    b = load_demo_data.fresh_series("FF007", "fast_food", 52, END, 42)
    c = load_demo_data.fresh_series("FF007", "fast_food", 52, END, 43)
    assert a == b and a != c


def test_demo_loader_never_overwrites_existing_and_extends_on_request(db):
    e = make_establishment(db, code="RS001")
    start = END - timedelta(weeks=29)
    for w in range(20):   # existing series stops 10 weeks before END
        db.add(WCOGenerationRecord(establishment_id=e.id, week_date=start + timedelta(weeks=w),
                                   quantity_liters=30.0 + w))
    db.commit()
    load_demo_data.main(["--commit", "--limit", "1", "--end-date", str(END)])
    assert count(db, WCOGenerationRecord) == 20                      # untouched without --extend-existing
    load_demo_data.main(["--commit", "--limit", "1", "--end-date", str(END), "--extend-existing"])
    db.expire_all()
    recs = db.scalars(select(WCOGenerationRecord).order_by(WCOGenerationRecord.week_date)).all()
    assert len(recs) == 30 and recs[-1].week_date == END
    assert [r.quantity_liters for r in recs[:20]] == [30.0 + w for w in range(20)]
    assert all(r.data_source == "synthetic" for r in recs[20:])
    db.refresh(e)
    assert e.name == "Test RS001"                                    # establishment not modified


def test_label_data_source_only_touches_unspecified(db):
    e = make_establishment(db, code="X1")
    db.add_all([WCOGenerationRecord(establishment_id=e.id, week_date=END - timedelta(weeks=k),
                                    quantity_liters=10, data_source=src)
                for k, src in enumerate(["unspecified", "unspecified", "observed"])])
    db.commit()
    assert label_data_source.main(["--source", "synthetic"]) == 0     # dry run
    assert db.scalar(select(func.count()).where(WCOGenerationRecord.data_source == "synthetic")) == 0
    assert label_data_source.main(["--source", "synthetic", "--commit"]) == 0
    db.expire_all()
    got = sorted(db.scalars(select(WCOGenerationRecord.data_source)).all())
    assert got == ["observed", "synthetic", "synthetic"]


def test_export_includes_stable_code(db, tmp_path):
    e = make_establishment(db, code="FF009")
    db.add(WCOGenerationRecord(establishment_id=e.id, week_date=END, quantity_liters=12.5,
                               data_source="synthetic"))
    db.commit()
    out = tmp_path / "x.csv"
    export_csv.main(["--out", str(out)])
    lines = out.read_text().splitlines()
    assert lines[0] == "establishment_id,wco_code,week_date,quantity_liters,data_source"
    assert lines[1].split(",")[1:] == ["FF009", str(END), "12.5", "synthetic"]


@pytest.mark.parametrize("module", ["scripts.seed", "scripts.import_real_establishments"])
def test_destructive_seeds_refuse_without_flag(module, monkeypatch, db):
    import importlib
    make_establishment(db, code="KEEP1")
    mod = importlib.import_module(module)
    monkeypatch.setattr("sys.argv", [module])
    with pytest.raises(SystemExit) as exc:
        mod.main()
    assert exc.value.code == 2
    assert count(db, Establishment) == 1                              # nothing wiped


def test_destructive_seed_requires_typed_confirmation(monkeypatch, db):
    import scripts.import_real_establishments as mod
    make_establishment(db, code="KEEP2")
    monkeypatch.setattr("sys.argv", ["x", "--i-understand-this-deletes-data"])
    monkeypatch.setattr("builtins.input", lambda prompt="": "wrong-host")
    with pytest.raises(SystemExit):
        mod.main()
    assert count(db, Establishment) == 1


def test_check_db_runs_read_only(db, capsys):
    from scripts import check_db
    make_establishment(db, code="DOC1")
    code = check_db.main()
    out = capsys.readouterr().out
    assert code in (0, 1)                      # 1 here: test DB has no alembic_version row
    assert "connected" in out and "password" not in out.lower()
    assert count(db, Establishment) == 1
