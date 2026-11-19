"""Forecasting methodology, model persistence, and the 13-week forecast API."""
import shutil
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pytest
from sqlalchemy import select

from app.models.ml import ModelVersion
from app.services import model_store
from app.services.forecasting import InsufficientHistoryError, trailing_window
from app.services.training import (
    Observation, TrainingConfig, build_model, recursive_forecast, regression_metrics,
    run_training_pipeline, segment_series,
)
from conftest import make_establishment, synthetic_value

API = "/api/v1"
CFG = TrainingConfig(max_epochs=4, patience=2)
D0 = date(2025, 1, 6)


def series(eid, weeks, start=D0, base=40.0, skip=()):
    return [Observation(eid, start + timedelta(weeks=w), synthetic_value(base, w, eid))
            for w in range(weeks) if w not in skip]


# ── Data validation / segmentation ───────────────────────────────────────────

def test_segmentation_detects_quality_problems():
    obs = (series(1, 30)                                         # clean
           + series(2, 30, skip={10, 11})                        # 2 missing weeks
           + series(3, 8)                                        # insufficient history
           + series(4, 20) + [Observation(4, D0, 1.0)]           # duplicate week
           + series(5, 20) + [Observation(5, D0 + timedelta(days=7 * 20 + 3), 9.0)]  # irregular
           + [Observation(6, D0 + timedelta(weeks=w), float("nan") if w == 5 else 10.0)
              for w in range(30)])                               # invalid value
    segments, report = segment_series(obs, seq_len=12)
    assert report["missing_weeks"] == 2
    assert report["duplicate_weeks"] == 1
    assert report["irregular_intervals"] == 1
    assert report["invalid_values"] == 1
    excluded = {x["establishment_id"]: x["reason"] for x in report["excluded_establishments"]}
    assert "duplicate" in excluded[4] and "insufficient history" in excluded[3]
    # No segment spans a gap or mixes establishments.
    for seg in segments:
        assert all((b - a).days == 7 for a, b in zip(seg.dates, seg.dates[1:]))
        assert len(seg.values) >= 13
    assert {s.establishment_id for s in segments} == {1, 2, 5, 6}


# ── Split / scaler / seeds ───────────────────────────────────────────────────

def _dataset(n=6, weeks=40):
    return [o for k in range(n) for o in series(k + 1, weeks, base=20 + 10 * k)]


def test_scaler_fitted_on_training_period_only():
    obs = _dataset()
    last = max(o.week_date for o in obs)
    # Inject a huge value in the final (test) week: it must not affect the scaler.
    obs.append(Observation(99, last, 9_000.0))
    obs += [Observation(99, last - timedelta(weeks=k), 30.0) for k in range(1, 40)]
    res = run_training_pipeline(obs, CFG)
    assert res.scaler_max < 1_000
    split = res.data_report["split"]
    assert split["test_weeks"].endswith(last.isoformat())


def test_split_is_chronological():
    res = run_training_pipeline(_dataset(), CFG)
    s = res.data_report["split"]
    train_before = date.fromisoformat(s["train_targets_before"])
    test_start = date.fromisoformat(s["test_weeks"].split(" .. ")[0])
    assert train_before < test_start
    # 40 weeks: 12-week windows → targets at weeks 12..39; test = last 16, val = 6 before.
    assert res.test_samples == 6 * 16 and res.val_samples == 6 * 6
    assert res.train_samples == 6 * (40 - 12 - 16 - 6)


def test_training_is_reproducible():
    a = run_training_pipeline(_dataset(), CFG)
    b = run_training_pipeline(_dataset(), CFG)
    for k in a.state_dict:
        assert np.array_equal(a.state_dict[k].numpy(), b.state_dict[k].numpy())
    assert a.metrics == b.metrics and a.fingerprint == b.fingerprint


def test_evaluation_reports_baselines_and_rolling_backtest():
    m = run_training_pipeline(_dataset(), CFG).metrics
    assert set(m["one_step"]) >= {"model", "naive_last_week", "moving_average_12", "seasonal_naive_13"}
    ms = m["multi_step"]
    assert ms["horizon_weeks"] == 13 and ms["origins"] == 16 - 13 + 1
    assert len(ms["per_horizon"]) == 13
    assert ms["forecasts"] == 6 * ms["origins"]
    assert m["units"]["mae"].startswith("liters")


