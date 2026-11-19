"""Authentication and authorization."""
from datetime import datetime, timedelta, timezone

import pytest
from jose import jwt

from app.core.config import Settings, settings

API = "/api/v1"


def test_public_registration_creates_viewer(client):
    r = client.post(f"{API}/auth/register", json={
        "email": "New.User@Example.com", "full_name": "New User", "password": "longenough"})
    assert r.status_code == 201, r.text
    assert r.json()["role"] == "viewer"
    assert r.json()["email"] == "new.user@example.com"


@pytest.mark.parametrize("role", ["admin", "researcher", "superuser"])
def test_public_registration_cannot_assign_privileged_role(client, role):
    r = client.post(f"{API}/auth/register", json={
        "email": f"{role}x@example.com", "full_name": "X", "password": "longenough", "role": role})
    assert r.status_code == 403
    # And nothing was created.
    assert client.post(f"{API}/auth/login", data={
        "username": f"{role}x@example.com", "password": "longenough"}).status_code == 401


def test_duplicate_email_case_insensitive(client):
    body = {"email": "dup@example.com", "full_name": "A", "password": "longenough"}
    assert client.post(f"{API}/auth/register", json=body).status_code == 201
    body["email"] = "DUP@example.com"
    assert client.post(f"{API}/auth/register", json=body).status_code == 400


def test_login_and_me(client):
    client.post(f"{API}/auth/register", json={
        "email": "u@example.com", "full_name": "U", "password": "longenough"})
    r = client.post(f"{API}/auth/login", data={"username": "U@example.com", "password": "longenough"})
    assert r.status_code == 200
    tok = r.json()["access_token"]
    me = client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {tok}"})
    assert me.status_code == 200 and me.json()["role"] == "viewer"
    assert client.post(f"{API}/auth/login", data={
        "username": "u@example.com", "password": "wrongpass"}).status_code == 401


def test_admin_can_create_privileged_user(client, admin_headers):
    r = client.post(f"{API}/auth/users", headers=admin_headers, json={
        "email": "r2@example.com", "full_name": "R2", "password": "longenough", "role": "researcher"})
    assert r.status_code == 201 and r.json()["role"] == "researcher"


@pytest.mark.parametrize("fixture", ["researcher_headers", "viewer_headers"])
def test_non_admin_cannot_create_users(client, request, fixture):
    headers = request.getfixturevalue(fixture)
    r = client.post(f"{API}/auth/users", headers=headers, json={
        "email": "x@example.com", "full_name": "X", "password": "longenough", "role": "admin"})
    assert r.status_code == 403


def test_role_update_validates_role(client, admin_headers, viewer_headers):
    users = client.get(f"{API}/auth/users", headers=admin_headers).json()
    viewer = next(u for u in users if u["role"] == "viewer")
    assert client.patch(f"{API}/auth/users/{viewer['id']}/role", headers=admin_headers,
                        json={"role": "root"}).status_code == 422
    r = client.patch(f"{API}/auth/users/{viewer['id']}/role", headers=admin_headers,
                     json={"role": "researcher"})
    assert r.status_code == 200 and r.json()["role"] == "researcher"


def test_role_comes_from_database_not_token(client, viewer_headers):
    # A viewer token cannot be used for writes even though it is valid.
    r = client.post(f"{API}/establishments", headers=viewer_headers, json={
        "wco_code": "V1", "name": "V", "type": "restaurant", "latitude": 13.75, "longitude": 121.05})
    assert r.status_code == 403


