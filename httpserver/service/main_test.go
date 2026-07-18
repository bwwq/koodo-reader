package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
	rateMu.Lock()
	rateBuckets = map[string]*rateBucket{}
	rateMu.Unlock()
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

func TestSoNovelSearchAndImportStayBehindService(t *testing.T) {
	openTestDatabase(t)
	filesDir := t.TempDir()
	t.Setenv("SERVICE_FILES_DIR", filesDir)

	var mu sync.Mutex
	generated := false
	deleted := false
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sources":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "message": "OK", "data": []map[string]any{{"id": 1, "name": "Test Source"}}})
		case "/search/aggregated":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "message": "OK", "data": []map[string]any{{
				"sourceId": 1, "sourceName": "Test Source", "url": "https://books.example/book/1",
				"bookName": "测试书", "author": "作者", "latestChapter": "第十章",
			}}})
		case "/local-books":
			mu.Lock()
			ready := generated
			mu.Unlock()
			if ready {
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "message": "OK", "data": []map[string]any{{"name": "测试书(作者).epub", "size": 8, "timestamp": 2000}}})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "message": "OK", "data": []any{}})
			}
		case "/download-progress":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"type\":\"download-progress\",\"index\":10,\"total\":10}\n\n")
		case "/book-fetch":
			if r.URL.Query().Get("url") != "https://books.example/book/1" {
				t.Errorf("unexpected fetch URL: %s", r.URL.Query().Get("url"))
			}
			mu.Lock()
			generated = true
			mu.Unlock()
		case "/book-download":
			w.Header().Set("Content-Length", "8")
			_, _ = io.WriteString(w, "PK EPUB!")
		case "/book-delete":
			mu.Lock()
			deleted = true
			mu.Unlock()
			_, _ = io.WriteString(w, `{}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer engine.Close()
	t.Setenv("SONOVEL_ENGINE_URL", engine.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	source := bookSource{ID: sonovelBuiltInID, Type: "sonovel", Name: "So Novel 中文聚合（11 个站点）"}
	results, err := searchSoNovel(ctx, "user-a", source, "测试书", 1)
	if err != nil || len(results) != 1 {
		t.Fatalf("search So Novel: %v %#v", err, results)
	}
	if results[0].SourceName != "Test Source" || results[0].DownloadURL != "https://books.example/book/1" {
		t.Fatalf("unexpected normalized result: %#v", results[0])
	}

	registerAccount(t, "sonovel-admin", "password-123", "")
	var userID string
	if err := db.QueryRow(`SELECT id FROM users WHERE username=?`, "sonovel-admin").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if _, err := db.Exec(`INSERT INTO book_import_jobs(id,user_id,source_id,source_type,status,stage,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`, "sonovel-job", userID, sonovelBuiltInID, "sonovel", "running", "preparing", now, now, now+3600); err != nil {
		t.Fatal(err)
	}
	runSoNovelImport(ctx, "sonovel-job", userID, results[0])
	job, err := readImportJob(userID, "sonovel-job", false)
	if err != nil || job.Status != "ready" || !job.Ready {
		t.Fatalf("So Novel job not ready: %v %#v", err, job)
	}
	data, err := os.ReadFile(filepath.Join(filesDir, "generated", userID, "sonovel-job-测试书.epub"))
	if err != nil || string(data) != "PK EPUB!" {
		t.Fatalf("generated EPUB mismatch: %v %q", err, data)
	}
	mu.Lock()
	wasDeleted := deleted
	mu.Unlock()
	if !wasDeleted {
		t.Fatal("transient So Novel file was not deleted")
	}
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

	crossScheme := httptest.NewRequest(http.MethodGet, "https://rd.ouo.gs/v1/health", nil)
	crossScheme.Host = "rd.ouo.gs"
	crossScheme.Header.Set("X-Forwarded-Proto", "https")
	crossScheme.Header.Set("Origin", "http://rd.ouo.gs")
	crossSchemeRes := httptest.NewRecorder()
	route(crossSchemeRes, crossScheme)
	if got := crossSchemeRes.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("cross-scheme origin unexpectedly allowed: %q", got)
	}

	mobile := httptest.NewRequest(http.MethodOptions, "https://rd.ouo.gs/v1/auth/login", nil)
	mobile.Host = "rd.ouo.gs"
	mobile.Header.Set("X-Forwarded-Proto", "https")
	mobile.Header.Set("Origin", "https://localhost")
	mobileRes := httptest.NewRecorder()
	route(mobileRes, mobile)
	if got := mobileRes.Header().Get("Access-Control-Allow-Origin"); got != "https://localhost" {
		t.Fatalf("Capacitor origin not allowed: %q", got)
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
	createdUser := request(t, http.MethodPost, "/v1/admin/users", map[string]string{
		"username": "admin-created", "password": "password-456", "display_name": "Created User",
	}, bearer(access))
	if createdUser.Code != http.StatusOK || responseDataMap(t, createdUser)["role"] != "user" {
		t.Fatalf("admin could not create account: %d %s", createdUser.Code, createdUser.Body.String())
	}
	if session := loginAccount(t, "admin-created", "password-456"); session["access_token"] == "" {
		t.Fatal("admin-created account could not log in")
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

func TestAuthenticationRoutesAreRateLimited(t *testing.T) {
	openTestDatabase(t)
	for i := 0; i < 20; i++ {
		res := request(t, http.MethodPost, "/v1/auth/login", map[string]string{
			"username": "missing-user", "password": "password-123",
		}, nil)
		if res.Code == http.StatusTooManyRequests {
			t.Fatalf("rate limit activated too early at request %d", i+1)
		}
	}
	limited := request(t, http.MethodPost, "/v1/auth/login", map[string]string{
		"username": "missing-user", "password": "password-123",
	}, nil)
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("rate limit was not enforced: %d %s", limited.Code, limited.Body.String())
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
			"items":    map[string]string{"notes": account.content},
			"versions": map[string]int64{"notes": 0},
			"user_id":  "must-be-ignored",
		}, bearer(tokens[account.username]))
		if res.Code != http.StatusOK {
			t.Fatalf("save %s: %d %s", account.username, res.Code, res.Body.String())
		}
	}
	largePayload := strings.Repeat("x", 2<<20)
	large := request(t, http.MethodPut, "/v1/sync", map[string]any{
		"items":    map[string]string{"books": largePayload},
		"versions": map[string]int64{"books": 0},
	}, bearer(tokens[accounts[0].username]))
	if large.Code != http.StatusOK {
		t.Fatalf("sync payload above legacy 1 MiB limit failed: %d %s", large.Code, large.Body.String())
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
		"items":    map[string]string{"notes": "stale"},
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

func uploadStorageFile(t *testing.T, username, password, content string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "same-book.epub")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/upload?dir=book", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.SetBasicAuth(username, password)
	res := httptest.NewRecorder()
	route(res, req)
	return res
}

func downloadStorageFile(t *testing.T, username, password string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/download?dir=book&filename=same-book.epub", nil)
	req.SetBasicAuth(username, password)
	res := httptest.NewRecorder()
	route(res, req)
	return res
}

func TestFileStorageUsesServiceAccountsAndIsIsolated(t *testing.T) {
	openTestDatabase(t)
	t.Setenv("SERVICE_FILES_DIR", filepath.Join(t.TempDir(), "files"))
	if res := registerAccount(t, "files-admin", "password-123", ""); res.Code != http.StatusOK {
		t.Fatalf("bootstrap admin: %d %s", res.Code, res.Body.String())
	}
	admin := loginAccount(t, "files-admin", "password-123")
	created := request(t, http.MethodPost, "/v1/admin/users", map[string]string{
		"username": "files-user", "password": "password-456",
	}, bearer(admin["access_token"].(string)))
	if created.Code != http.StatusOK {
		t.Fatalf("create file user: %d %s", created.Code, created.Body.String())
	}

	if res := uploadStorageFile(t, "files-admin", "password-123", "admin-content"); res.Code != http.StatusOK {
		t.Fatalf("admin upload: %d %s", res.Code, res.Body.String())
	}
	if res := uploadStorageFile(t, "files-user", "password-456", "user-content"); res.Code != http.StatusOK {
		t.Fatalf("user upload: %d %s", res.Code, res.Body.String())
	}
	adminFile := downloadStorageFile(t, "files-admin", "password-123")
	userFile := downloadStorageFile(t, "files-user", "password-456")
	if adminFile.Code != http.StatusOK || adminFile.Body.String() != "admin-content" {
		t.Fatalf("admin file mismatch: %d %q", adminFile.Code, adminFile.Body.String())
	}
	if userFile.Code != http.StatusOK || userFile.Body.String() != "user-content" {
		t.Fatalf("user file mismatch: %d %q", userFile.Code, userFile.Body.String())
	}
	wrongPassword := downloadStorageFile(t, "files-user", "wrong-password")
	if wrongPassword.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password accessed storage: %d", wrongPassword.Code)
	}
}

func TestBookSourcesRequireLoginAndAreIsolated(t *testing.T) {
	openTestDatabase(t)
	if res := request(t, http.MethodGet, "/v1/book-sources", nil, nil); res.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated source list returned %d", res.Code)
	}
	if res := registerAccount(t, "source-admin", "password-123", ""); res.Code != http.StatusOK {
		t.Fatalf("bootstrap admin: %d %s", res.Code, res.Body.String())
	}
	admin := loginAccount(t, "source-admin", "password-123")
	adminToken := admin["access_token"].(string)
	created := request(t, http.MethodPost, "/v1/admin/users", map[string]string{
		"username": "source-user", "password": "password-456",
	}, bearer(adminToken))
	if created.Code != http.StatusOK {
		t.Fatalf("create source user: %d %s", created.Code, created.Body.String())
	}
	user := loginAccount(t, "source-user", "password-456")
	userToken := user["access_token"].(string)

	definitions := []struct {
		name, token string
	}{
		{"Admin source", adminToken},
		{"User source", userToken},
	}
	for _, item := range definitions {
		res := request(t, http.MethodPost, "/v1/book-sources/import", map[string]any{
			"bookSourceUrl":  "https://books.example/" + strings.ToLower(strings.ReplaceAll(item.name, " ", "-")),
			"bookSourceName": item.name,
			"searchUrl":      "/search?q={{key}}&page={{page}}",
		}, bearer(item.token))
		if res.Code != http.StatusOK {
			t.Fatalf("import %s: %d %s", item.name, res.Code, res.Body.String())
		}
	}

	adminList := request(t, http.MethodGet, "/v1/book-sources", nil, bearer(adminToken))
	userList := request(t, http.MethodGet, "/v1/book-sources", nil, bearer(userToken))
	if !strings.Contains(adminList.Body.String(), "Admin source") || strings.Contains(adminList.Body.String(), "User source") {
		t.Fatalf("admin source isolation failed: %s", adminList.Body.String())
	}
	if !strings.Contains(userList.Body.String(), "User source") || strings.Contains(userList.Body.String(), "Admin source") {
		t.Fatalf("user source isolation failed: %s", userList.Body.String())
	}
	var adminID, userID, sharedSourceID string
	if err := db.QueryRow(`SELECT id FROM users WHERE username='source-admin'`).Scan(&adminID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT id FROM book_sources WHERE user_id=? AND name='Admin source'`, adminID).Scan(&sharedSourceID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT id FROM users WHERE username='source-user'`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO shared_book_sources(source_id,updated_at) VALUES(?,?)`, sharedSourceID, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	userList = request(t, http.MethodGet, "/v1/book-sources", nil, bearer(userToken))
	if !strings.Contains(userList.Body.String(), "Admin source") || !strings.Contains(userList.Body.String(), `"shared":true`) {
		t.Fatalf("shared source was not visible: %s", userList.Body.String())
	}
	shared, err := loadAccessibleBookSource(userID, sharedSourceID)
	if err != nil || !shared.Shared || sourceNamespace("requesting-user", shared) != "shared-source:"+sharedSourceID {
		t.Fatalf("shared source namespace failed: %#v %v", shared, err)
	}
	patchShared := request(t, http.MethodPatch, "/v1/book-sources/"+sharedSourceID, map[string]any{"enabled": false}, bearer(userToken))
	if patchShared.Code != http.StatusForbidden {
		t.Fatalf("non-admin changed shared source: %d %s", patchShared.Code, patchShared.Body.String())
	}
	forbidden := request(t, http.MethodPost, "/v1/book-sources/import", map[string]any{
		"bookSourceUrl": "https://unsafe.example", "bookSourceName": "Unsafe",
		"searchUrl": "<js>Packages.java.lang.Runtime.getRuntime()</js>",
	}, bearer(adminToken))
	if forbidden.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unsafe source accepted: %d %s", forbidden.Code, forbidden.Body.String())
	}
	webview := request(t, http.MethodPost, "/v1/book-sources/import", map[string]any{
		"bookSourceUrl": "https://webview.example", "bookSourceName": "WebView",
		"searchUrl": `<js>try { Packages.example.Client } catch (e) {}; "https://webview.example/search,{'webView':true}"</js>`,
	}, bearer(adminToken))
	if webview.Code != http.StatusOK {
		t.Fatalf("sandboxed WebView source was rejected: %d %s", webview.Code, webview.Body.String())
	}
}

