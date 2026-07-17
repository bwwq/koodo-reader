package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	serviceVersion       = "0.4.0"
	accessTTL            = 15 * time.Minute
	refreshTTL           = 30 * 24 * time.Hour
	passwordRounds       = 120000
	defaultAPIBodyLimit  = int64(20 << 20)
	defaultFileBodyLimit = int64(512 << 20)
)

var (
	db           *sql.DB
	registerMu   sync.Mutex
	rateMu       sync.Mutex
	rateBuckets  = map[string]*rateBucket{}
	usernameExpr = regexp.MustCompile(`^[A-Za-z0-9._-]{3,32}$`)
	allowedTypes = map[string]bool{
		"sync": true, "config": true, "books": true, "notes": true,
		"bookmarks": true, "words": true, "plugins": true,
	}
)

type rateBucket struct {
	Started time.Time
	Count   int
}

type user struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	Role        string `json:"role"`
	CreatedAt   int64  `json:"created_at,omitempty"`
}

type authContext struct {
	User      user
	SessionID string
}

type apiResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data any    `json:"data"`
}

func main() {
	if err := openDatabase(); err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	cleanupExpiredBookImports()
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			cleanupExpiredBookImports()
		}
	}()

	port := env("SERVICE_PORT", "8081")
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           http.HandlerFunc(route),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       10 * time.Minute,
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("Koodo self-hosted service %s listening on :%s", serviceVersion, port)
	log.Fatal(server.ListenAndServe())
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt64(key string, fallback int64) int64 {
	value, err := strconv.ParseInt(env(key, ""), 10, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func serviceCapabilities() []string {
	capabilities := []string{"sync.data", "sync.koreader", "storage.files", "source.search"}
	if legadoEngineHealthy() {
		capabilities = append(capabilities, "source.legado")
	}
	return capabilities
}

func legadoEngineHealthy() bool {
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(legadoEngineURL() + "/health")
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func requestIP(r *http.Request) string {
	forwardedParts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	if forwarded := strings.TrimSpace(forwardedParts[len(forwardedParts)-1]); forwarded != "" {
		return forwarded
	}
	host := r.RemoteAddr
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	return host
}

func allowRate(r *http.Request, limit int, window time.Duration) bool {
	now := time.Now()
	key := requestIP(r) + "|" + r.URL.Path
	rateMu.Lock()
	defer rateMu.Unlock()
	if len(rateBuckets) > 4096 {
		for name, item := range rateBuckets {
			if now.Sub(item.Started) >= window {
				delete(rateBuckets, name)
			}
		}
	}
	bucket := rateBuckets[key]
	if bucket == nil && len(rateBuckets) >= 8192 {
		return false
	}
	if bucket == nil || now.Sub(bucket.Started) >= window {
		rateBuckets[key] = &rateBucket{Started: now, Count: 1}
		return true
	}
	if bucket.Count >= limit {
		return false
	}
	bucket.Count++
	return true
}

func isSensitiveRoute(r *http.Request) bool {
	if r.Method == http.MethodPost && (r.URL.Path == "/v1/auth/login" || r.URL.Path == "/v1/auth/register" || r.URL.Path == "/v1/auth/refresh" || r.URL.Path == "/users/create") {
		return true
	}
	return r.Method == http.MethodGet && r.URL.Path == "/users/auth"
}

func isFileRoute(r *http.Request) bool {
	return r.URL.Path == "/upload" || r.URL.Path == "/download" || r.URL.Path == "/delete" || r.URL.Path == "/list"
}

func openDatabase() error {
	dbPath := env("SERVICE_DB", "/data/service.db")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return err
	}
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)", filepath.ToSlash(dbPath))
	var err error
	db, err = sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(8)
	schema := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL UNIQUE COLLATE NOCASE,
			password_hash TEXT NOT NULL,
			display_name TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL CHECK(role IN ('admin','user')),
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			access_hash TEXT NOT NULL UNIQUE,
			refresh_hash TEXT NOT NULL UNIQUE,
			access_expires INTEGER NOT NULL,
			refresh_expires INTEGER NOT NULL,
			revoked_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS invites (
			code_hash TEXT PRIMARY KEY,
			code_hint TEXT NOT NULL,
			created_by TEXT NOT NULL REFERENCES users(id),
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			used_by TEXT REFERENCES users(id),
			used_at INTEGER,
			revoked_at INTEGER
		)`,
		`CREATE TABLE IF NOT EXISTS sync_items (
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			type TEXT NOT NULL,
			content TEXT NOT NULL,
			version INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(user_id, type)
		)`,
		`CREATE TABLE IF NOT EXISTS koreader_users (
			username TEXT PRIMARY KEY COLLATE NOCASE,
			password TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS koreader_progress (
			username TEXT NOT NULL REFERENCES koreader_users(username) ON DELETE CASCADE,
			document TEXT NOT NULL,
			percentage REAL NOT NULL DEFAULT 0,
			progress TEXT NOT NULL DEFAULT '',
			device TEXT NOT NULL DEFAULT '',
			device_id TEXT NOT NULL DEFAULT '',
			timestamp INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY(username, document)
		)`,
	}
	schema = append(schema, initBookSourceSchema()...)
	for _, statement := range schema {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	_, _ = db.Exec(`INSERT OR IGNORE INTO settings(key,value) VALUES ('registration_mode','invite'), ('service_name','Koodo Reader')`)
	defaultKoreaderRegistration := "true"
	if strings.EqualFold(env("ENABLE_KOREADER_REGISTRATION", "true"), "false") {
		defaultKoreaderRegistration = "false"
	}
	_, _ = db.Exec(`INSERT OR IGNORE INTO settings(key,value) VALUES ('koreader_registration_enabled',?)`, defaultKoreaderRegistration)
	return db.Ping()
}

func route(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if isSensitiveRoute(r) && !allowRate(r, 20, time.Minute) {
		w.Header().Set("Retry-After", "60")
		writeAPI(w, http.StatusTooManyRequests, http.StatusTooManyRequests, "请求过于频繁，请稍后重试", nil)
		return
	}
	if isFileRoute(r) && !allowRate(r, 600, time.Minute) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "Too many requests", http.StatusTooManyRequests)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/book-") && handleBookSourceRoutes(w, r) {
		return
	}

	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/health":
		handleHealth(w)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/auth/config":
		handleAuthConfig(w)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/auth/register":
		handleRegister(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/auth/login":
		handleLogin(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/auth/refresh":
		handleRefresh(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/auth/me":
		handleMe(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/auth/logout":
		handleLogout(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/sync/"):
		handleGetSync(w, r)
	case r.Method == http.MethodPut && r.URL.Path == "/v1/sync":
		handlePutSync(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/admin/config":
		handleAdminConfig(w, r)
	case r.Method == http.MethodPut && r.URL.Path == "/v1/admin/config":
		handleUpdateAdminConfig(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/admin/invites":
		handleCreateInvites(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/admin/invites":
		handleListInvites(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/admin/users":
		handleListUsers(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/admin/users":
		handleCreateUser(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/upload":
		handleFileUpload(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/download":
		handleFileDownload(w, r)
	case r.Method == http.MethodDelete && r.URL.Path == "/delete":
		handleFileDelete(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/list":
		handleFileList(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/users/create":
		handleKoreaderCreateUser(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/users/auth":
		handleKoreaderAuth(w, r)
	case r.Method == http.MethodPut && r.URL.Path == "/syncs/progress":
		handleKoreaderPutProgress(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/syncs/progress/"):
		handleKoreaderGetProgress(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/healthcheck":
		writeKoreaderJSON(w, http.StatusOK, map[string]any{"state": "OK"})
	default:
		writeAPI(w, http.StatusNotFound, http.StatusNotFound, "接口不存在", nil)
	}
}

func setCORS(w http.ResponseWriter, r *http.Request) {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin != "" && isAllowedOrigin(origin, r) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, x-auth-user, x-auth-key")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
}

func isAllowedOrigin(origin string, r *http.Request) bool {
	parsed, err := url.Parse(origin)
	requestScheme := "http"
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded != "" {
		requestScheme = forwarded
	} else if r.TLS != nil {
		requestScheme = "https"
	}
	if err == nil && parsed.Host != "" && strings.EqualFold(parsed.Host, r.Host) && strings.EqualFold(parsed.Scheme, requestScheme) {
		return true
	}
	if origin == "https://localhost" || origin == "capacitor://localhost" {
		return true
	}
	for _, allowed := range strings.Split(os.Getenv("SERVICE_ALLOWED_ORIGINS"), ",") {
		if strings.EqualFold(strings.TrimRight(strings.TrimSpace(allowed), "/"), strings.TrimRight(origin, "/")) {
			return true
		}
	}
	return false
}

func writeAPI(w http.ResponseWriter, status, code int, msg string, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiResponse{Code: code, Msg: msg, Data: data})
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, envInt64("SERVICE_MAX_BODY_BYTES", defaultAPIBodyLimit))
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		writeAPI(w, http.StatusBadRequest, http.StatusBadRequest, "请求格式无效", nil)
		return false
	}
	return true
}

func handleHealth(w http.ResponseWriter) {
	writeAPI(w, http.StatusOK, 200, "success", map[string]any{
		"version": serviceVersion, "capabilities": serviceCapabilities(),
	})
}

func userCount() (int, error) {
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

func setting(key, fallback string) string {
	var value string
	if err := db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&value); err != nil {
		return fallback
	}
	return value
}

func saveSetting(tx *sql.Tx, key, value string) error {
	_, err := tx.Exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func handleAuthConfig(w http.ResponseWriter) {
	count, err := userCount()
	if err != nil {
		writeAPI(w, 500, 500, "读取注册配置失败", nil)
		return
	}
	mode := setting("registration_mode", "invite")
	if count == 0 {
		mode = "bootstrap"
	}
	writeAPI(w, 200, 200, "success", map[string]any{
		"registration_mode": mode,
		"service_name":      setting("service_name", "Koodo Reader"),
	})
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username   string `json:"username"`
		Password   string `json:"password"`
		InviteCode string `json:"invite_code"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	if !usernameExpr.MatchString(body.Username) {
		writeAPI(w, 422, 422, "用户名须为 3–32 位字母、数字、点、下划线或连字符", nil)
		return
	}
	if len(body.Password) < 8 || len(body.Password) > 128 {
		writeAPI(w, 422, 422, "密码长度须为 8–128 位", nil)
		return
	}

	registerMu.Lock()
	defer registerMu.Unlock()
	count, err := userCount()
	if err != nil {
		writeAPI(w, 500, 500, "注册失败", nil)
		return
	}
	role := "user"
	if count == 0 {
		role = "admin"
	} else if setting("registration_mode", "invite") != "invite" {
		writeAPI(w, 403, 403, "服务端已关闭注册", nil)
		return
	} else if strings.TrimSpace(body.InviteCode) == "" {
		writeAPI(w, 422, 422, "请输入邀请码", nil)
		return
	}

	passwordHash, err := makePasswordHash(body.Password)
	if err != nil {
		writeAPI(w, 500, 500, "注册失败", nil)
		return
	}
	tx, err := db.Begin()
	if err != nil {
		writeAPI(w, 500, 500, "注册失败", nil)
		return
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	userID := randomString(18)
	if role != "admin" {
		codeHash := tokenHash(strings.TrimSpace(body.InviteCode))
		var expiresAt int64
		var usedAt, revokedAt sql.NullInt64
		if err := tx.QueryRow(`SELECT expires_at,used_at,revoked_at FROM invites WHERE code_hash=?`, codeHash).Scan(&expiresAt, &usedAt, &revokedAt); err != nil || usedAt.Valid || revokedAt.Valid || expiresAt <= now {
			writeAPI(w, 422, 422, "邀请码无效、已过期或已使用", nil)
			return
		}
	}
	if _, err := tx.Exec(`INSERT INTO users(id,username,password_hash,display_name,role,created_at) VALUES(?,?,?,?,?,?)`, userID, body.Username, passwordHash, body.Username, role, now); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeAPI(w, 409, 409, "用户名已存在", nil)
		} else {
			writeAPI(w, 500, 500, "注册失败", nil)
		}
		return
	}
	if role != "admin" {
		result, err := tx.Exec(`UPDATE invites SET used_by=?,used_at=? WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL`, userID, now, tokenHash(strings.TrimSpace(body.InviteCode)))
		if err != nil {
			writeAPI(w, 500, 500, "邀请码核销失败", nil)
			return
		}
		rows, _ := result.RowsAffected()
		if rows != 1 {
			writeAPI(w, 409, 409, "邀请码已被使用", nil)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeAPI(w, 500, 500, "注册失败", nil)
		return
	}
	msg := "注册成功"
	if role == "admin" {
		msg = "首位管理员创建成功，请登录"
	}
	writeAPI(w, 200, 200, msg, map[string]any{"role": role})
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	var account user
	var storedHash string
	err := db.QueryRow(`SELECT id,username,password_hash,display_name,role,created_at FROM users WHERE username=?`, strings.TrimSpace(body.Username)).Scan(
		&account.ID, &account.Username, &storedHash, &account.DisplayName, &account.Role, &account.CreatedAt,
	)
	if err != nil || !verifyPassword(body.Password, storedHash) {
		writeAPI(w, 401, 401, "用户名或密码错误", nil)
		return
	}
	payload, err := createSession(account)
	if err != nil {
		writeAPI(w, 500, 500, "登录失败", nil)
		return
	}
	writeAPI(w, 200, 200, "success", payload)
}

func createSession(account user) (map[string]any, error) {
	accessToken := randomString(32)
	refreshToken := randomString(40)
	now := time.Now()
	_, err := db.Exec(`INSERT INTO sessions(id,user_id,access_hash,refresh_hash,access_expires,refresh_expires) VALUES(?,?,?,?,?,?)`,
		randomString(18), account.ID, tokenHash(accessToken), tokenHash(refreshToken), now.Add(accessTTL).Unix(), now.Add(refreshTTL).Unix())
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"access_token": accessToken, "refresh_token": refreshToken,
		"expires_in": int(accessTTL.Seconds()), "user": account,
	}, nil
}

func handleRefresh(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.RefreshToken == "" {
		writeAPI(w, 400, 400, "缺少刷新令牌", nil)
		return
	}
	refreshHash := tokenHash(body.RefreshToken)
	var sessionID string
	var refreshExpires int64
	var account user
	err := db.QueryRow(`SELECT s.id,s.refresh_expires,u.id,u.username,u.display_name,u.role,u.created_at
		FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.refresh_hash=? AND s.revoked_at IS NULL`, refreshHash).Scan(
		&sessionID, &refreshExpires, &account.ID, &account.Username, &account.DisplayName, &account.Role, &account.CreatedAt,
	)
	if err != nil || refreshExpires <= time.Now().Unix() {
		writeAPI(w, 401, 401, "刷新令牌无效或已过期", nil)
		return
	}
	accessToken := randomString(32)
	newRefreshToken := randomString(40)
	now := time.Now()
	result, err := db.Exec(`UPDATE sessions SET access_hash=?,refresh_hash=?,access_expires=?,refresh_expires=? WHERE id=? AND refresh_hash=? AND revoked_at IS NULL`,
		tokenHash(accessToken), tokenHash(newRefreshToken), now.Add(accessTTL).Unix(), now.Add(refreshTTL).Unix(), sessionID, refreshHash)
	if err != nil {
		writeAPI(w, 401, 401, "刷新令牌已被轮换", nil)
		return
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		writeAPI(w, 401, 401, "刷新令牌已被轮换", nil)
		return
	}
	writeAPI(w, 200, 200, "success", map[string]any{
		"access_token": accessToken, "refresh_token": newRefreshToken,
		"expires_in": int(accessTTL.Seconds()), "user": account,
	})
}

func authenticate(r *http.Request) (*authContext, error) {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, errors.New("missing bearer token")
	}
	hash := tokenHash(strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")))
	var context authContext
	var expires int64
	err := db.QueryRow(`SELECT s.id,s.access_expires,u.id,u.username,u.display_name,u.role,u.created_at
		FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.access_hash=? AND s.revoked_at IS NULL`, hash).Scan(
		&context.SessionID, &expires, &context.User.ID, &context.User.Username,
		&context.User.DisplayName, &context.User.Role, &context.User.CreatedAt,
	)
	if err != nil || expires <= time.Now().Unix() {
		return nil, errors.New("invalid access token")
	}
	return &context, nil
}

func requireAuth(w http.ResponseWriter, r *http.Request) *authContext {
	context, err := authenticate(r)
	if err != nil {
		writeAPI(w, 401, 401, "请先登录", nil)
		return nil
	}
	return context
}

func requireAdmin(w http.ResponseWriter, r *http.Request) *authContext {
	context := requireAuth(w, r)
	if context == nil {
		return nil
	}
	if context.User.Role != "admin" {
		writeAPI(w, 403, 403, "需要管理员权限", nil)
		return nil
	}
	return context
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	context := requireAuth(w, r)
	if context != nil {
		writeAPI(w, 200, 200, "success", context.User)
	}
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	context := requireAuth(w, r)
	if context == nil {
		return
	}
	_, _ = db.Exec(`UPDATE sessions SET revoked_at=? WHERE id=?`, time.Now().Unix(), context.SessionID)
	writeAPI(w, 200, 200, "success", nil)
}

func handleGetSync(w http.ResponseWriter, r *http.Request) {
	context := requireAuth(w, r)
	if context == nil {
		return
	}
	typeName := strings.TrimPrefix(r.URL.Path, "/v1/sync/")
	if !allowedTypes[typeName] {
		writeAPI(w, 422, 422, "不支持的同步类型", nil)
		return
	}
	var content string
	var version, updatedAt int64
	err := db.QueryRow(`SELECT content,version,updated_at FROM sync_items WHERE user_id=? AND type=?`, context.User.ID, typeName).Scan(&content, &version, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPI(w, 404, 404, "暂无同步数据", nil)
		return
	}
	if err != nil {
		writeAPI(w, 500, 500, "读取同步数据失败", nil)
		return
	}
	writeAPI(w, 200, 200, "success", map[string]any{
		"type": typeName, "content": content, "version": version, "updated_at": updatedAt,
	})
}

func handlePutSync(w http.ResponseWriter, r *http.Request) {
	context := requireAuth(w, r)
	if context == nil {
		return
	}
	var body struct {
		Items    map[string]string `json:"items"`
		Versions map[string]int64  `json:"versions"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if len(body.Items) == 0 {
		writeAPI(w, 422, 422, "同步数据不能为空", nil)
		return
	}
	for typeName := range body.Items {
		if !allowedTypes[typeName] {
			writeAPI(w, 422, 422, "不支持的同步类型", nil)
			return
		}
	}
	tx, err := db.Begin()
	if err != nil {
		writeAPI(w, 500, 500, "保存同步数据失败", nil)
		return
	}
	defer tx.Rollback()
	result := map[string]any{}
	for typeName, content := range body.Items {
		var currentVersion int64
		err := tx.QueryRow(`SELECT version FROM sync_items WHERE user_id=? AND type=?`, context.User.ID, typeName).Scan(&currentVersion)
		if errors.Is(err, sql.ErrNoRows) {
			currentVersion = 0
		} else if err != nil {
			writeAPI(w, 500, 500, "读取同步版本失败", nil)
			return
		}
		if body.Versions[typeName] != currentVersion {
			writeAPI(w, 409, 409, "同步版本冲突，请重新拉取", map[string]any{"type": typeName, "version": currentVersion})
			return
		}
		newVersion := currentVersion + 1
		updatedAt := time.Now().UnixMilli()
		_, err = tx.Exec(`INSERT INTO sync_items(user_id,type,content,version,updated_at) VALUES(?,?,?,?,?)
			ON CONFLICT(user_id,type) DO UPDATE SET content=excluded.content,version=excluded.version,updated_at=excluded.updated_at`,
			context.User.ID, typeName, content, newVersion, updatedAt)
		if err != nil {
			writeAPI(w, 500, 500, "保存同步数据失败", nil)
			return
		}
		result[typeName] = map[string]any{"type": typeName, "content": content, "version": newVersion, "updated_at": updatedAt}
	}
	if err := tx.Commit(); err != nil {
		writeAPI(w, 500, 500, "保存同步数据失败", nil)
		return
	}
	writeAPI(w, 200, 200, "success", result)
}

func adminConfigData() map[string]any {
	return map[string]any{
		"registration_mode":             setting("registration_mode", "invite"),
		"service_name":                  setting("service_name", "Koodo Reader"),
		"capabilities":                  serviceCapabilities(),
		"koreader_registration_enabled": strings.EqualFold(setting("koreader_registration_enabled", "true"), "true"),
	}
}

func handleAdminConfig(w http.ResponseWriter, r *http.Request) {
	if requireAdmin(w, r) == nil {
		return
	}
	writeAPI(w, 200, 200, "success", adminConfigData())
}

func handleUpdateAdminConfig(w http.ResponseWriter, r *http.Request) {
	if requireAdmin(w, r) == nil {
		return
	}
	var body struct {
		RegistrationMode            string `json:"registration_mode"`
		ServiceName                 string `json:"service_name"`
		KoreaderRegistrationEnabled *bool  `json:"koreader_registration_enabled"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.RegistrationMode != "admin" && body.RegistrationMode != "invite" {
		writeAPI(w, 422, 422, "注册模式无效", nil)
		return
	}
	body.ServiceName = strings.TrimSpace(body.ServiceName)
	if len(body.ServiceName) < 1 || len(body.ServiceName) > 64 {
		writeAPI(w, 422, 422, "服务名称长度须为 1–64 位", nil)
		return
	}
	tx, err := db.Begin()
	if err != nil {
		writeAPI(w, 500, 500, "保存服务配置失败", nil)
		return
	}
	defer tx.Rollback()
	if err := saveSetting(tx, "registration_mode", body.RegistrationMode); err != nil {
		writeAPI(w, 500, 500, "保存服务配置失败", nil)
		return
	}
	if err := saveSetting(tx, "service_name", body.ServiceName); err != nil {
		writeAPI(w, 500, 500, "保存服务配置失败", nil)
		return
	}
	if body.KoreaderRegistrationEnabled != nil {
		if err := saveSetting(tx, "koreader_registration_enabled", strconv.FormatBool(*body.KoreaderRegistrationEnabled)); err != nil {
			writeAPI(w, 500, 500, "保存服务配置失败", nil)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeAPI(w, 500, 500, "保存服务配置失败", nil)
		return
	}
	writeAPI(w, 200, 200, "服务配置已保存", adminConfigData())
}

func handleCreateInvites(w http.ResponseWriter, r *http.Request) {
	context := requireAdmin(w, r)
	if context == nil {
		return
	}
	var body struct {
		Count         int `json:"count"`
		ExpiresInDays int `json:"expires_in_days"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.Count == 0 {
		body.Count = 1
	}
	if body.ExpiresInDays == 0 {
		body.ExpiresInDays = 7
	}
	if body.Count < 1 || body.Count > 10 || body.ExpiresInDays < 1 || body.ExpiresInDays > 365 {
		writeAPI(w, 422, 422, "每次可生成 1–10 个、有效期 1–365 天的邀请码", nil)
		return
	}
	tx, err := db.Begin()
	if err != nil {
		writeAPI(w, 500, 500, "生成邀请码失败", nil)
		return
	}
	defer tx.Rollback()
	now := time.Now()
	expiresAt := now.Add(time.Duration(body.ExpiresInDays) * 24 * time.Hour).Unix()
	codes := make([]string, 0, body.Count)
	for len(codes) < body.Count {
		code := strings.ToUpper(randomString(12))
		hint := code[:4] + "…" + code[len(code)-4:]
		_, err := tx.Exec(`INSERT INTO invites(code_hash,code_hint,created_by,created_at,expires_at) VALUES(?,?,?,?,?)`, tokenHash(code), hint, context.User.ID, now.Unix(), expiresAt)
		if err == nil {
			codes = append(codes, code)
		}
	}
	if err := tx.Commit(); err != nil {
		writeAPI(w, 500, 500, "生成邀请码失败", nil)
		return
	}
	writeAPI(w, 200, 200, "邀请码已生成，请立即保存", map[string]any{"codes": codes, "expires_at": expiresAt})
}

func handleListInvites(w http.ResponseWriter, r *http.Request) {
	if requireAdmin(w, r) == nil {
		return
	}
	rows, err := db.Query(`SELECT code_hint,created_at,expires_at,used_at,revoked_at FROM invites ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		writeAPI(w, 500, 500, "读取邀请码失败", nil)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var hint string
		var createdAt, expiresAt int64
		var usedAt, revokedAt sql.NullInt64
		if rows.Scan(&hint, &createdAt, &expiresAt, &usedAt, &revokedAt) == nil {
			status := "available"
			if usedAt.Valid {
				status = "used"
			} else if revokedAt.Valid {
				status = "revoked"
			} else if expiresAt <= time.Now().Unix() {
				status = "expired"
			}
			items = append(items, map[string]any{"code_hint": hint, "created_at": createdAt, "expires_at": expiresAt, "status": status})
		}
	}
	writeAPI(w, 200, 200, "success", items)
}

func handleListUsers(w http.ResponseWriter, r *http.Request) {
	if requireAdmin(w, r) == nil {
		return
	}
	rows, err := db.Query(`SELECT id,username,display_name,role,created_at FROM users ORDER BY created_at ASC LIMIT 200`)
	if err != nil {
		writeAPI(w, 500, 500, "读取账号失败", nil)
		return
	}
	defer rows.Close()
	users := []user{}
	for rows.Next() {
		var account user
		if rows.Scan(&account.ID, &account.Username, &account.DisplayName, &account.Role, &account.CreatedAt) == nil {
			users = append(users, account)
		}
	}
	writeAPI(w, 200, 200, "success", users)
}

func handleCreateUser(w http.ResponseWriter, r *http.Request) {
	if requireAdmin(w, r) == nil {
		return
	}
	var body struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	body.DisplayName = strings.TrimSpace(body.DisplayName)
	if !usernameExpr.MatchString(body.Username) {
		writeAPI(w, 422, 422, "用户名须为 3–32 位字母、数字、点、下划线或连字符", nil)
		return
	}
	if len(body.Password) < 8 || len(body.Password) > 128 {
		writeAPI(w, 422, 422, "密码长度须为 8–128 位", nil)
		return
	}
	if len([]rune(body.DisplayName)) > 64 {
		writeAPI(w, 422, 422, "显示名称不能超过 64 个字符", nil)
		return
	}
	if body.DisplayName == "" {
		body.DisplayName = body.Username
	}
	passwordHash, err := makePasswordHash(body.Password)
	if err != nil {
		writeAPI(w, 500, 500, "创建账号失败", nil)
		return
	}
	account := user{
		ID: randomString(18), Username: body.Username, DisplayName: body.DisplayName,
		Role: "user", CreatedAt: time.Now().Unix(),
	}
	_, err = db.Exec(`INSERT INTO users(id,username,password_hash,display_name,role,created_at) VALUES(?,?,?,?,?,?)`,
		account.ID, account.Username, passwordHash, account.DisplayName, account.Role, account.CreatedAt)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeAPI(w, 409, 409, "用户名已存在", nil)
		} else {
			writeAPI(w, 500, 500, "创建账号失败", nil)
		}
		return
	}
	writeAPI(w, 200, 200, "账号创建成功", account)
}

func writeKoreaderJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func writeKoreaderError(w http.ResponseWriter, status, code int, message string) {
	writeKoreaderJSON(w, status, map[string]any{"code": code, "message": message})
}

func koreaderCredentials(r *http.Request) (string, string) {
	return strings.TrimSpace(r.Header.Get("x-auth-user")), strings.TrimSpace(r.Header.Get("x-auth-key"))
}

func authenticateKoreader(r *http.Request) string {
	username, password := koreaderCredentials(r)
	if username == "" || password == "" || strings.Contains(username, ":") {
		return ""
	}
	var stored string
	if err := db.QueryRow(`SELECT password FROM koreader_users WHERE username=?`, username).Scan(&stored); err != nil || subtle.ConstantTimeCompare([]byte(stored), []byte(password)) != 1 {
		return ""
	}
	return username
}

func handleKoreaderCreateUser(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(setting("koreader_registration_enabled", "true"), "true") {
		writeKoreaderError(w, http.StatusPaymentRequired, 2005, "User registration is disabled.")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeKoreaderBody(w, r, &body) {
		writeKoreaderError(w, http.StatusForbidden, 2003, "Invalid request")
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	body.Password = strings.TrimSpace(body.Password)
	if !usernameExpr.MatchString(body.Username) || body.Password == "" || len(body.Password) > 256 || strings.Contains(body.Username, ":") {
		writeKoreaderError(w, http.StatusForbidden, 2003, "Invalid request")
		return
	}
	_, err := db.Exec(`INSERT INTO koreader_users(username,password,created_at) VALUES(?,?,?)`, body.Username, body.Password, time.Now().Unix())
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeKoreaderError(w, http.StatusPaymentRequired, 2002, "Username is already registered.")
			return
		}
		writeKoreaderError(w, http.StatusBadGateway, 2000, "Unknown server error.")
		return
	}
	writeKoreaderJSON(w, http.StatusCreated, map[string]any{"username": body.Username})
}

func decodeKoreaderBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, envInt64("SERVICE_MAX_BODY_BYTES", defaultAPIBodyLimit))
	decoder := json.NewDecoder(r.Body)
	return decoder.Decode(target) == nil
}