@pytest.mark.parametrize("token", [
    "not-a-jwt",
    jwt.encode({"sub": "abc", "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
               settings.jwt_secret, algorithm="HS256"),
    jwt.encode({"sub": "1", "exp": datetime.now(timezone.utc) - timedelta(hours=1)},
               settings.jwt_secret, algorithm="HS256"),
    # Signed with the old public default secret → must be rejected.
    jwt.encode({"sub": "1", "role": "admin", "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
               "CHANGE_ME_dev_only_secret", algorithm="HS256"),
])
def test_invalid_tokens_rejected(client, admin_headers, token):
    r = client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_unauthenticated_requests_rejected(client):
    for path in ["/establishments", "/wco/summary", "/gis/hotspots", "/forecast/training-status"]:
        assert client.get(f"{API}{path}").status_code == 401, path


def test_viewer_cannot_save_or_delete_routes(client, viewer_headers, researcher_headers):
    body = {"name": "R", "depot_name": "D", "depot_lat": 13.75, "depot_lng": 121.05,
            "total_distance_km": 1, "total_establishments": 1, "total_wco_liters": 1,
            "estimated_duration_min": 2, "algorithm": "x", "stops_json": [], "geometry_json": []}
    assert client.post(f"{API}/routes/saved", headers=viewer_headers, json=body).status_code == 403
    r = client.post(f"{API}/routes/saved", headers=researcher_headers, json=body)
    assert r.status_code == 201
    assert client.delete(f"{API}/routes/saved/{r.json()['id']}", headers=viewer_headers).status_code == 403
    assert client.get(f"{API}/routes/saved", headers=viewer_headers).status_code == 200


def test_viewer_cannot_train(client, viewer_headers):
    assert client.post(f"{API}/forecast/train", headers=viewer_headers).status_code == 403


@pytest.mark.parametrize("secret", ["CHANGE_ME_dev_only_secret", "short", ""])
def test_settings_reject_weak_jwt_secret(secret):
    with pytest.raises(Exception):
        Settings(database_url="sqlite://", jwt_secret=secret, _env_file=None)


def test_admin_only_endpoints(client, researcher_headers):
    for path in ["/auth/users", "/auth/audit-logs", "/auth/system-stats"]:
        assert client.get(f"{API}{path}", headers=researcher_headers).status_code == 403


# ── Passwords: self-service change and admin reset ──────────────────────────────

def _register_and_login(client, email="pw@example.com", password="original-pass"):
    client.post(f"{API}/auth/register", json={"email": email, "full_name": "Pw", "password": password})
    r = client.post(f"{API}/auth/login", data={"username": email, "password": password})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _login_status(client, email, password):
    return client.post(f"{API}/auth/login", data={"username": email, "password": password}).status_code


def test_user_changes_own_password_and_old_sessions_end(client):
    old_session = _register_and_login(client)
    other_device = _register_and_login(client)

    r = client.patch(f"{API}/auth/me/password", headers=old_session,
                     json={"current_password": "wrong-pass", "new_password": "brand-new-pass"})
    assert r.status_code == 400 and "incorrect" in r.json()["detail"]
    r = client.patch(f"{API}/auth/me/password", headers=old_session,
                     json={"current_password": "original-pass", "new_password": "original-pass"})
    assert r.status_code == 400 and "different" in r.json()["detail"]
    r = client.patch(f"{API}/auth/me/password", headers=old_session,
                     json={"current_password": "original-pass", "new_password": "short"})
    assert r.status_code == 422

    r = client.patch(f"{API}/auth/me/password", headers=old_session,
                     json={"current_password": "original-pass", "new_password": "brand-new-pass"})
    assert r.status_code == 200
    fresh = {"Authorization": f"Bearer {r.json()['access_token']}"}

    assert client.get(f"{API}/auth/me", headers=fresh).status_code == 200          # this device stays in
    for stale in (old_session, other_device):                                      # every older token ends
        r = client.get(f"{API}/auth/me", headers=stale)
        assert r.status_code == 401 and "password was changed" in r.json()["detail"]
    assert _login_status(client, "pw@example.com", "original-pass") == 401
    assert _login_status(client, "pw@example.com", "brand-new-pass") == 200


def test_admin_resets_another_users_password(client, admin_headers):
    victim = _register_and_login(client, "forgot@example.com", "forgotten-pass")
    users = client.get(f"{API}/auth/users", headers=admin_headers).json()
    uid = next(u["id"] for u in users if u["email"] == "forgot@example.com")

    r = client.patch(f"{API}/auth/users/{uid}/password", headers=admin_headers,
                     json={"new_password": "reset-by-admin"})
    assert r.status_code == 200
    assert client.get(f"{API}/auth/me", headers=victim).status_code == 401
    assert _login_status(client, "forgot@example.com", "reset-by-admin") == 200
    assert _login_status(client, "forgot@example.com", "forgotten-pass") == 401

    logs = client.get(f"{API}/auth/audit-logs", headers=admin_headers).json()
    entry = next(l for l in logs if "password reset" in (l.get("details") or ""))
    assert "reset-by-admin" not in str(entry)                                       # never logged

    assert client.patch(f"{API}/auth/users/999999/password", headers=admin_headers,
                        json={"new_password": "whatever-123"}).status_code == 404
    assert client.patch(f"{API}/auth/users/{uid}/password", headers=admin_headers,
                        json={"new_password": "short"}).status_code == 422


def test_admin_reset_rules(client, admin_headers, researcher_headers, viewer_headers):
    me = client.get(f"{API}/auth/me", headers=admin_headers).json()
    r = client.patch(f"{API}/auth/users/{me['id']}/password", headers=admin_headers,
                     json={"new_password": "new-admin-pass"})
    assert r.status_code == 400 and "Change password" in r.json()["detail"]
    for headers in (researcher_headers, viewer_headers):
        assert client.patch(f"{API}/auth/users/{me['id']}/password", headers=headers,
                            json={"new_password": "hijack-attempt"}).status_code == 403


def test_token_without_password_fingerprint_is_rejected(client, admin_headers):
    me = client.get(f"{API}/auth/me", headers=admin_headers).json()
    legacy = jwt.encode({"sub": str(me["id"]), "role": "admin",
                         "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                        settings.jwt_secret, algorithm="HS256")
    assert client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {legacy}"}).status_code == 401