func TestBookSourceNetworkPolicyBlocksSpecialAddresses(t *testing.T) {
	blocked := []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "::1", "fd00::1"}
	for _, value := range blocked {
		if !blockedIP(net.ParseIP(value)) {
			t.Errorf("special address was not blocked: %s", value)
		}
	}
	if blockedIP(net.ParseIP("1.1.1.1")) {
		t.Fatal("public address was blocked")
	}
}

func TestSearchResultCacheIsAccountBound(t *testing.T) {
	item := cachedSearchResult{ID: "opaque-result", UserID: "user-a", ExpiresAt: time.Now().Add(time.Minute)}
	cacheSearchResult(item)
	if _, ok := getCachedResult("user-b", item.ID); ok {
		t.Fatal("another account could use cached search result")
	}
	cacheSearchResult(item)
	if _, ok := getCachedResult("user-a", item.ID); !ok {
		t.Fatal("owner could not use cached search result")
	}
}

func TestBookSubscriptionsAreStableAndAccountBound(t *testing.T) {
	openTestDatabase(t)
	if res := registerAccount(t, "tracking-admin", "password-123", ""); res.Code != http.StatusOK {
		t.Fatalf("bootstrap admin: %d %s", res.Code, res.Body.String())
	}
	admin := loginAccount(t, "tracking-admin", "password-123")
	created := request(t, http.MethodPost, "/v1/admin/users", map[string]string{
		"username": "tracking-user", "password": "password-456",
	}, bearer(admin["access_token"].(string)))
	if created.Code != http.StatusOK {
		t.Fatalf("create tracking user: %d %s", created.Code, created.Body.String())
	}
	user := loginAccount(t, "tracking-user", "password-456")

	for _, token := range []string{admin["access_token"].(string), user["access_token"].(string)} {
		res := request(t, http.MethodPost, "/v1/book-sources/import", map[string]any{
			"bookSourceUrl": "https://tracking.example", "bookSourceName": "Tracking source",
			"searchUrl": "/search?q={{key}}",
		}, bearer(token))
		if res.Code != http.StatusOK {
			t.Fatalf("import tracking source: %d %s", res.Code, res.Body.String())
		}
	}

	var adminID, userID, adminSourceID, userSourceID string
	_ = db.QueryRow(`SELECT id FROM users WHERE username='tracking-admin'`).Scan(&adminID)
	_ = db.QueryRow(`SELECT id FROM users WHERE username='tracking-user'`).Scan(&userID)
	_ = db.QueryRow(`SELECT id FROM book_sources WHERE user_id=?`, adminID).Scan(&adminSourceID)
	_ = db.QueryRow(`SELECT id FROM book_sources WHERE user_id=?`, userID).Scan(&userSourceID)
	adminResult := cachedSearchResult{SourceID: adminSourceID, SourceType: "legado", Title: "Tracked book", Raw: json.RawMessage(`{"name":"Tracked book","bookUrl":"https://tracking.example/book/1"}`)}
	adminSubscription, err := ensureBookSubscription(adminID, adminResult)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ensureBookSubscription(adminID, adminResult)
	if err != nil || second != adminSubscription {
		t.Fatalf("same book created duplicate subscriptions: %q %q %v", adminSubscription, second, err)
	}
	userResult := adminResult
	userResult.SourceID = userSourceID
	userSubscription, err := ensureBookSubscription(userID, userResult)
	if err != nil || userSubscription == adminSubscription {
		t.Fatalf("subscriptions were not account isolated: %q %q %v", adminSubscription, userSubscription, err)
	}

	adminList := request(t, http.MethodGet, "/v1/book-subscriptions", nil, bearer(admin["access_token"].(string)))
	userList := request(t, http.MethodGet, "/v1/book-subscriptions", nil, bearer(user["access_token"].(string)))
	if !strings.Contains(adminList.Body.String(), adminSubscription) || strings.Contains(adminList.Body.String(), userSubscription) {
		t.Fatalf("admin subscription isolation failed: %s", adminList.Body.String())
	}
	if !strings.Contains(userList.Body.String(), userSubscription) || strings.Contains(userList.Body.String(), adminSubscription) {
		t.Fatalf("user subscription isolation failed: %s", userList.Body.String())
	}
}