func handleKoreaderAuth(w http.ResponseWriter, r *http.Request) {
	if authenticateKoreader(r) == "" {
		writeKoreaderError(w, http.StatusUnauthorized, 2001, "Unauthorized")
		return
	}
	writeKoreaderJSON(w, http.StatusOK, map[string]any{"authorized": "OK"})
}

func handleKoreaderPutProgress(w http.ResponseWriter, r *http.Request) {
	username := authenticateKoreader(r)
	if username == "" {
		writeKoreaderError(w, http.StatusUnauthorized, 2001, "Unauthorized")
		return
	}
	var body struct {
		Document   string  `json:"document"`
		Progress   string  `json:"progress"`
		Percentage float64 `json:"percentage"`
		Device     string  `json:"device"`
		DeviceID   string  `json:"device_id"`
	}
	if !decodeKoreaderBody(w, r, &body) || strings.TrimSpace(body.Document) == "" || strings.Contains(body.Document, ":") || body.Progress == "" || body.Device == "" {
		writeKoreaderError(w, http.StatusForbidden, 2003, "Invalid request")
		return
	}
	timestamp := time.Now().Unix()
	_, err := db.Exec(`INSERT INTO koreader_progress(username,document,percentage,progress,device,device_id,timestamp)
		VALUES(?,?,?,?,?,?,?) ON CONFLICT(username,document) DO UPDATE SET percentage=excluded.percentage,
		progress=excluded.progress,device=excluded.device,device_id=excluded.device_id,timestamp=excluded.timestamp`,
		username, body.Document, body.Percentage, body.Progress, body.Device, body.DeviceID, timestamp)
	if err != nil {
		writeKoreaderError(w, http.StatusBadGateway, 2000, "Unknown server error.")
		return
	}
	writeKoreaderJSON(w, http.StatusOK, map[string]any{"document": body.Document, "timestamp": timestamp})
}