def test_regression_metrics_known_values():
    m = regression_metrics(np.array([10.0, 20.0, 30.0]), np.array([12.0, 18.0, 33.0]))
    assert m["mae"] == pytest.approx(7 / 3, abs=1e-3)
    assert m["rmse"] == pytest.approx(np.sqrt((4 + 4 + 9) / 3), abs=1e-3)
    assert m["r2"] == pytest.approx(1 - 17 / 200, abs=1e-4)
    assert m["mape"] == pytest.approx((0.2 + 0.1 + 0.1) / 3 * 100, abs=1e-2)
    # MAPE ignores zero actuals instead of dividing by zero.
    assert regression_metrics(np.array([0.0, 10.0]), np.array([1.0, 11.0]))["mape"] == 10.0


def test_recursive_forecast_feeds_back_predictions():
    import torch
    torch.manual_seed(0)
    model = build_model()
    window = np.linspace(0.2, 0.5, 12)
    batch = recursive_forecast(model, window[None, :], 3)[0]
    manual, w = [], list(window)
    with torch.no_grad():
        for _ in range(3):
            y = float(model(torch.tensor(w[-12:], dtype=torch.float32).view(1, 12, 1)).item())
            manual.append(y)
            w.append(y)
    assert np.allclose(batch, manual, atol=1e-6)


# ── Input window for inference ───────────────────────────────────────────────

def test_trailing_window_rules():
    assert D0.weekday() == 0
    rows = [(D0 + timedelta(weeks=w), float(w)) for w in range(20)]
    values, origin = trailing_window(rows, min_weeks=12)
    assert len(values) == 12 and values[-1] == 19.0 and origin == rows[-1][0]

    with pytest.raises(InsufficientHistoryError, match="no WCO records"):
        trailing_window([], 12)
    # History shorter than 12 weeks is refused (the error roughly doubles).
    with pytest.raises(InsufficientHistoryError, match="span 5 week"):
        trailing_window(rows[:5], 12)
    with pytest.raises(InsufficientHistoryError, match="span 11 week"):
        trailing_window(rows[:11], 12)


def test_non_consecutive_weeks_are_accepted_up_to_four_missing():
    # 4 of the last 12 weeks missing (8 observed) → forecast, with the gaps filled.
    keep = [w for w in range(20) if w not in (9, 12, 13, 17)]
    rows = [(D0 + timedelta(weeks=w), float(w)) for w in keep]
    warnings: list[str] = []
    values, origin = trailing_window(rows, min_weeks=12, warnings=warnings)
    assert values.tolist() == [float(w) for w in range(8, 20)]     # linear series restored exactly
    assert origin == D0 + timedelta(weeks=19)
    assert warnings and "4 of the 12 input weeks had no record" in warnings[0]

    # Leading weeks of the window are interpolated from a record BEFORE the window.
    rows = [(D0 + timedelta(weeks=w), float(w)) for w in [0, 1, 2, 3] + list(range(12, 20))]
    values, _ = trailing_window(rows, min_weeks=12)
    assert values.tolist() == [float(w) for w in range(8, 20)]

    # 5 missing (7 observed) → refused with the count.
    keep = [w for w in range(20) if w not in (9, 11, 12, 13, 17)]
    with pytest.raises(InsufficientHistoryError, match="at least 8 of the last 12 weeks.*has 7"):
        trailing_window([(D0 + timedelta(weeks=w), float(w)) for w in keep], 12)


def test_off_schedule_record_does_not_break_the_series():
    rows = [(D0 + timedelta(weeks=w), float(w)) for w in range(20)]
    # A Tuesday entry in a week that already has its Monday record is ignored (and named).
    stray = sorted(rows + [(rows[15][0] + timedelta(days=1), 400.0)])
    warnings: list[str] = []
    values, _ = trailing_window(stray, 12, warnings=warnings)
    assert values.tolist() == [float(w) for w in range(8, 20)]
    assert any("Ignored 1 record" in w and str(rows[15][0] + timedelta(days=1)) in w for w in warnings)
    # A Sunday entry for a week with no Monday record counts toward the next Monday.
    sunday = [r for r in rows if r[0] != rows[16][0]] + [(rows[16][0] - timedelta(days=1), 16.0)]
    warnings = []
    values, _ = trailing_window(sorted(sunday), 12, warnings=warnings)
    assert values.tolist() == [float(w) for w in range(8, 20)]
    assert any("nearest Monday-start week" in w for w in warnings)


def test_interpolation_is_for_inference_only():
    rows = [(D0 + timedelta(weeks=w), float(w)) for w in range(20) if w != 17]
    # Training never bridges the gap.
    segs, report = segment_series([Observation(1, d, v) for d, v in rows], 12)
    assert report["missing_weeks"] == 1 and all(len(s.values) <= 17 for s in segs)


# ── Persistence / restart ────────────────────────────────────────────────────