func TestBookImportRecoveryListIsAccountBound(t *testing.T) {
	openTestDatabase(t)
	if res := registerAccount(t, "imports-admin", "password-123", ""); res.Code != http.StatusOK {
		t.Fatalf("bootstrap admin: %d %s", res.Code, res.Body.String())
	}
	admin := loginAccount(t, "imports-admin", "password-123")
	created := request(t, http.MethodPost, "/v1/admin/users", map[string]string{
		"username": "imports-user", "password": "password-456",
	}, bearer(admin["access_token"].(string)))
	if created.Code != http.StatusOK {
		t.Fatalf("create user: %d %s", created.Code, created.Body.String())
	}
	user := loginAccount(t, "imports-user", "password-456")

	var adminID, userID string
	_ = db.QueryRow(`SELECT id FROM users WHERE username='imports-admin'`).Scan(&adminID)
	_ = db.QueryRow(`SELECT id FROM users WHERE username='imports-user'`).Scan(&userID)
	now := time.Now().Unix()
	for _, item := range []struct {
		id, owner string
	}{
		{"recover-admin-job", adminID},
		{"recover-user-job", userID},
	} {
		_, err := db.Exec(`INSERT INTO book_import_jobs(id,user_id,source_id,source_type,status,stage,current,total,created_at,updated_at,expires_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?)`, item.id, item.owner, "source", "legado", "ready", "ready", 12, 12, now, now, now+3600)
		if err != nil {
			t.Fatal(err)
		}
	}

	unauthenticated := request(t, http.MethodGet, "/v1/book-imports", nil, nil)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated import list: %d", unauthenticated.Code)
	}
	adminList := request(t, http.MethodGet, "/v1/book-imports", nil, bearer(admin["access_token"].(string)))
	userList := request(t, http.MethodGet, "/v1/book-imports", nil, bearer(user["access_token"].(string)))
	if !strings.Contains(adminList.Body.String(), "recover-admin-job") || strings.Contains(adminList.Body.String(), "recover-user-job") {
		t.Fatalf("admin import isolation failed: %s", adminList.Body.String())
	}
	if !strings.Contains(userList.Body.String(), "recover-user-job") || strings.Contains(userList.Body.String(), "recover-admin-job") {
		t.Fatalf("user import isolation failed: %s", userList.Body.String())
	}
}