func handleKoreaderGetProgress(w http.ResponseWriter, r *http.Request) {
	username := authenticateKoreader(r)
	if username == "" {
		writeKoreaderError(w, http.StatusUnauthorized, 2001, "Unauthorized")
		return
	}
	document := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/syncs/progress/"))
	if document == "" || strings.Contains(document, ":") {
		writeKoreaderError(w, http.StatusForbidden, 2004, "Field 'document' not provided.")
		return
	}
	var percentage float64
	var progress, device, deviceID string
	var timestamp int64
	err := db.QueryRow(`SELECT percentage,progress,device,device_id,timestamp FROM koreader_progress WHERE username=? AND document=?`, username, document).
		Scan(&percentage, &progress, &device, &deviceID, &timestamp)
	if errors.Is(err, sql.ErrNoRows) {
		writeKoreaderJSON(w, http.StatusOK, map[string]any{})
		return
	}
	if err != nil {
		writeKoreaderError(w, http.StatusBadGateway, 2000, "Unknown server error.")
		return
	}
	result := map[string]any{"document": document, "percentage": percentage, "progress": progress, "device": device, "timestamp": timestamp}
	if deviceID != "" {
		result["device_id"] = deviceID
	}
	writeKoreaderJSON(w, http.StatusOK, result)
}