def _train(scheduler):
    scheduler._schedule = lambda delay: None
    scheduler.notify_data_changed("t")
    scheduler.run_pending_now()


def test_model_survives_restart_and_ephemeral_disk(client, researcher_headers, seeded, db, scheduler):
    _train(scheduler)
    eid = seeded[0].id
    before = client.get(f"{API}/forecast/{eid}", headers=researcher_headers).json()

    # Simulate a restart on a host whose filesystem was wiped: drop the
    # in-memory model AND every local artifact file.
    model_store.invalidate_cache()
    shutil.rmtree(model_store.ARTIFACT_DIR / "versions", ignore_errors=True)

    after = client.get(f"{API}/forecast/{eid}", headers=researcher_headers).json()
    assert after["model_version"] == before["model_version"]
    assert after["points"] == before["points"]
    # The version was re-materialised from the database copy.
    assert (model_store.ARTIFACT_DIR / "versions" / after["model_version"] / "lstm_wco.pt").exists()


def test_corrupted_local_cache_is_never_used(client, researcher_headers, seeded, db, scheduler):
    _train(scheduler)
    eid = seeded[0].id
    good = client.get(f"{API}/forecast/{eid}", headers=researcher_headers).json()
    version = good["model_version"]
    # Truncate the cached weights (a "partially written" file) and drop the in-memory copy.
    path = model_store.version_dir(version) / "lstm_wco.pt"
    path.write_bytes(path.read_bytes()[:100])
    model_store.invalidate_cache()
    again = client.get(f"{API}/forecast/{eid}", headers=researcher_headers).json()
    assert again["points"] == good["points"]


def test_tampered_database_weights_refused(client, researcher_headers, seeded, db, scheduler):
    _train(scheduler)
    mv = db.scalar(select(ModelVersion).where(ModelVersion.is_active.is_(True)))
    mv.weights = mv.weights[:-10]
    db.commit()
    model_store.invalidate_cache()
    shutil.rmtree(model_store.ARTIFACT_DIR / "versions", ignore_errors=True)
    r = client.get(f"{API}/forecast/{seeded[0].id}", headers=researcher_headers)
    assert r.status_code == 503 and "checksum" in r.json()["detail"]


def test_atomic_write_leaves_no_partial_file(tmp_path, monkeypatch):
    target = tmp_path / "w.bin"
    target.write_bytes(b"old")

    def fail_replace(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(model_store.os, "replace", fail_replace)
    with pytest.raises(OSError):
        model_store.atomic_write_bytes(target, b"new-content")
    assert target.read_bytes() == b"old"
    assert [p.name for p in tmp_path.iterdir()] == ["w.bin"]   # temp file cleaned up


def test_no_model_returns_503(client, researcher_headers, seeded):
    r = client.get(f"{API}/forecast/{seeded[0].id}", headers=researcher_headers)
    assert r.status_code == 503 and "No trained model" in r.json()["detail"]


def test_bundled_model_used_until_first_retrain(client, researcher_headers, seeded, monkeypatch):
    monkeypatch.setattr(model_store, "BUNDLED_FALLBACK", True)
    r = client.get(f"{API}/forecast/{seeded[0].id}", headers=researcher_headers)
    assert r.status_code == 200 and r.json()["model_version"] == model_store.BUNDLED_VERSION
    s = client.get(f"{API}/forecast/training-status", headers=researcher_headers).json()
    assert s["active_model"]["source"] == "bundled"


def test_numpy_lstm_matches_pytorch():
    """The API's NumPy forward pass reproduces torch.nn.LSTM exactly (float32 tolerance)."""
    import torch

    from app.services.lstm_numpy import NumpyLSTM, deserialize_weights, serialize_weights
    torch.manual_seed(7)
    tm = build_model()
    blob = serialize_weights(tm.state_dict())
    nm = NumpyLSTM(deserialize_weights(blob))
    X = np.random.default_rng(1).uniform(0, 1, (40, 12))
    with torch.no_grad():
        t1 = tm(torch.tensor(X, dtype=torch.float32).unsqueeze(-1)).numpy().ravel()
    assert np.allclose(nm.predict_next(X), t1, atol=1e-5)
    # 13-step recursion: torch path vs NumPy path
    assert np.allclose(recursive_forecast(nm, X, 13), recursive_forecast(tm, X, 13), atol=1e-4)


def test_bundled_weights_npz_equals_legacy_pt():
    from app.services.lstm_numpy import deserialize_weights
    a = deserialize_weights(model_store.LEGACY_NPZ_PATH.read_bytes())
    b = deserialize_weights(model_store.LEGACY_WEIGHTS_PATH.read_bytes())   # torch format
    assert a.keys() == b.keys() and all(np.array_equal(a[k], b[k]) for k in a)


def test_api_inference_path_does_not_import_torch():
    """The deployed API must work without PyTorch installed (bundle-size limit)."""
    import subprocess
    import sys
    code = ("import sys, builtins; real = builtins.__import__\n"
            "def guard(name, *a, **k):\n"
            "    if name == 'torch' or name.startswith('torch.'): raise ImportError('torch blocked')\n"
            "    return real(name, *a, **k)\n"
            "builtins.__import__ = guard\n"
            "import app.main\n"
            "from app.services import forecasting, model_store, retraining\n"
            "m = model_store._load_bundled(); import numpy as np\n"
            "print(forecasting.recursive_forecast(m.model, np.full((2, 12), 0.4), 13).shape)\n")
    env = {**__import__("os").environ, "ML_BUNDLED_FALLBACK": "true"}
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                         cwd=str(Path(__file__).resolve().parents[1]), env=env)
    assert out.returncode == 0, out.stderr[-2000:]
    assert "(2, 13)" in out.stdout


