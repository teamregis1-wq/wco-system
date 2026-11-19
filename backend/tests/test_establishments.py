"""Establishment CRUD, coordinate validation, and bulk import."""
from app.models.ml import ModelTrainingJob

API = "/api/v1"
BODY = {"wco_code": "RS900", "name": "Test Resto", "type": "restaurant",
        "latitude": 13.7565, "longitude": 121.0583, "barangay": "Poblacion"}


def test_create_read_update_soft_delete(client, admin_headers):
    r = client.post(f"{API}/establishments", headers=admin_headers, json=BODY)
    assert r.status_code == 201, r.text
    e = r.json()
    assert e["consent_given"] is False           # never assumed
    assert e["data_source"] == "unspecified"     # DEFAULT_DATA_SOURCE
    eid = e["id"]

    assert client.get(f"{API}/establishments/{eid}", headers=admin_headers).json()["name"] == "Test Resto"
    r = client.patch(f"{API}/establishments/{eid}", headers=admin_headers,
                     json={"name": "Renamed", "latitude": 13.76})
    assert r.status_code == 200 and r.json()["name"] == "Renamed" and r.json()["latitude"] == 13.76

    assert client.delete(f"{API}/establishments/{eid}", headers=admin_headers).status_code == 204
    assert client.get(f"{API}/establishments", headers=admin_headers).json() == []
    all_rows = client.get(f"{API}/establishments?active_only=false", headers=admin_headers).json()
    assert len(all_rows) == 1 and all_rows[0]["is_active"] is False   # soft delete keeps history


def test_researcher_cannot_hard_delete(client, researcher_headers, admin_headers):
    eid = client.post(f"{API}/establishments", headers=admin_headers, json=BODY).json()["id"]
    assert client.delete(f"{API}/establishments/{eid}", headers=researcher_headers).status_code == 403


def test_duplicate_code_rejected_case_insensitive(client, admin_headers):
    assert client.post(f"{API}/establishments", headers=admin_headers, json=BODY).status_code == 201
    dup = dict(BODY, wco_code="rs900")
    assert client.post(f"{API}/establishments", headers=admin_headers, json=dup).status_code == 409


def test_coordinate_validation(client, admin_headers):
    swapped = dict(BODY, latitude=121.0583, longitude=13.7565)
    r = client.post(f"{API}/establishments", headers=admin_headers, json=swapped)
    assert r.status_code == 422
    outside = dict(BODY, latitude=14.6, longitude=121.0)   # Manila
    r = client.post(f"{API}/establishments", headers=admin_headers, json=outside)
    assert r.status_code == 422 and "outside" in r.text
    assert client.post(f"{API}/establishments", headers=admin_headers,
                       json=dict(BODY, type="spaceship")).status_code == 422


def test_partial_update_checked_against_merged_row(client, admin_headers):
    eid = client.post(f"{API}/establishments", headers=admin_headers, json=BODY).json()["id"]
    r = client.patch(f"{API}/establishments/{eid}", headers=admin_headers, json={"longitude": 125.0})
    assert r.status_code == 422


def test_bulk_import_dedupes(client, admin_headers):
    client.post(f"{API}/establishments", headers=admin_headers, json=BODY)
    rows = [dict(BODY, wco_code="RS900"),            # exists
            dict(BODY, wco_code="FF001", type="fast_food"),
            dict(BODY, wco_code="ff001", type="fast_food")]   # duplicate within request
    r = client.post(f"{API}/establishments/bulk", headers=admin_headers, json=rows)
    assert r.status_code == 201
    assert r.json() == {"imported": 1, "skipped": 1, "duplicates_in_request": 1}


def test_creating_establishment_does_not_trigger_retraining(client, admin_headers, db):
    client.post(f"{API}/establishments", headers=admin_headers, json=BODY)
    assert db.query(ModelTrainingJob).count() == 0


def test_deactivation_triggers_retraining(client, admin_headers, db):
    eid = client.post(f"{API}/establishments", headers=admin_headers, json=BODY).json()["id"]
    client.patch(f"{API}/establishments/{eid}", headers=admin_headers, json={"is_active": False})
    job = db.query(ModelTrainingJob).one()
    assert job.status == "pending" and job.reason == "establishment.deactivate"