func authenticateFileUser(w http.ResponseWriter, r *http.Request) *user {
	username, password, ok := r.BasicAuth()
	if !ok || !usernameExpr.MatchString(username) || password == "" {
		w.Header().Set("WWW-Authenticate", `Basic realm="Koodo file storage"`)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return nil
	}
	var account user
	var passwordHash string
	err := db.QueryRow(`SELECT id,username,password_hash,display_name,role,created_at FROM users WHERE username=?`, username).
		Scan(&account.ID, &account.Username, &passwordHash, &account.DisplayName, &account.Role, &account.CreatedAt)
	if err != nil || !verifyPassword(password, passwordHash) {
		w.Header().Set("WWW-Authenticate", `Basic realm="Koodo file storage"`)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return nil
	}
	return &account
}

func storageRoot(userID string) string {
	return filepath.Join(env("SERVICE_FILES_DIR", "/data/files"), userID)
}

func resolveStoragePath(userID, directory string, names ...string) (string, error) {
	root := storageRoot(userID)
	directory = strings.Trim(strings.ReplaceAll(directory, "\\", "/"), "/")
	cleanDir := filepath.Clean(filepath.FromSlash(directory))
	if cleanDir == "." {
		cleanDir = ""
	}
	target := filepath.Join(append([]string{root, cleanDir}, names...)...)
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", errors.New("Invalid path")
	}
	return target, nil
}

func safeStorageFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	for _, char := range `/:*?"<>|` {
		name = strings.ReplaceAll(name, string(char), "_")
	}
	if name == "" || name == "." || name == ".." {
		return ""
	}
	return name
}

func writeStorageJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func handleFileUpload(w http.ResponseWriter, r *http.Request) {
	account := authenticateFileUser(w, r)
	if account == nil {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, envInt64("SERVICE_FILE_MAX_BYTES", defaultFileBodyLimit))
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") || params["boundary"] == "" {
		http.Error(w, "Invalid multipart request", http.StatusBadRequest)
		return
	}
	directory := r.URL.Query().Get("dir")
	targetDir, err := resolveStoragePath(account.ID, directory)
	if err != nil {
		http.Error(w, "Invalid storage path", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		http.Error(w, "Storage unavailable", http.StatusInternalServerError)
		return
	}
	reader := multipart.NewReader(r.Body, params["boundary"])
	for {
		part, partErr := reader.NextPart()
		if partErr == io.EOF {
			break
		}
		if partErr != nil {
			http.Error(w, "Invalid multipart data", http.StatusBadRequest)
			return
		}
		filename := safeStorageFilename(part.FileName())
		if filename == "" {
			part.Close()
			continue
		}
		target, pathErr := resolveStoragePath(account.ID, directory, filename)
		if pathErr != nil {
			part.Close()
			http.Error(w, "Invalid filename", http.StatusBadRequest)
			return
		}
		temp, createErr := os.CreateTemp(targetDir, ".upload-*")
		if createErr != nil {
			part.Close()
			http.Error(w, "Storage unavailable", http.StatusInternalServerError)
			return
		}
		tempName := temp.Name()
		_, copyErr := io.Copy(temp, part)
		closeErr := temp.Close()
		part.Close()
		if copyErr != nil || closeErr != nil {
			_ = os.Remove(tempName)
			http.Error(w, "Upload failed", http.StatusInternalServerError)
			return
		}
		if err := os.Rename(tempName, target); err != nil {
			_ = os.Remove(tempName)
			http.Error(w, "Upload failed", http.StatusInternalServerError)
			return
		}
		writeStorageJSON(w, http.StatusOK, map[string]any{"success": true, "filename": filename, "directory": directory})
		return
	}
	http.Error(w, "No file uploaded", http.StatusBadRequest)
}

