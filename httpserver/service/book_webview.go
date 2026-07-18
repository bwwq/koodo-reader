package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type sourceActionBinding struct {
	AccountID, StateUserID, Namespace, SourceID, Script string
	ExpiresAt                                            time.Time
}

type sourceActionOwner struct {
	AccountID, StateUserID, SourceID string
}

type browserTicket struct {
	UserID, SessionID string
	ExpiresAt         time.Time
	Used              bool
}

var (
	webviewMu          sync.Mutex
	sourceActionIDs    = map[string]sourceActionBinding{}
	sourceActionOwners = map[string]sourceActionOwner{}
	browserTickets     = map[string]*browserTicket{}
	webviewHealthAt    time.Time
	webviewHealthValue bool
)

func webviewServiceURL() string {
	return strings.TrimRight(env("LEGADO_WEBVIEW_URL", "http://legado-webview:9223"), "/")
}

func webviewHealthy() bool {
	webviewMu.Lock()
	if time.Since(webviewHealthAt) < 5*time.Second {
		value := webviewHealthValue
		webviewMu.Unlock()
		return value
	}
	webviewMu.Unlock()
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(webviewServiceURL() + "/health")
	value := false
	if err == nil {
		response.Body.Close()
		value = response.StatusCode == http.StatusOK
	}
	webviewMu.Lock()
	webviewHealthAt, webviewHealthValue = time.Now(), value
	webviewMu.Unlock()
	return value
}

func webviewRequest(ctx context.Context, method, path string, value any, output any) error {
	var body io.Reader
	if value != nil {
		encoded, _ := json.Marshal(value)
		body = bytes.NewReader(encoded)
	}
	request, _ := http.NewRequestWithContext(ctx, method, webviewServiceURL()+path, body)
	request.Header.Set("X-Engine-Token", os.Getenv("LEGADO_WEBVIEW_TOKEN"))
	if value != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := (&http.Client{Timeout: 35 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var problem struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&problem)
		if problem.Error == "" {
			problem.Error = fmt.Sprintf("WebView HTTP %d", response.StatusCode)
		}
		return errors.New(problem.Error)
	}
	if output != nil {
		return json.NewDecoder(io.LimitReader(response.Body, 20<<20)).Decode(output)
	}
	return nil
}

func handleSourceProfile(w http.ResponseWriter, r *http.Request, userID, sourceID string) {
	source, err := loadAccessibleBookSource(userID, sourceID)
	if err != nil || source.Type != "legado" {
		writeAPI(w, 404, 404, "书源不存在", nil)
		return
	}
	definition := string(source.Definition)
	stateUserID := userID
	if source.Shared {
		stateUserID = source.OwnerID
	}
	var definitionMap map[string]any
	if json.Unmarshal([]byte(definition), &definitionMap) != nil {
		writeAPI(w, 422, 422, "书源配置无效", nil)
		return
	}
	uiRaw, _ := definitionMap["loginUi"].(string)
	var fields []map[string]any
	if uiRaw != "" {
		_ = json.Unmarshal([]byte(uiRaw), &fields)
	} else if values, ok := definitionMap["loginUi"].([]any); ok {
		encoded, _ := json.Marshal(values)
		_ = json.Unmarshal(encoded, &fields)
	}
	webviewMu.Lock()
	now := time.Now()
	for id, item := range sourceActionIDs {
		if now.After(item.ExpiresAt) {
			delete(sourceActionIDs, id)
		}
	}
	for _, field := range fields {
		action, _ := field["action"].(string)
		delete(field, "action")
		if strings.TrimSpace(action) != "" {
			id := randomString(24)
			sourceActionIDs[id] = sourceActionBinding{AccountID: userID, StateUserID: stateUserID, Namespace: sourceNamespace(userID, source), SourceID: sourceID, Script: action, ExpiresAt: now.Add(30 * time.Minute)}
			field["action_id"] = id
		}
	}
	webviewMu.Unlock()
	state := "unknown"
	_ = db.QueryRow(`SELECT state FROM book_source_login_state WHERE user_id=? AND source_id=?`, stateUserID, sourceID).Scan(&state)
	writeAPI(w, 200, 200, "success", map[string]any{"fields": fields, "login_state": state})
}

