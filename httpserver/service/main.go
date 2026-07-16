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
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	serviceVersion = "0.1.0"
	accessTTL      = 15 * time.Minute
	refreshTTL     = 30 * 24 * time.Hour
	passwordRounds = 120000
)

var (
	db           *sql.DB
	registerMu   sync.Mutex
	usernameExpr = regexp.MustCompile(`^[A-Za-z0-9._-]{3,32}$`)
	allowedTypes = map[string]bool{
		"sync": true, "config": true, "books": true, "notes": true,
		"bookmarks": true, "words": true, "plugins": true,
	}
)

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

	port := env("SERVICE_PORT", "8081")
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           http.HandlerFunc(route),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
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
	}
	for _, statement := range schema {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	_, _ = db.Exec(`INSERT OR IGNORE INTO settings(key,value) VALUES ('registration_mode','invite'), ('service_name','Koodo Reader')`)
	return db.Ping()
}

func route(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Cache-Control", "no-store")

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
	default:
		writeAPI(w, http.StatusNotFound, http.StatusNotFound, "接口不存在", nil)
	}
}

func setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
}

func writeAPI(w http.ResponseWriter, status, code int, msg string, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiResponse{Code: code, Msg: msg, Data: data})
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		writeAPI(w, http.StatusBadRequest, http.StatusBadRequest, "请求格式无效", nil)
		return false
	}
	return true
}

func handleHealth(w http.ResponseWriter) {
	writeAPI(w, http.StatusOK, 200, "success", map[string]any{
		"version": serviceVersion, "capabilities": []string{"sync.data"},
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
		"registration_mode": setting("registration_mode", "invite"),
		"service_name":      setting("service_name", "Koodo Reader"),
		"capabilities":      []string{"sync.data"},
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
		RegistrationMode string `json:"registration_mode"`
		ServiceName      string `json:"service_name"`
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