func handleFileDownload(w http.ResponseWriter, r *http.Request) {
	account := authenticateFileUser(w, r)
	if account == nil {
		return
	}
	filename := safeStorageFilename(r.URL.Query().Get("filename"))
	if filename == "" {
		http.Error(w, "Missing filename", http.StatusBadRequest)
		return
	}
	target, err := resolveStoragePath(account.ID, r.URL.Query().Get("dir"), filename)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	if info, statErr := os.Stat(target); statErr != nil || !info.Mode().IsRegular() {
		if os.IsNotExist(statErr) {
			http.Error(w, "File not found", http.StatusNotFound)
		} else {
			http.Error(w, "Invalid file", http.StatusBadRequest)
		}
		return
	}
	http.ServeFile(w, r, target)
}

func handleFileDelete(w http.ResponseWriter, r *http.Request) {
	account := authenticateFileUser(w, r)
	if account == nil {
		return
	}
	filename := safeStorageFilename(r.URL.Query().Get("filename"))
	if filename == "" {
		http.Error(w, "Missing filename", http.StatusBadRequest)
		return
	}
	target, err := resolveStoragePath(account.ID, r.URL.Query().Get("dir"), filename)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	if err := os.Remove(target); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "File not found", http.StatusNotFound)
		} else {
			http.Error(w, "Delete failed", http.StatusInternalServerError)
		}
		return
	}
	writeStorageJSON(w, http.StatusOK, map[string]any{"success": true, "filename": filename})
}