func TestReadyImportCanBeClaimedAndRecoveredByOwner(t *testing.T) {
	filesDir := filepath.Join(t.TempDir(), "files")
	t.Setenv("SERVICE_FILES_DIR", filesDir)
	openTestDatabase(t)
	if res := registerAccount(t, "claim-admin", "password-123", ""); res.Code != http.StatusOK {
		t.Fatalf("bootstrap admin: %d %s", res.Code, res.Body.String())
	}
	admin := loginAccount(t, "claim-admin", "password-123")
	created := request(t, http.MethodPost, "/v1/admin/users", map[string]string{
		"username": "claim-user", "password": "password-456",
	}, bearer(admin["access_token"].(string)))
	if created.Code != http.StatusOK {
		t.Fatalf("create user: %d %s", created.Code, created.Body.String())
	}
	other := loginAccount(t, "claim-user", "password-456")

	var adminID string
	_ = db.QueryRow(`SELECT id FROM users WHERE username='claim-admin'`).Scan(&adminID)
	generatedDir := t.TempDir()
	generatedPath := filepath.Join(generatedDir, "ready.epub")
	content := []byte("valid generated epub placeholder")
	if err := os.WriteFile(generatedPath, content, 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	_, err := db.Exec(`INSERT INTO book_import_jobs(id,user_id,source_id,source_type,status,stage,current,total,file_name,file_path,created_at,updated_at,expires_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, "claim-ready-job", adminID, "source", "opds", "ready", "ready", 1, 1, "book.epub", generatedPath, now, now, now+3600)
	if err != nil {
		t.Fatal(err)
	}

	claim := request(t, http.MethodPost, "/v1/book-imports/claim-ready-job/claim", map[string]string{
		"book_key": "1784262554674", "format": "epub",
	}, bearer(admin["access_token"].(string)))
	if claim.Code != http.StatusOK {
		t.Fatalf("claim import: %d %s", claim.Code, claim.Body.String())
	}
	recovered := request(t, http.MethodGet, "/v1/book-files/1784262554674?format=epub", nil, bearer(admin["access_token"].(string)))
	if recovered.Code != http.StatusOK || recovered.Body.String() != string(content) {
		t.Fatalf("recover claimed import: %d %q", recovered.Code, recovered.Body.String())
	}
	head := request(t, http.MethodHead, "/v1/book-files/1784262554674?format=epub", nil, bearer(admin["access_token"].(string)))
	if head.Code != http.StatusOK || head.Header().Get("ETag") == "" || head.Body.Len() != 0 {
		t.Fatalf("stored book metadata: status=%d etag=%q body=%q", head.Code, head.Header().Get("ETag"), head.Body.String())
	}
	isolated := request(t, http.MethodGet, "/v1/book-files/1784262554674?format=epub", nil, bearer(other["access_token"].(string)))
	if isolated.Code != http.StatusNotFound {
		t.Fatalf("other account read claimed file: %d %s", isolated.Code, isolated.Body.String())
	}
	unauthenticated := request(t, http.MethodGet, "/v1/book-files/1784262554674?format=epub", nil, nil)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated claimed file: %d", unauthenticated.Code)
	}
	invalid := request(t, http.MethodPost, "/v1/book-imports/claim-ready-job/claim", map[string]string{
		"book_key": "../escape", "format": "epub",
	}, bearer(admin["access_token"].(string)))
	if invalid.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid claim key: %d %s", invalid.Code, invalid.Body.String())
	}
}

func TestOPDS2ResultsUseRealOpenAccessAcquisition(t *testing.T) {
	var feed opds2Feed
	err := json.Unmarshal([]byte(`{
		"publications":[{
			"metadata":{"title":"Open Book","author":[{"name":"Public Author"}],"description":"Public domain"},
			"links":[
				{"href":"https://archive.example/borrow","type":"application/opds-publication+json","rel":"http://opds-spec.org/acquisition/borrow"},
				{"href":"https://archive.example/book.pdf","type":"application/pdf","rel":"http://opds-spec.org/acquisition/open-access"}
			],
			"images":[{"href":"https://archive.example/cover.jpg","type":"image/jpeg","rel":"cover"}]
		}]
	}`), &feed)
	if err != nil {
		t.Fatal(err)
	}
	items := convertOPDS2Publications("user-a", bookSource{ID: "archive", Name: "Archive", Type: "opds"}, feed.Publications)
	if len(items) != 1 || items[0].DownloadURL != "https://archive.example/book.pdf" || items[0].Format != "pdf" {
		t.Fatalf("unexpected OPDS2 conversion: %#v", items)
	}
	if items[0].CoverURL != "https://archive.example/cover.jpg" || strings.Join(items[0].Authors, "") != "Public Author" {
		t.Fatalf("OPDS2 metadata lost: %#v", items[0])
	}
}
