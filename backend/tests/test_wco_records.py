"""Weekly WCO record CRUD, bulk import, and invalid / duplicate data rejection."""
from datetime import date, timedelta

import pytest

from conftest import make_establishment

API = "/api/v1"
MONDAY = date.today() - timedelta(days=date.today().weekday() + 14)


@pytest.fixture
def estab(db):
    return make_establishment(db)


def rec(estab_id, week=MONDAY, qty=42.5, **kw):
    return {"establishment_id": estab_id, "week_date": str(week), "quantity_liters": qty, **kw}


def test_create_list_update_delete(client, researcher_headers, estab):
    r = client.post(f"{API}/wco/records", headers=researcher_headers, json=rec(estab.id))
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert r.json()["data_source"] == "unspecified"

    rows = client.get(f"{API}/wco/records?establishment_id={estab.id}", headers=researcher_headers).json()
    assert [x["id"] for x in rows] == [rid]

    r = client.patch(f"{API}/wco/records/{rid}", headers=researcher_headers,
                     json={"quantity_liters": 50, "data_source": "synthetic"})
    assert r.status_code == 200
    assert r.json()["quantity_liters"] == 50 and r.json()["data_source"] == "synthetic"
    assert r.json()["updated_at"] is not None

    assert client.delete(f"{API}/wco/records/{rid}", headers=researcher_headers).status_code == 204
    assert client.get(f"{API}/wco/records?establishment_id={estab.id}",
                      headers=researcher_headers).json() == []


def test_duplicate_establishment_week_rejected(client, researcher_headers, estab):
    assert client.post(f"{API}/wco/records", headers=researcher_headers, json=rec(estab.id)).status_code == 201
    r = client.post(f"{API}/wco/records", headers=researcher_headers, json=rec(estab.id, qty=10))
    assert r.status_code == 409


def test_database_enforces_uniqueness(db, estab):
    """Even if the API check were bypassed, the unique constraint holds."""
    from sqlalchemy.exc import IntegrityError

    from app.models import WCOGenerationRecord
    db.add_all([WCOGenerationRecord(establishment_id=estab.id, week_date=MONDAY, quantity_liters=1),
                WCOGenerationRecord(establishment_id=estab.id, week_date=MONDAY, quantity_liters=2)])
    with pytest.raises(IntegrityError):
        db.commit()


@pytest.mark.parametrize("raw_qty", ["-1", "NaN", "Infinity", "-Infinity", "10001", "1e309"])
def test_invalid_quantities_rejected(client, researcher_headers, estab, raw_qty):
    # Raw JSON so NaN/Infinity literals reach the server exactly as a client could send them.
    body = ('{"establishment_id": %d, "week_date": "%s", "quantity_liters": %s}'
            % (estab.id, MONDAY, raw_qty))
    r = client.post(f"{API}/wco/records", headers={**researcher_headers, "Content-Type": "application/json"},
                    content=body)
    assert r.status_code == 422, (raw_qty, r.text)


def test_database_check_rejects_negative(db, estab):
    from sqlalchemy.exc import IntegrityError

    from app.models import WCOGenerationRecord
    db.add(WCOGenerationRecord(establishment_id=estab.id, week_date=MONDAY, quantity_liters=-5))
    with pytest.raises(IntegrityError):
        db.commit()


def test_future_week_and_bad_end_date_rejected(client, researcher_headers, estab):
    future = date.today() + timedelta(days=10)
    assert client.post(f"{API}/wco/records", headers=researcher_headers,
                       json=rec(estab.id, week=future)).status_code == 422
    bad_end = rec(estab.id, week_end_date=str(MONDAY - timedelta(days=1)))
    assert client.post(f"{API}/wco/records", headers=researcher_headers, json=bad_end).status_code == 422


def test_unknown_or_inactive_establishment(client, researcher_headers, db):
    assert client.post(f"{API}/wco/records", headers=researcher_headers, json=rec(99999)).status_code == 404
    inactive = make_establishment(db, code="OLD1", active=False)
    assert client.post(f"{API}/wco/records", headers=researcher_headers,
                       json=rec(inactive.id)).status_code == 409


