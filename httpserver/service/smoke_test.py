#!/usr/bin/env python3
"""Black-box smoke test for a fresh Koodo self-hosted service instance."""

import json
import sys
import urllib.error
import urllib.request


BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8081").rstrip("/")


def request(method, path, body=None, headers=None):
    payload = None if body is None else json.dumps(body).encode("utf-8")
    request_headers = {"Accept": "application/json", **(headers or {})}
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        BASE_URL + path,
        data=payload,
        headers=request_headers,
        method=method,
    )
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read().decode("utf-8")
    data = json.loads(raw) if raw else None
    return response.status, data, response.headers


def expect_status(actual, expected, label):
    assert actual == expected, f"{label}: expected {expected}, got {actual}"


def api(method, path, body=None, token=None, expected=200):
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    status, payload, _ = request(method, path, body, headers)
    expect_status(status, expected, path)
    assert isinstance(payload, dict), f"{path}: invalid JSON response"
    assert payload.get("code") == expected, f"{path}: unexpected envelope {payload}"
    return payload.get("data")


def login(username, password):
    return api(
        "POST",
        "/v1/auth/login",
        {"username": username, "password": password, "device": "api-smoke-test"},
    )


def main():
    health = api("GET", "/v1/health")
    assert health["version"] == "0.3.0"
    assert {"sync.data", "sync.koreader", "storage.files"}.issubset(
        health["capabilities"]
    )

    config = api("GET", "/v1/auth/config")
    assert config["registration_mode"] == "bootstrap"
    registered = api(
        "POST",
        "/v1/auth/register",
        {"username": "api-admin", "password": "password-123", "invite_code": ""},
    )
    assert registered["role"] == "admin"

    admin_session = login("api-admin", "password-123")
    admin_access = admin_session["access_token"]
    admin_refresh = admin_session["refresh_token"]
    me = api("GET", "/v1/auth/me", token=admin_access)
    assert me["role"] == "admin"

    admin_config = api(
        "PUT",
        "/v1/admin/config",
        {"registration_mode": "invite", "service_name": "API Test Service"},
        token=admin_access,
    )
    assert admin_config["service_name"] == "API Test Service"
    invite_data = api(
        "POST",
        "/v1/admin/invites",
        {"count": 2, "expires_in_days": 1},
        token=admin_access,
    )
    invites = invite_data["codes"]

    accounts = [
        ("api-reader-a", "content-a", invites[0]),
        ("api-reader-b", "content-b", invites[1]),
    ]
    sessions = {}
    for username, content, invite in accounts:
        created = api(
            "POST",
            "/v1/auth/register",
            {"username": username, "password": "password-123", "invite_code": invite},
        )
        assert created["role"] == "user"
        sessions[username] = login(username, "password-123")
        saved = api(
            "PUT",
            "/v1/sync",
            {
                "items": {"notes": content},
                "versions": {"notes": 0},
                "user_id": "attempted-user-id-injection",
            },
            token=sessions[username]["access_token"],
        )
        assert saved["notes"]["version"] == 1

    for username, content, _ in accounts:
        stored = api(
            "GET",
            "/v1/sync/notes?user_id=another-account",
            token=sessions[username]["access_token"],
        )
        assert stored["content"] == content
        assert stored["version"] == 1

    api(
        "PUT",
        "/v1/sync",
        {"items": {"notes": "stale-write"}, "versions": {"notes": 0}},
        token=sessions["api-reader-a"]["access_token"],
        expected=409,
    )
    api(
        "POST",
        "/v1/auth/register",
        {"username": "api-reused", "password": "password-123", "invite_code": invites[0]},
        expected=422,
    )
    api("GET", "/v1/admin/users", token=sessions["api-reader-a"]["access_token"], expected=403)

    rotated = api("POST", "/v1/auth/refresh", {"refresh_token": admin_refresh})
    assert rotated["access_token"] != admin_access
    assert rotated["refresh_token"] != admin_refresh
    api("POST", "/v1/auth/refresh", {"refresh_token": admin_refresh}, expected=401)
    api("POST", "/v1/auth/logout", token=rotated["access_token"])
    api("GET", "/v1/auth/me", token=rotated["access_token"], expected=401)

    for username, progress in (("koreader-a", "page-a"), ("koreader-b", "page-b")):
        status, _, _ = request(
            "POST", "/users/create", {"username": username, "password": "test-hash"}
        )
        expect_status(status, 201, f"create {username}")
        auth_headers = {"x-auth-user": username, "x-auth-key": "test-hash"}
        status, _, _ = request(
            "PUT",
            "/syncs/progress",
            {
                "document": "same-book",
                "progress": progress,
                "percentage": 0.5,
                "device": username,
                "device_id": f"{username}-device",
            },
            auth_headers,
        )
        expect_status(status, 200, f"save {username}")
        status, stored, _ = request("GET", "/syncs/progress/same-book", headers=auth_headers)
        expect_status(status, 200, f"read {username}")
        assert stored["progress"] == progress

    status, state, _ = request("GET", "/healthcheck")
    expect_status(status, 200, "KOReader healthcheck")
    assert state["state"] == "OK"

    status, _, headers = request(
        "GET", "/v1/health", headers={"Origin": "https://example.invalid"}
    )
    expect_status(status, 200, "foreign-origin health")
    assert "Access-Control-Allow-Origin" not in headers

    print("PASS: auth, admin, invite, refresh, isolation, versioning, KOReader, and CORS")


if __name__ == "__main__":
    main()