type storageFileEntry struct {
	Name         string `json:"name"`
	Type         string `json:"type"`
	Size         *int64 `json:"size"`
	ModifiedTime string `json:"modifiedTime"`
	CreatedTime  string `json:"createdTime"`
}

func handleFileList(w http.ResponseWriter, r *http.Request) {
	account := authenticateFileUser(w, r)
	if account == nil {
		return
	}
	directory := r.URL.Query().Get("dir")
	target, err := resolveStoragePath(account.ID, directory)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	entries, err := os.ReadDir(target)
	if os.IsNotExist(err) {
		entries = []os.DirEntry{}
	} else if err != nil {
		http.Error(w, "List failed", http.StatusInternalServerError)
		return
	}
	items := make([]storageFileEntry, 0, len(entries))
	for _, entry := range entries {
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		item := storageFileEntry{
			Name: entry.Name(), ModifiedTime: info.ModTime().UTC().Format(time.RFC3339),
			CreatedTime: info.ModTime().UTC().Format(time.RFC3339),
		}
		if entry.IsDir() {
			item.Type = "directory"
		} else {
			item.Type = "file"
			size := info.Size()
			item.Size = &size
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Type != items[j].Type {
			return items[i].Type == "directory"
		}
		return items[i].Name < items[j].Name
	})
	writeStorageJSON(w, http.StatusOK, map[string]any{
		"success": true, "directory": directory, "files": items, "totalCount": len(items),
	})
}

