package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func openTestDatabase(t *testing.T) {
	t.Helper()
	t.Setenv("SERVICE_DB", filepath.Join(t.TempDir(), "service.db"))
	var err error
	if db != nil {
		_ = db.Close()
	}
	if err = openDatabase(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
}

func request(t *testing.T, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var payload *bytes.Reader
	if body == nil {
		payload = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		payload = bytes.NewReader(encoded)
	}
	req := httptest.NewRequest(method, path, payload)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res := httptest.NewRecorder()
	route(res, req)
	return res
}

func decodeAPIResponse(t *testing.T, res *httptest.ResponseRecorder) apiResponse {
	t.Helper()
	var payload apiResponse
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode API response (%d): %v: %s", res.Code, err, res.Body.String())
	}
	return payload
}

func responseDataMap(t *testing.T, res *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	payload := decodeAPIResponse(t, res)
	data, ok := payload.Data.(map[string]any)
	if !ok {
		t.Fatalf("expected response data object, got %#v", payload.Data)
	}
	return data
}

func registerAccount(t *testing.T, username, password, invite string) *httptest.ResponseRecorder {
	t.Helper()
	return request(t, http.MethodPost, "/v1/auth/register", map[string]string{
		"username": username, "password": password, "invite_code": invite,
	}, nil)
}

func loginAccount(t *testing.T, username, password string) map[string]any {
	t.Helper()
	res := request(t, http.MethodPost, "/v1/auth/login", map[string]string{
		"username": username, "password": password,
	}, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("login %s: %d %s", username, res.Code, res.Body.String())
	}
	return responseDataMap(t, res)
}

func bearer(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

func createInvites(t *testing.T, accessToken string, count int) []string {
	t.Helper()
	res := request(t, http.MethodPost, "/v1/admin/invites", map[string]int{
		"count": count, "expires_in_days": 7,
	}, bearer(accessToken))
	if res.Code != http.StatusOK {
		t.Fatalf("create invites: %d %s", res.Code, res.Body.String())
	}
	data := responseDataMap(t, res)
	rawCodes, ok := data["codes"].([]any)
	if !ok || len(rawCodes) != count {
		t.Fatalf("unexpected invite response: %#v", data)
	}
	codes := make([]string, 0, len(rawCodes))
	for _, raw := range rawCodes {
		codes = append(codes, raw.(string))
	}
	return codes
}

func TestCORSOnlyAllowsSameHostOrConfiguredOrigin(t *testing.T) {
	openTestDatabase(t)

	foreign := httptest.NewRequest(http.MethodGet, "https://rd.ouo.gs/v1/health", nil)
	foreign.Host = "rd.ouo.gs"
	foreign.Header.Set("Origin", "https://example.invalid")
	foreignRes := httptest.NewRecorder()
	route(foreignRes, foreign)
	if got := foreignRes.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("foreign origin unexpectedly allowed: %q", got)
	}

	same := httptest.NewRequest(http.MethodGet, "https://rd.ouo.gs/v1/health", nil)
	same.Host = "rd.ouo.gs"
	same.Header.Set("Origin", "https://rd.ouo.gs")
	sameRes := httptest.NewRecorder()
	route(sameRes, same)
	if got := sameRes.Header().Get("Access-Control-Allow-Origin"); got != "https://rd.ouo.gs" {
		t.Fatalf("same origin not allowed: %q", got)
	}
}