# ── Forecast API ─────────────────────────────────────────────────────────────

def test_forecast_endpoint_shape(client, researcher_headers, seeded, scheduler):
    _train(scheduler)
    r = client.get(f"{API}/forecast/{seeded[0].id}", headers=researcher_headers)
    assert r.status_code == 200
    body = r.json()
    origin = date.fromisoformat(body["forecast_origin"])
    weeks = [date.fromisoformat(p["week_date"]) for p in body["points"]]
    assert weeks == [origin + timedelta(weeks=i) for i in range(1, 14)]
    assert all(p["predicted_liters"] >= 0 for p in body["points"])
    assert body["horizon_weeks"] == 13


@pytest.mark.parametrize("h", [0, 53, -1])
def test_horizon_bounds(client, researcher_headers, seeded, h):
    assert client.get(f"{API}/forecast/{seeded[0].id}?horizon_weeks={h}",
                      headers=researcher_headers).status_code == 422


def test_new_establishment_with_short_history_gets_clear_422(client, researcher_headers, seeded, db, scheduler):
    _train(scheduler)
    newbie = make_establishment(db, code="NEW1")
    r = client.get(f"{API}/forecast/{newbie.id}", headers=researcher_headers)
    assert r.status_code == 422 and "spanning at least 12 weeks" in r.json()["detail"]
    assert client.get(f"{API}/forecast/987654", headers=researcher_headers).status_code == 404


def test_aggregate_equals_sum_of_individual_forecasts(client, researcher_headers, seeded, db, scheduler):
    _train(scheduler)
    newbie = make_establishment(db, code="NEW2")   # no history → skipped, not an error
    r = client.get(f"{API}/forecast/aggregate?horizon_weeks=13", headers=researcher_headers)
    assert r.status_code == 200
    assert r.headers["X-Forecast-Included"] == "6" and r.headers["X-Forecast-Skipped"] == "0"
    agg = {p["week_date"]: p for p in r.json()}
    singles = [client.get(f"{API}/forecast/{e.id}", headers=researcher_headers).json() for e in seeded]
    for i in range(13):
        wk = singles[0]["points"][i]["week_date"]
        total = sum(s["points"][i]["predicted_liters"] for s in singles)
        assert agg[wk]["total_predicted_liters"] == pytest.approx(total, abs=0.2)
        assert agg[wk]["establishment_count"] == 6
    assert newbie.id  # (no records, so it never enters the aggregate)


def test_legacy_torch_weights_without_torch_give_clear_503(client, researcher_headers, seeded, db,
                                                           scheduler, monkeypatch):
    """A model stored before the NPZ change must not 500 on a torch-free API."""
    import io
    import sys

    import torch
    _train(scheduler)
    mv = db.scalar(select(ModelVersion).where(ModelVersion.is_active.is_(True)))
    buf = io.BytesIO()
    torch.save(build_model().state_dict(), buf)            # legacy torch.save() blob
    mv.weights = buf.getvalue()
    mv.weights_sha256 = model_store.sha256_hex(mv.weights)
    db.commit()
    model_store.invalidate_cache()
    shutil.rmtree(model_store.ARTIFACT_DIR / "versions", ignore_errors=True)
    monkeypatch.setitem(sys.modules, "torch", None)          # simulate the torch-free API
    r = client.get(f"{API}/forecast/{seeded[0].id}", headers=researcher_headers)
    assert r.status_code == 503 and "legacy PyTorch format" in r.json()["detail"]
    r = client.get(f"{API}/forecast/aggregate", headers=researcher_headers)
    assert r.status_code == 503