def test_update_validation(client, researcher_headers, estab):
    a = client.post(f"{API}/wco/records", headers=researcher_headers, json=rec(estab.id)).json()
    client.post(f"{API}/wco/records", headers=researcher_headers,
                json=rec(estab.id, week=MONDAY - timedelta(weeks=1)))
    # Negative via PATCH (previously unvalidated)
    assert client.patch(f"{API}/wco/records/{a['id']}", headers=researcher_headers,
                        json={"quantity_liters": -3}).status_code == 422
    # Explicit null
    assert client.patch(f"{API}/wco/records/{a['id']}", headers=researcher_headers,
                        json={"quantity_liters": None}).status_code == 422
    # Moving onto an existing week
    assert client.patch(f"{API}/wco/records/{a['id']}", headers=researcher_headers,
                        json={"week_date": str(MONDAY - timedelta(weeks=1))}).status_code == 409
    # End date before (unchanged) start date
    assert client.patch(f"{API}/wco/records/{a['id']}", headers=researcher_headers,
                        json={"week_end_date": str(MONDAY - timedelta(days=3))}).status_code == 422


def test_viewer_cannot_write(client, viewer_headers, estab):
    assert client.post(f"{API}/wco/records", headers=viewer_headers, json=rec(estab.id)).status_code == 403


def test_bulk_import_rejects_duplicates_without_overwriting(client, researcher_headers, estab):
    client.post(f"{API}/wco/records", headers=researcher_headers, json=rec(estab.id, qty=11))
    rows = [rec(estab.id, qty=99),                                  # exists → skipped, not overwritten
            rec(estab.id, week=MONDAY - timedelta(weeks=1), qty=20),
            rec(estab.id, week=MONDAY - timedelta(weeks=1), qty=21),  # duplicate inside the file
            rec(estab.id, week=MONDAY - timedelta(weeks=2), qty=22, data_source="synthetic")]
    r = client.post(f"{API}/wco/records/bulk", headers=researcher_headers, json=rows)
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["imported"], body["skipped"], body["duplicates_in_request"]) == (2, 1, 1)
    assert body["retraining_job_id"] is not None

    stored = {x["week_date"]: x for x in client.get(
        f"{API}/wco/records?establishment_id={estab.id}", headers=researcher_headers).json()}
    assert stored[str(MONDAY)]["quantity_liters"] == 11          # original kept
    assert stored[str(MONDAY - timedelta(weeks=1))]["quantity_liters"] == 20
    assert stored[str(MONDAY - timedelta(weeks=2))]["data_source"] == "synthetic"


def test_bulk_import_is_all_or_nothing_on_invalid_row(client, researcher_headers, estab):
    rows = [rec(estab.id, qty=10), rec(estab.id, week=MONDAY - timedelta(weeks=1), qty=-1)]
    assert client.post(f"{API}/wco/records/bulk", headers=researcher_headers, json=rows).status_code == 422
    assert client.get(f"{API}/wco/records?establishment_id={estab.id}",
                      headers=researcher_headers).json() == []


def test_bulk_import_unknown_establishment(client, researcher_headers):
    r = client.post(f"{API}/wco/records/bulk", headers=researcher_headers, json=[rec(424242)])
    assert r.status_code == 404


def test_summary_reports_data_source_counts(client, researcher_headers, estab):
    client.post(f"{API}/wco/records", headers=researcher_headers, json=rec(estab.id, data_source="synthetic"))
    s = client.get(f"{API}/wco/summary", headers=researcher_headers).json()
    assert s["data_source_counts"] == {"synthetic": 1}


def test_quality_test_validation(client, researcher_headers, estab):
    body = {"establishment_id": estab.id, "sample_date": str(MONDAY),
            "ffa_pct": 2.1, "viscosity_cp": 35, "density_gml": 0.9}
    assert client.post(f"{API}/quality-tests", headers=researcher_headers, json=body).status_code == 201
    assert client.post(f"{API}/quality-tests", headers=researcher_headers,
                       json=dict(body, ffa_pct=-1)).status_code == 422
    assert client.post(f"{API}/quality-tests", headers=researcher_headers,
                       json=dict(body, establishment_id=999999)).status_code == 404


def test_current_in_progress_week_can_be_recorded(client, researcher_headers, estab):
    """The week that started this week may be entered even though it ends in the future."""
    monday = date.today() - timedelta(days=date.today().weekday())
    r = client.post(f"{API}/wco/records", headers=researcher_headers,
                    json=rec(estab.id, week=monday, week_end_date=str(monday + timedelta(days=6))))
    assert r.status_code == 201, r.text
    too_long = rec(estab.id, week=monday - timedelta(weeks=3),
                   week_end_date=str(monday + timedelta(days=30)))
    assert client.post(f"{API}/wco/records", headers=researcher_headers, json=too_long).status_code == 422