func handleSourceAction(w http.ResponseWriter, r *http.Request, userID, sourceID string) {
	var body struct {
		ActionID string         `json:"action_id"`
		Values   map[string]any `json:"values"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	webviewMu.Lock()
	binding, ok := sourceActionIDs[body.ActionID]
	if ok {
		delete(sourceActionIDs, body.ActionID)
	}
	webviewMu.Unlock()
	if !ok || binding.AccountID != userID || binding.SourceID != sourceID || time.Now().After(binding.ExpiresAt) {
		writeAPI(w, 403, 403, "操作已失效，请重新打开书源设置", nil)
		return
	}
	source, err := loadAccessibleBookSource(userID, sourceID)
	if err != nil {
		writeAPI(w, 404, 404, "书源不存在", nil)
		return
	}
	payload := map[string]any{"source": source.Definition, "action": binding.Script, "values": body.Values, "namespace": binding.Namespace}
	encoded, _ := json.Marshal(payload)
	request, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, legadoEngineURL()+"/internal/actions", bytes.NewReader(encoded))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Engine-Token", os.Getenv("LEGADO_ENGINE_TOKEN"))
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		writeAPI(w, 502, 502, "规则引擎不可用", nil)
		return
	}
	defer response.Body.Close()
	var action map[string]any
	if response.StatusCode != http.StatusAccepted || json.NewDecoder(response.Body).Decode(&action) != nil {
		writeAPI(w, 422, 422, "书源操作启动失败", nil)
		return
	}
	id, _ := action["id"].(string)
	webviewMu.Lock()
	sourceActionOwners[id] = sourceActionOwner{AccountID: userID, StateUserID: binding.StateUserID, SourceID: sourceID}
	webviewMu.Unlock()
	writeAPI(w, 202, 202, "操作已开始", action)
}

func handleSourceActionEvents(w http.ResponseWriter, r *http.Request, id string) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	webviewMu.Lock()
	owner, ok := sourceActionOwners[id]
	webviewMu.Unlock()
	if !ok || owner.AccountID != auth.User.ID {
		writeAPI(w, 404, 404, "操作不存在", nil)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPI(w, 500, 500, "服务不支持流式响应", nil)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	for {
		request, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, legadoEngineURL()+"/internal/actions/"+url.PathEscape(id), nil)
		request.Header.Set("X-Engine-Token", os.Getenv("LEGADO_ENGINE_TOKEN"))
		response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
		if err != nil {
			return
		}
		var state map[string]any
		_ = json.NewDecoder(response.Body).Decode(&state)
		response.Body.Close()
		encoded, _ := json.Marshal(state)
		fmt.Fprintf(w, "data: %s\n\n", encoded)
		flusher.Flush()
		status, _ := state["status"].(string)
		if status == "ready" || status == "failed" {
			if status == "ready" {
				_, _ = db.Exec(`INSERT INTO book_source_login_state(user_id,source_id,state,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,source_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`, owner.StateUserID, owner.SourceID, "configured", time.Now().Unix())
			}
			fmt.Fprint(w, "data: [DONE]\n\n")
			flusher.Flush()
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Second):
		}
	}
}

type publicBrowserSession struct {
	ID        string `json:"id"`
	Namespace string `json:"namespace,omitempty"`
	Source    string `json:"source,omitempty"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	State     string `json:"state"`
	Error     string `json:"error,omitempty"`
	CreatedAt int64  `json:"created_at"`
	ExpiresAt int64  `json:"expires_at"`
}

func listBrowserSessions(ctx context.Context, userID string) ([]publicBrowserSession, error) {
	namespaces := []string{userID}
	rows, _ := db.Query(`SELECT source_id FROM shared_book_sources ORDER BY source_id`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var sourceID string
			if rows.Scan(&sourceID) == nil {
				namespaces = append(namespaces, "shared-source:"+sourceID)
			}
		}
	}
	var sessions []publicBrowserSession
	for _, namespace := range namespaces {
		var current []publicBrowserSession
		if err := webviewRequest(ctx, http.MethodGet, "/sessions?namespace="+url.QueryEscape(namespace), nil, &current); err != nil {
			return nil, err
		}
		sessions = append(sessions, current...)
	}
	for index := range sessions {
		sessions[index].Namespace = ""
		sessions[index].Source = ""
	}
	return sessions, nil
}

func ownedBrowserSession(ctx context.Context, userID, sessionID string) (publicBrowserSession, error) {
	var session publicBrowserSession
	if err := webviewRequest(ctx, http.MethodGet, "/sessions/"+url.PathEscape(sessionID), nil, &session); err != nil {
		return session, err
	}
	allowed := session.Namespace == userID
	if !allowed && strings.HasPrefix(session.Namespace, "shared-source:") {
		sourceID := strings.TrimPrefix(session.Namespace, "shared-source:")
		var exists int
		_ = db.QueryRow(`SELECT COUNT(*) FROM shared_book_sources WHERE source_id=?`, sourceID).Scan(&exists)
		allowed = exists > 0
	}
	if !allowed {
		return session, errors.New("browser session does not belong to account")
	}
	return session, nil
}

func handleBrowserSessions(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/ws") {
		handleBrowserWebSocket(w, r)
		return
	}
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/book-browser-sessions"), "/"), "/")
	if len(parts) == 1 && parts[0] == "" {
		if r.Method != http.MethodGet {
			writeAPI(w, 405, 405, "请求方法不支持", nil)
			return
		}
		items, err := listBrowserSessions(r.Context(), auth.User.ID)
		if err != nil {
			writeAPI(w, 502, 502, "浏览器服务不可用", nil)
			return
		}
		writeAPI(w, 200, 200, "success", items)
		return
	}
	id := parts[0]
	if _, err := ownedBrowserSession(r.Context(), auth.User.ID, id); err != nil {
		writeAPI(w, 404, 404, "浏览器会话不存在", nil)
		return
	}
	if len(parts) == 2 && parts[1] == "ticket" && r.Method == http.MethodPost {
		ticket := randomString(32)
		webviewMu.Lock()
		browserTickets[ticket] = &browserTicket{UserID: auth.User.ID, SessionID: id, ExpiresAt: time.Now().Add(time.Minute)}
		webviewMu.Unlock()
		writeAPI(w, 200, 200, "success", map[string]any{"ticket": ticket, "expires_in": 60})
		return
	}
	if len(parts) == 1 && (r.Method == http.MethodPost || r.Method == http.MethodDelete) {
		path := "/sessions/" + url.PathEscape(id)
		if r.Method == http.MethodPost {
			path += "/finish"
		}
		if err := webviewRequest(r.Context(), r.Method, path, map[string]any{}, nil); err != nil {
			writeAPI(w, 422, 422, err.Error(), nil)
			return
		}
		writeAPI(w, 200, 200, "success", nil)
		return
	}
	writeAPI(w, 405, 405, "请求方法不支持", nil)
}