func TestAuthenticationAndAdminLifecycle(t *testing.T) {
	openTestDatabase(t)

	config := request(t, http.MethodGet, "/v1/auth/config", nil, nil)
	if mode := responseDataMap(t, config)["registration_mode"]; mode != "bootstrap" {
		t.Fatalf("empty service should allow bootstrap, got %#v", mode)
	}

	created := registerAccount(t, "first-admin", "password-123", "")
	if created.Code != http.StatusOK || responseDataMap(t, created)["role"] != "admin" {
		t.Fatalf("first account was not admin: %d %s", created.Code, created.Body.String())
	}

	session := loginAccount(t, "first-admin", "password-123")
	access := session["access_token"].(string)
	refresh := session["refresh_token"].(string)
	me := request(t, http.MethodGet, "/v1/auth/me", nil, bearer(access))
	if me.Code != http.StatusOK || responseDataMap(t, me)["role"] != "admin" {
		t.Fatalf("admin identity unavailable: %d %s", me.Code, me.Body.String())
	}

	updated := request(t, http.MethodPut, "/v1/admin/config", map[string]string{
		"registration_mode": "admin", "service_name": "Private Reader",
	}, bearer(access))
	if updated.Code != http.StatusOK || responseDataMap(t, updated)["service_name"] != "Private Reader" {
		t.Fatalf("admin config update failed: %d %s", updated.Code, updated.Body.String())
	}

	rotated := request(t, http.MethodPost, "/v1/auth/refresh", map[string]string{"refresh_token": refresh}, nil)
	if rotated.Code != http.StatusOK {
		t.Fatalf("refresh failed: %d %s", rotated.Code, rotated.Body.String())
	}
	rotatedData := responseDataMap(t, rotated)
	newAccess := rotatedData["access_token"].(string)
	newRefresh := rotatedData["refresh_token"].(string)
	if newAccess == access || newRefresh == refresh {
		t.Fatal("refresh did not rotate both tokens")
	}
	oldRefresh := request(t, http.MethodPost, "/v1/auth/refresh", map[string]string{"refresh_token": refresh}, nil)
	if oldRefresh.Code != http.StatusUnauthorized {
		t.Fatalf("old refresh token remained valid: %d %s", oldRefresh.Code, oldRefresh.Body.String())
	}

	logout := request(t, http.MethodPost, "/v1/auth/logout", nil, bearer(newAccess))
	if logout.Code != http.StatusOK {
		t.Fatalf("logout failed: %d %s", logout.Code, logout.Body.String())
	}
	afterLogout := request(t, http.MethodGet, "/v1/auth/me", nil, bearer(newAccess))
	if afterLogout.Code != http.StatusUnauthorized {
		t.Fatalf("logged-out access token remained valid: %d", afterLogout.Code)
	}
}

func TestSyncDataIsIsolatedAndVersioned(t *testing.T) {
	openTestDatabase(t)
	if res := registerAccount(t, "sync-admin", "password-123", ""); res.Code != http.StatusOK {
		t.Fatalf("bootstrap admin: %d %s", res.Code, res.Body.String())
	}
	admin := loginAccount(t, "sync-admin", "password-123")
	adminAccess := admin["access_token"].(string)
	invites := createInvites(t, adminAccess, 2)

	accounts := []struct {
		username string
		content  string
		invite   string
	}{
		{"sync-reader-a", `{"owner":"a"}`, invites[0]},
		{"sync-reader-b", `{"owner":"b"}`, invites[1]},
	}
	tokens := make(map[string]string, len(accounts))
	for _, account := range accounts {
		if res := registerAccount(t, account.username, "password-123", account.invite); res.Code != http.StatusOK {
			t.Fatalf("register %s: %d %s", account.username, res.Code, res.Body.String())
		}
		session := loginAccount(t, account.username, "password-123")
		tokens[account.username] = session["access_token"].(string)
		res := request(t, http.MethodPut, "/v1/sync", map[string]any{
			"items": map[string]string{"notes": account.content},
			"versions": map[string]int64{"notes": 0},
			"user_id": "must-be-ignored",
		}, bearer(tokens[account.username]))
		if res.Code != http.StatusOK {
			t.Fatalf("save %s: %d %s", account.username, res.Code, res.Body.String())
		}
	}

	for _, account := range accounts {
		res := request(t, http.MethodGet, "/v1/sync/notes?user_id=someone-else", nil, bearer(tokens[account.username]))
		if res.Code != http.StatusOK {
			t.Fatalf("read %s: %d %s", account.username, res.Code, res.Body.String())
		}
		data := responseDataMap(t, res)
		if data["content"] != account.content || data["version"] != float64(1) {
			t.Fatalf("%s read another account or wrong version: %#v", account.username, data)
		}
	}

	conflict := request(t, http.MethodPut, "/v1/sync", map[string]any{
		"items": map[string]string{"notes": "stale"},
		"versions": map[string]int64{"notes": 0},
	}, bearer(tokens[accounts[0].username]))
	if conflict.Code != http.StatusConflict {
		t.Fatalf("stale version was accepted: %d %s", conflict.Code, conflict.Body.String())
	}

	userAdminCall := request(t, http.MethodGet, "/v1/admin/users", nil, bearer(tokens[accounts[0].username]))
	if userAdminCall.Code != http.StatusForbidden {
		t.Fatalf("regular user accessed admin API: %d", userAdminCall.Code)
	}
}