func randomString(byteLength int) string {
	buffer := make([]byte, byteLength)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer)
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func makePasswordHash(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	digest := pbkdf2SHA256([]byte(password), salt, passwordRounds, 32)
	return fmt.Sprintf("pbkdf2_sha256$%d$%s$%s", passwordRounds,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(digest)), nil
}

func verifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return false
	}
	rounds, err := strconv.Atoi(parts[1])
	if err != nil || rounds < 10000 || rounds > 1000000 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[2])
	expected, err2 := base64.RawStdEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	actual := pbkdf2SHA256([]byte(password), salt, rounds, len(expected))
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func pbkdf2SHA256(password, salt []byte, iterations, keyLength int) []byte {
	const hashLength = 32
	blocks := (keyLength + hashLength - 1) / hashLength
	derived := make([]byte, 0, blocks*hashLength)
	for block := 1; block <= blocks; block++ {
		mac := hmac.New(sha256.New, password)
		mac.Write(salt)
		counter := make([]byte, 4)
		binary.BigEndian.PutUint32(counter, uint32(block))
		mac.Write(counter)
		u := mac.Sum(nil)
		t := append([]byte(nil), u...)
		for i := 1; i < iterations; i++ {
			mac = hmac.New(sha256.New, password)
			mac.Write(u)
			u = mac.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		derived = append(derived, t...)
	}
	return derived[:keyLength]
}