func handleBrowserWebSocket(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/book-browser-sessions"), "/"), "/")
	if len(parts) != 2 || parts[1] != "ws" {
		writeAPI(w, 404, 404, "会话不存在", nil)
		return
	}
	ticketValue := r.URL.Query().Get("ticket")
	webviewMu.Lock()
	ticket, ok := browserTickets[ticketValue]
	if ok && (!ticket.Used && ticket.SessionID == parts[0] && time.Now().Before(ticket.ExpiresAt)) {
		ticket.Used = true
	} else {
		ok = false
	}
	webviewMu.Unlock()
	if !ok {
		http.Error(w, "invalid browser ticket", http.StatusUnauthorized)
		return
	}
	target, _ := url.Parse(webviewServiceURL())
	proxy := httputil.NewSingleHostReverseProxy(target)
	original := proxy.Director
	proxy.Director = func(request *http.Request) {
		original(request)
		request.URL.Path = "/sessions/" + url.PathEscape(parts[0]) + "/ws"
		request.URL.RawQuery = ""
		request.Header.Set("X-Engine-Token", os.Getenv("LEGADO_WEBVIEW_TOKEN"))
	}
	proxy.ServeHTTP(w, r)
}

func clearBrowserState(ctx context.Context, userID, source string) {
	_ = webviewRequest(ctx, http.MethodDelete, "/state", map[string]string{"namespace": userID, "source": source}, nil)
}

func clearEngineSourceState(ctx context.Context, userID, definition string) {
	payload, _ := json.Marshal(map[string]any{"namespace": userID, "source": json.RawMessage(definition)})
	request, _ := http.NewRequestWithContext(ctx, http.MethodDelete, legadoEngineURL()+"/internal/state", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Engine-Token", os.Getenv("LEGADO_ENGINE_TOKEN"))
	if response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request); err == nil {
		response.Body.Close()
	}
}