func TestInviteCanOnlyBeUsedOnceConcurrently(t *testing.T) {
	openTestDatabase(t)
	if res := registerAccount(t, "invite-admin", "password-123", ""); res.Code != http.StatusOK {
		t.Fatalf("bootstrap admin: %d %s", res.Code, res.Body.String())
	}
	admin := loginAccount(t, "invite-admin", "password-123")
	invite := createInvites(t, admin["access_token"].(string), 1)[0]

	var wg sync.WaitGroup
	results := make(chan int, 2)
	for _, username := range []string{"invite-reader-a", "invite-reader-b"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			results <- registerAccount(t, name, "password-123", invite).Code
		}(username)
	}
	wg.Wait()
	close(results)
	successes := 0
	for status := range results {
		if status == http.StatusOK {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("single-use invite produced %d successful registrations", successes)
	}

	expiredCode := "EXPIRED-INVITE"
	_, err := db.Exec(`INSERT INTO invites(code_hash,code_hint,created_by,created_at,expires_at) VALUES(?,?,?,?,?)`,
		tokenHash(expiredCode), "EXPI…VITE", responseDataMap(t, request(t, http.MethodGet, "/v1/auth/me", nil, bearer(admin["access_token"].(string))))["id"], time.Now().Add(-48*time.Hour).Unix(), time.Now().Add(-24*time.Hour).Unix())
	if err != nil {
		t.Fatal(err)
	}
	expired := registerAccount(t, "expired-reader", "password-123", expiredCode)
	if expired.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expired invite was accepted: %d %s", expired.Code, expired.Body.String())
	}
}

func TestKoreaderProgressIsIsolatedByAccount(t *testing.T) {
	openTestDatabase(t)
	users := []struct {
		name, password, progress string
		percentage               float64
	}{
		{"reader-a", "hash-a", "page-a", 0.2},
		{"reader-b", "hash-b", "page-b", 0.8},
	}
	for _, item := range users {
		created := request(t, http.MethodPost, "/users/create", map[string]string{
			"username": item.name, "password": item.password,
		}, nil)
		if created.Code != http.StatusCreated {
			t.Fatalf("create %s: %d %s", item.name, created.Code, created.Body.String())
		}
		headers := map[string]string{"x-auth-user": item.name, "x-auth-key": item.password}
		saved := request(t, http.MethodPut, "/syncs/progress", map[string]any{
			"document": "same-book", "progress": item.progress,
			"percentage": item.percentage, "device": item.name,
		}, headers)
		if saved.Code != http.StatusOK {
			t.Fatalf("save %s: %d %s", item.name, saved.Code, saved.Body.String())
		}
	}

	for _, item := range users {
		res := request(t, http.MethodGet, "/syncs/progress/same-book", nil, map[string]string{
			"x-auth-user": item.name, "x-auth-key": item.password,
		})
		if res.Code != http.StatusOK {
			t.Fatalf("read %s: %d %s", item.name, res.Code, res.Body.String())
		}
		var data map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		if data["progress"] != item.progress {
			t.Fatalf("%s read another account's progress: %#v", item.name, data)
		}
	}
}
