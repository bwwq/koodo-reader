package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxBookSources       = 200
	maxSearchSources     = 8
	searchResultTTL      = 30 * time.Minute
	generatedFileTTL     = 24 * time.Hour
	maxSourceDefinition  = int64(5 << 20)
	maxGeneratedBookSize = int64(512 << 20)
)

type bookSource struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	Name       string          `json:"name"`
	Group      string          `json:"group,omitempty"`
	URL        string          `json:"url"`
	Enabled    bool            `json:"enabled"`
	BuiltIn    bool            `json:"built_in,omitempty"`
	Searchable bool            `json:"searchable"`
	Definition json.RawMessage `json:"-"`
	UpdatedAt  int64           `json:"updated_at,omitempty"`
}

type cachedSearchResult struct {
	ID          string          `json:"id"`
	UserID      string          `json:"-"`
	SourceID    string          `json:"source_id"`
	SourceName  string          `json:"source_name"`
	SourceType  string          `json:"source_type"`
	Title       string          `json:"title"`
	Authors     []string        `json:"authors"`
	Summary     string          `json:"summary,omitempty"`
	CoverURL    string          `json:"cover_url,omitempty"`
	Latest      string          `json:"latest_chapter,omitempty"`
	Format      string          `json:"format,omitempty"`
	Raw         json.RawMessage `json:"-"`
	DownloadURL string          `json:"-"`
	ExpiresAt   time.Time       `json:"-"`
}

type importJob struct {
	ID             string `json:"id"`
	Status         string `json:"status"`
	Stage          string `json:"stage"`
	Current        int    `json:"current"`
	Total          int    `json:"total"`
	Error          string `json:"error,omitempty"`
	Ready          bool   `json:"ready"`
	FileName       string `json:"file_name,omitempty"`
	SubscriptionID string `json:"subscription_id,omitempty"`
	CreatedAt      int64  `json:"created_at"`
	UpdatedAt      int64  `json:"updated_at"`
}

type bookSubscription struct {
	ID               string `json:"id"`
	SourceID         string `json:"source_id"`
	SourceName       string `json:"source_name"`
	Title            string `json:"title"`
	LastChapterCount int    `json:"last_chapter_count"`
	LastChapter      string `json:"last_chapter,omitempty"`
	CheckedAt        int64  `json:"checked_at,omitempty"`
	UpdatedAt        int64  `json:"updated_at"`
}

var (
	searchCacheMu sync.Mutex
	searchCache   = map[string]cachedSearchResult{}
	jobMu         sync.Mutex
	activeJobs    = map[string]context.CancelFunc{}
)

var builtInBookSources = []bookSource{
	{ID: "builtin-project-gutenberg", Type: "opds", Name: "Project Gutenberg", URL: "https://www.gutenberg.org/ebooks.opds/", Enabled: true, BuiltIn: true, Searchable: true},
	{ID: "builtin-internet-archive", Type: "opds", Name: "Internet Archive", URL: "https://archive.org/services/opds", Enabled: true, BuiltIn: true, Searchable: true},
	{ID: "builtin-textos-info", Type: "opds", Name: "textos.info (Español)", URL: "https://www.textos.info/catalogo.atom", Enabled: true, BuiltIn: true, Searchable: true},
}

func initBookSourceSchema() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS book_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			type TEXT NOT NULL CHECK(type IN ('opds','legado')),
			name TEXT NOT NULL,
			group_name TEXT NOT NULL DEFAULT '',
			source_url TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			definition TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(user_id,type,source_url)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_book_sources_user ON book_sources(user_id,enabled)`,
		`CREATE TABLE IF NOT EXISTS book_import_jobs (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			source_id TEXT NOT NULL,
			source_type TEXT NOT NULL,
			engine_job_id TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			stage TEXT NOT NULL,
			current INTEGER NOT NULL DEFAULT 0,
			total INTEGER NOT NULL DEFAULT 0,
			error TEXT NOT NULL DEFAULT '',
			file_name TEXT NOT NULL DEFAULT '',
			file_path TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_book_import_jobs_user ON book_import_jobs(user_id,updated_at)`,
		`CREATE TABLE IF NOT EXISTS book_source_subscriptions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			source_id TEXT NOT NULL,
			book_fingerprint TEXT NOT NULL,
			title TEXT NOT NULL,
			raw_result TEXT NOT NULL,
			last_chapter_count INTEGER NOT NULL DEFAULT 0,
			last_chapter_key TEXT NOT NULL DEFAULT '',
			last_chapter_title TEXT NOT NULL DEFAULT '',
			checked_at INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(user_id,source_id,book_fingerprint)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_book_source_subscriptions_user ON book_source_subscriptions(user_id,updated_at)`,
		`CREATE TABLE IF NOT EXISTS book_import_subscriptions (
			job_id TEXT PRIMARY KEY REFERENCES book_import_jobs(id) ON DELETE CASCADE,
			subscription_id TEXT NOT NULL REFERENCES book_source_subscriptions(id) ON DELETE CASCADE
		)`,
	}
}

func handleBookSourceRoutes(w http.ResponseWriter, r *http.Request) bool {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/book-sources":
		handleListBookSources(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/book-sources/import":
		handleImportBookSources(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/book-sources/search":
		handleSearchBookSources(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/book-sources/"):
		handleBookSourceItem(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/book-subscriptions":
		handleListBookSubscriptions(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/book-subscriptions/"):
		handleBookSubscriptionItem(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/book-imports":
		handleListBookImports(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/book-imports":
		handleCreateBookImport(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/book-imports/"):
		handleBookImportItem(w, r)
	default:
		return false
	}
	return true
}

func handleListBookImports(w http.ResponseWriter, r *http.Request) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	rows, err := db.Query(`SELECT id FROM book_import_jobs
		WHERE user_id=? AND expires_at>? AND status IN ('queued','running','ready')
		ORDER BY created_at ASC LIMIT 20`, auth.User.ID, time.Now().Unix())
	if err != nil {
		writeAPI(w, 500, 500, "读取导入任务失败", nil)
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()

	items := make([]importJob, 0, len(ids))
	for _, id := range ids {
		if job, readErr := readImportJob(auth.User.ID, id, true); readErr == nil &&
			(job.Status == "queued" || job.Status == "running" || job.Status == "ready") {
			items = append(items, job)
		}
	}
	writeAPI(w, 200, 200, "success", items)
}

func handleListBookSources(w http.ResponseWriter, r *http.Request) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	items := append([]bookSource{}, builtInBookSources...)
	rows, err := db.Query(`SELECT id,type,name,group_name,source_url,enabled,definition,updated_at FROM book_sources WHERE user_id=? ORDER BY name COLLATE NOCASE`, auth.User.ID)
	if err != nil {
		writeAPI(w, 500, 500, "读取书源失败", nil)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var item bookSource
		var enabled int
		var definition string
		if err := rows.Scan(&item.ID, &item.Type, &item.Name, &item.Group, &item.URL, &enabled, &definition, &item.UpdatedAt); err != nil {
			continue
		}
		item.Enabled, item.Searchable = enabled == 1, true
		item.Definition = json.RawMessage(definition)
		items = append(items, item)
	}
	writeAPI(w, 200, 200, "success", items)
}

func handleImportBookSources(w http.ResponseWriter, r *http.Request) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSourceDefinition)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeAPI(w, 413, 413, "书源文件过大", nil)
		return
	}
	var envelope struct {
		URL      string          `json:"url"`
		Content  json.RawMessage `json:"content"`
		Type     string          `json:"type"`
		Name     string          `json:"name"`
		Username string          `json:"username"`
		Password string          `json:"password"`
	}
	definition := body
	if json.Unmarshal(body, &envelope) == nil && (envelope.URL != "" || len(envelope.Content) > 0 || envelope.Type == "opds") {
		if envelope.URL != "" && envelope.Type != "opds" {
			definition, err = fetchLimitedJSON(r.Context(), envelope.URL)
			if err != nil {
				writeAPI(w, 422, 422, "读取远程书源失败: "+err.Error(), nil)
				return
			}
		} else if len(envelope.Content) > 0 {
			definition = envelope.Content
		}
		if envelope.Type == "opds" {
			if err := upsertOPDSSource(auth.User.ID, envelope.Name, envelope.URL, envelope.Username, envelope.Password); err != nil {
				writeAPI(w, 422, 422, err.Error(), nil)
				return
			}
			writeAPI(w, 200, 200, "书源已导入", map[string]int{"imported": 1})
			return
		}
	}
	var values []json.RawMessage
	if len(definition) > 0 && definition[0] == '[' {
		if err := json.Unmarshal(definition, &values); err != nil {
			writeAPI(w, 422, 422, "书源 JSON 无效", nil)
			return
		}
	} else {
		values = []json.RawMessage{definition}
	}
	if len(values) == 0 {
		writeAPI(w, 422, 422, "没有可导入的书源", nil)
		return
	}
	var count int
	for _, raw := range values {
		var source struct {
			URL     string `json:"bookSourceUrl"`
			Name    string `json:"bookSourceName"`
			Group   string `json:"bookSourceGroup"`
			Enabled *bool  `json:"enabled"`
		}
		if json.Unmarshal(raw, &source) != nil || strings.TrimSpace(source.URL) == "" || strings.TrimSpace(source.Name) == "" {
			writeAPI(w, 422, 422, "阅读书源缺少 bookSourceUrl 或 bookSourceName", nil)
			return
		}
		if containsForbiddenSourceCode(string(raw)) {
			writeAPI(w, 422, 422, "书源包含禁止的系统访问或 WebView 规则", nil)
			return
		}
		if err := ensureSourceCapacity(auth.User.ID, source.URL, 1); err != nil {
			writeAPI(w, 422, 422, err.Error(), nil)
			return
		}
		enabled := 1
		if source.Enabled != nil && !*source.Enabled {
			enabled = 0
		}
		now := time.Now().Unix()
		_, err = db.Exec(`INSERT INTO book_sources(id,user_id,type,name,group_name,source_url,enabled,definition,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
			ON CONFLICT(user_id,type,source_url) DO UPDATE SET name=excluded.name,group_name=excluded.group_name,enabled=excluded.enabled,definition=excluded.definition,updated_at=excluded.updated_at`,
			randomString(18), auth.User.ID, "legado", source.Name, source.Group, source.URL, enabled, string(raw), now)
		if err != nil {
			writeAPI(w, 500, 500, "保存书源失败", nil)
			return
		}
		count++
	}
	writeAPI(w, 200, 200, "书源已导入", map[string]int{"imported": count})
}

func containsForbiddenSourceCode(raw string) bool {
	lower := strings.ToLower(raw)
	for _, value := range []string{"packages", "java.lang", "processbuilder", "runtime.getruntime", "classloader", "java.io", "java.nio", `"webview":true`} {
		if strings.Contains(strings.ReplaceAll(lower, " ", ""), value) {
			return true
		}
	}
	return false
}

func ensureSourceCapacity(userID, sourceURL string, incoming int) error {
	var count int
	_ = db.QueryRow(`SELECT COUNT(*) FROM book_sources WHERE user_id=?`, userID).Scan(&count)
	var exists int
	_ = db.QueryRow(`SELECT COUNT(*) FROM book_sources WHERE user_id=? AND source_url=?`, userID, sourceURL).Scan(&exists)
	if exists == 0 && count+incoming > maxBookSources {
		return fmt.Errorf("每个账号最多保存 %d 个书源", maxBookSources)
	}
	return nil
}

func upsertOPDSSource(userID, name, sourceURL, username, password string) error {
	if strings.TrimSpace(name) == "" {
		name = sourceURL
	}
	if _, err := validateRemoteURL(sourceURL); err != nil {
		return err
	}
	if err := ensureSourceCapacity(userID, sourceURL, 1); err != nil {
		return err
	}
	definition, _ := json.Marshal(map[string]string{"url": sourceURL, "name": name, "username": username, "password": password})
	_, err := db.Exec(`INSERT INTO book_sources(id,user_id,type,name,source_url,enabled,definition,updated_at) VALUES(?,?,?,?,?,1,?,?)
		ON CONFLICT(user_id,type,source_url) DO UPDATE SET name=excluded.name,definition=excluded.definition,updated_at=excluded.updated_at`, randomString(18), userID, "opds", name, sourceURL, string(definition), time.Now().Unix())
	return err
}

func handleBookSourceItem(w http.ResponseWriter, r *http.Request) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/v1/book-sources/")
	if id == "" || strings.Contains(id, "/") {
		writeAPI(w, 404, 404, "书源不存在", nil)
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var body struct {
			Name    *string `json:"name"`
			Group   *string `json:"group"`
			Enabled *bool   `json:"enabled"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		var name, group string
		var enabled int
		if db.QueryRow(`SELECT name,group_name,enabled FROM book_sources WHERE id=? AND user_id=?`, id, auth.User.ID).Scan(&name, &group, &enabled) != nil {
			writeAPI(w, 404, 404, "书源不存在", nil)
			return
		}
		if body.Name != nil && strings.TrimSpace(*body.Name) != "" {
			name = strings.TrimSpace(*body.Name)
		}
		if body.Group != nil {
			group = strings.TrimSpace(*body.Group)
		}
		if body.Enabled != nil {
			if *body.Enabled {
				enabled = 1
			} else {
				enabled = 0
			}
		}
		_, _ = db.Exec(`UPDATE book_sources SET name=?,group_name=?,enabled=?,updated_at=? WHERE id=? AND user_id=?`, name, group, enabled, time.Now().Unix(), id, auth.User.ID)
		writeAPI(w, 200, 200, "success", nil)
	case http.MethodDelete:
		result, _ := db.Exec(`DELETE FROM book_sources WHERE id=? AND user_id=?`, id, auth.User.ID)
		rows, _ := result.RowsAffected()
		if rows == 0 {
			writeAPI(w, 404, 404, "书源不存在", nil)
			return
		}
		writeAPI(w, 200, 200, "success", nil)
	default:
		writeAPI(w, 405, 405, "请求方法不支持", nil)
	}
}

func handleSearchBookSources(w http.ResponseWriter, r *http.Request) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	var body struct {
		Keyword   string   `json:"keyword"`
		SourceIDs []string `json:"source_ids"`
		Page      int      `json:"page"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	body.Keyword = strings.TrimSpace(body.Keyword)
	if body.Keyword == "" {
		writeAPI(w, 422, 422, "请输入搜索内容", nil)
		return
	}
	if len(body.SourceIDs) == 0 || len(body.SourceIDs) > maxBookSources+len(builtInBookSources) {
		writeAPI(w, 422, 422, "请选择有效的书源", nil)
		return
	}
	sources, err := loadSelectedSources(auth.User.ID, body.SourceIDs)
	if err != nil {
		writeAPI(w, 422, 422, err.Error(), nil)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPI(w, 500, 500, "服务不支持流式响应", nil)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	flusher.Flush()
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	type event struct{ Value any }
	results := make(chan event, len(sources)*3)
	semaphore := make(chan struct{}, maxSearchSources)
	var wg sync.WaitGroup
	for _, source := range sources {
		wg.Add(1)
		go func(source bookSource) {
			defer wg.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				return
			}
			results <- event{map[string]any{"type": "source_started", "source_id": source.ID}}
			items, err := searchOneSource(ctx, auth.User.ID, source, body.Keyword, max(1, body.Page))
			if err != nil {
				results <- event{map[string]any{"type": "source_error", "source_id": source.ID, "message": err.Error()}}
				return
			}
			for _, item := range items {
				cacheSearchResult(item)
				results <- event{map[string]any{"type": "result", "result": item}}
			}
			results <- event{map[string]any{"type": "source_finished", "source_id": source.ID, "count": len(items)}}
		}(source)
	}
	go func() { wg.Wait(); close(results) }()
	for item := range results {
		data, _ := json.Marshal(item.Value)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func loadSelectedSources(userID string, ids []string) ([]bookSource, error) {
	seen := map[string]bool{}
	result := make([]bookSource, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		var found *bookSource
		for i := range builtInBookSources {
			if builtInBookSources[i].ID == id {
				copy := builtInBookSources[i]
				found = &copy
				break
			}
		}
		if found == nil {
			var item bookSource
			var enabled int
			var definition string
			err := db.QueryRow(`SELECT id,type,name,group_name,source_url,enabled,definition,updated_at FROM book_sources WHERE id=? AND user_id=?`, id, userID).Scan(&item.ID, &item.Type, &item.Name, &item.Group, &item.URL, &enabled, &definition, &item.UpdatedAt)
			if err != nil {
				return nil, errors.New("书源不存在或不属于当前账号")
			}
			item.Enabled, item.Searchable, item.Definition = enabled == 1, true, json.RawMessage(definition)
			found = &item
		}
		if !found.Enabled {
			return nil, fmt.Errorf("书源 %s 已停用", found.Name)
		}
		result = append(result, *found)
	}
	return result, nil
}

func searchOneSource(ctx context.Context, userID string, source bookSource, keyword string, page int) ([]cachedSearchResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if source.Type == "legado" {
		return searchLegado(ctx, userID, source, keyword, page)
	}
	return searchOPDS(ctx, userID, source, keyword, page)
}

func searchLegado(ctx context.Context, userID string, source bookSource, keyword string, page int) ([]cachedSearchResult, error) {
	payload, _ := json.Marshal(map[string]any{"source": json.RawMessage(source.Definition), "keyword": keyword, "page": page, "namespace": userID})
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, legadoEngineURL()+"/internal/search", strings.NewReader(string(payload)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Engine-Token", os.Getenv("LEGADO_ENGINE_TOKEN"))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("规则引擎不可用: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("规则引擎返回 %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	var decoded struct {
		Items []json.RawMessage `json:"items"`
	}
	if json.NewDecoder(response.Body).Decode(&decoded) != nil {
		return nil, errors.New("规则引擎响应无效")
	}
	items := make([]cachedSearchResult, 0, len(decoded.Items))
	for _, raw := range decoded.Items {
		var item struct{ Name, Author, Intro, CoverURL, Latest string }
		var fields map[string]any
		_ = json.Unmarshal(raw, &fields)
		item.Name, _ = fields["name"].(string)
		item.Author, _ = fields["author"].(string)
		item.Intro, _ = fields["intro"].(string)
		item.CoverURL, _ = fields["coverUrl"].(string)
		item.Latest, _ = fields["latestChapterTitle"].(string)
		if item.Name == "" {
			continue
		}
		items = append(items, cachedSearchResult{ID: randomString(24), UserID: userID, SourceID: source.ID, SourceName: source.Name, SourceType: "legado", Title: item.Name, Authors: nonEmpty(item.Author), Summary: item.Intro, CoverURL: item.CoverURL, Latest: item.Latest, Raw: raw, ExpiresAt: time.Now().Add(searchResultTTL)})
	}
	return items, nil
}

type atomFeed struct {
	Entries []atomEntry `xml:"entry"`
	Links   []atomLink  `xml:"link"`
}
type atomEntry struct {
	Title   string `xml:"title"`
	Summary string `xml:"summary"`
	Content string `xml:"content"`
	Authors []struct {
		Name string `xml:"name"`
	} `xml:"author"`
	Links []atomLink `xml:"link"`
}
type atomLink struct {
	Rel  string `xml:"rel,attr"`
	Type string `xml:"type,attr"`
	Href string `xml:"href,attr"`
}

type opds2Link struct {
	Href string `json:"href"`
	Type string `json:"type"`
	Rel  string `json:"rel"`
}

type opds2Publication struct {
	Metadata struct {
		Title       any `json:"title"`
		Description any `json:"description"`
		Authors     []struct {
			Name string `json:"name"`
		} `json:"author"`
	} `json:"metadata"`
	Links  []opds2Link `json:"links"`
	Images []opds2Link `json:"images"`
}

type opds2Feed struct {
	Links        []opds2Link        `json:"links"`
	Publications []opds2Publication `json:"publications"`
	Groups       []struct {
		Publications []opds2Publication `json:"publications"`
	} `json:"groups"`
}

func searchOPDS(ctx context.Context, userID string, source bookSource, keyword string, page int) ([]cachedSearchResult, error) {
	searchURL := source.URL
	switch source.ID {
	case "builtin-project-gutenberg":
		searchURL = "https://www.gutenberg.org/ebooks/search.opds/?query=" + url.QueryEscape(keyword) + "&start_index=" + strconv.Itoa((page-1)*25+1)
	case "builtin-internet-archive":
		return searchInternetArchive(ctx, userID, source, keyword, page)
	}
	var credentials struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	_ = json.Unmarshal(source.Definition, &credentials)
	var feed atomFeed
	var jsonFeed *opds2Feed
	pagesToFollow := page
	if source.ID == "builtin-project-gutenberg" {
		pagesToFollow = 1
	}
	for currentPage := 1; currentPage <= pagesToFollow; currentPage++ {
		response, err := safeHTTPGetWithAuth(ctx, searchURL, "application/atom+xml, application/opds+json, application/json, application/xml", credentials.Username, credentials.Password)
		if err != nil {
			return nil, err
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 10<<20))
		response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		feed = atomFeed{}
		jsonFeed = nil
		if strings.HasPrefix(strings.TrimSpace(string(data)), "{") {
			var parsed opds2Feed
			if json.Unmarshal(data, &parsed) != nil {
				return nil, errors.New("OPDS 2 响应无效")
			}
			jsonFeed = &parsed
		} else if xml.Unmarshal(data, &feed) != nil {
			return nil, errors.New("暂不支持此 OPDS 搜索响应")
		}
		if currentPage < pagesToFollow {
			nextURL := ""
			links := feed.Links
			if jsonFeed != nil {
				links = nil
				for _, link := range jsonFeed.Links {
					links = append(links, atomLink{Rel: link.Rel, Type: link.Type, Href: link.Href})
				}
			}
			for _, link := range links {
				if strings.EqualFold(link.Rel, "next") {
					nextURL = resolveRemote(link.Href, searchURL)
					break
				}
			}
			if nextURL == "" {
				return []cachedSearchResult{}, nil
			}
			searchURL = nextURL
		}
	}
	if jsonFeed != nil {
		publications := append([]opds2Publication{}, jsonFeed.Publications...)
		for _, group := range jsonFeed.Groups {
			publications = append(publications, group.Publications...)
		}
		return convertOPDS2Publications(userID, source, publications), nil
	}
	needle := strings.ToLower(keyword)
	items := []cachedSearchResult{}
	for _, entry := range feed.Entries {
		authors := []string{}
		for _, author := range entry.Authors {
			if author.Name != "" {
				authors = append(authors, author.Name)
			}
		}
		if (source.ID == "builtin-textos-info" || !source.BuiltIn) && !strings.Contains(strings.ToLower(entry.Title+" "+strings.Join(authors, " ")), needle) {
			continue
		}
		download, format := "", ""
		cover := ""
		for _, link := range entry.Links {
			href := resolveRemote(link.Href, searchURL)
			if strings.Contains(link.Rel, "image") {
				cover = href
			}
			if strings.Contains(link.Rel, "acquisition") && download == "" {
				if supportedDownloadType(link.Type, href) {
					download, format = href, fileExt(href, link.Type)
				}
			}
		}
		if download == "" {
			continue
		}
		items = append(items, cachedSearchResult{ID: randomString(24), UserID: userID, SourceID: source.ID, SourceName: source.Name, SourceType: "opds", Title: entry.Title, Authors: authors, Summary: firstNonEmpty(entry.Summary, entry.Content), CoverURL: cover, Format: format, DownloadURL: download, ExpiresAt: time.Now().Add(searchResultTTL)})
	}
	return items, nil
}

func searchInternetArchive(ctx context.Context, userID string, source bookSource, keyword string, page int) ([]cachedSearchResult, error) {
	endpoint := "https://archive.org/services/opds/catalog?type=search&query=" + url.QueryEscape(keyword) + "&page=" + strconv.Itoa(page)
	response, err := safeHTTPGet(ctx, endpoint, "application/json")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var decoded opds2Feed
	if json.NewDecoder(io.LimitReader(response.Body, 10<<20)).Decode(&decoded) != nil {
		return nil, errors.New("Internet Archive 响应无效")
	}
	return convertOPDS2Publications(userID, source, decoded.Publications), nil
}

func convertOPDS2Publications(userID string, source bookSource, publications []opds2Publication) []cachedSearchResult {
	items := []cachedSearchResult{}
	for _, publication := range publications {
		title := anyString(publication.Metadata.Title)
		if title == "" {
			continue
		}
		authors := []string{}
		for _, author := range publication.Metadata.Authors {
			if author.Name != "" {
				authors = append(authors, author.Name)
			}
		}
		download, format := "", ""
		for _, link := range publication.Links {
			if strings.Contains(link.Rel, "acquisition/open-access") && supportedDownloadType(link.Type, link.Href) {
				download, format = link.Href, fileExt(link.Href, link.Type)
				break
			}
		}
		if download == "" {
			continue
		}
		cover := ""
		for _, image := range publication.Images {
			if cover == "" || strings.Contains(image.Rel, "cover") {
				cover = image.Href
			}
		}
		items = append(items, cachedSearchResult{ID: randomString(24), UserID: userID, SourceID: source.ID, SourceName: source.Name, SourceType: "opds", Title: title, Authors: authors, Summary: anyString(publication.Metadata.Description), CoverURL: cover, Format: format, DownloadURL: download, ExpiresAt: time.Now().Add(searchResultTTL)})
	}
	return items
}

func handleListBookSubscriptions(w http.ResponseWriter, r *http.Request) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	rows, err := db.Query(`SELECT s.id,s.source_id,COALESCE(b.name,''),s.title,s.last_chapter_count,s.last_chapter_title,s.checked_at,s.updated_at FROM book_source_subscriptions s LEFT JOIN book_sources b ON b.id=s.source_id AND b.user_id=s.user_id WHERE s.user_id=? ORDER BY s.updated_at DESC`, auth.User.ID)
	if err != nil {
		writeAPI(w, 500, 500, "读取追更列表失败", nil)
		return
	}
	defer rows.Close()
	items := []bookSubscription{}
	for rows.Next() {
		var item bookSubscription
		if rows.Scan(&item.ID, &item.SourceID, &item.SourceName, &item.Title, &item.LastChapterCount, &item.LastChapter, &item.CheckedAt, &item.UpdatedAt) == nil {
			items = append(items, item)
		}
	}
	writeAPI(w, 200, 200, "success", items)
}

func handleBookSubscriptionItem(w http.ResponseWriter, r *http.Request) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/book-subscriptions/"), "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeAPI(w, 404, 404, "追更任务不存在", nil)
		return
	}
	id := parts[0]
	if len(parts) == 1 && r.Method == http.MethodDelete {
		result, _ := db.Exec(`DELETE FROM book_source_subscriptions WHERE id=? AND user_id=?`, id, auth.User.ID)
		if count, _ := result.RowsAffected(); count == 0 {
			writeAPI(w, 404, 404, "追更任务不存在", nil)
			return
		}
		writeAPI(w, 200, 200, "已停止追更", nil)
		return
	}
	if len(parts) != 2 || r.Method != http.MethodPost {
		writeAPI(w, 405, 405, "请求方法不支持", nil)
		return
	}
	switch parts[1] {
	case "check":
		checkBookSubscription(w, r, auth.User.ID, id)
	case "import":
		importBookSubscription(w, auth.User.ID, id)
	default:
		writeAPI(w, 404, 404, "追更任务不存在", nil)
	}
}

func checkBookSubscription(w http.ResponseWriter, r *http.Request, userID, id string) {
	var definition, raw, title, sourceName, sourceID string
	var previousCount int
	var previousKey string
	err := db.QueryRow(`SELECT s.source_id,s.title,s.raw_result,s.last_chapter_count,s.last_chapter_key,b.name,b.definition FROM book_source_subscriptions s JOIN book_sources b ON b.id=s.source_id AND b.user_id=s.user_id WHERE s.id=? AND s.user_id=? AND b.enabled=1`, id, userID).Scan(&sourceID, &title, &raw, &previousCount, &previousKey, &sourceName, &definition)
	if err != nil {
		writeAPI(w, 404, 404, "书源已停用或不存在", nil)
		return
	}
	payload, _ := json.Marshal(map[string]any{"source": json.RawMessage(definition), "book": json.RawMessage(raw), "namespace": userID})
	ctx, cancel := context.WithTimeout(r.Context(), 155*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, legadoEngineURL()+"/internal/check", strings.NewReader(string(payload)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Engine-Token", os.Getenv("LEGADO_ENGINE_TOKEN"))
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		writeAPI(w, 502, 502, "检查更新失败: "+err.Error(), nil)
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		writeAPI(w, 502, 502, "检查更新失败: "+strings.TrimSpace(string(message)), nil)
		return
	}
	var checked struct {
		ChapterCount int    `json:"chapter_count"`
		Latest       string `json:"latest_chapter"`
		LatestURL    string `json:"latest_chapter_url"`
	}
	if json.NewDecoder(response.Body).Decode(&checked) != nil || checked.ChapterCount <= 0 {
		writeAPI(w, 502, 502, "规则引擎返回了无效目录", nil)
		return
	}
	now := time.Now().Unix()
	currentKey := firstNonEmpty(checked.LatestURL, checked.Latest)
	updateAvailable := previousCount > 0 && (checked.ChapterCount > previousCount || (checked.ChapterCount == previousCount && previousKey != "" && currentKey != "" && currentKey != previousKey))
	if previousCount == 0 {
		_, _ = db.Exec(`UPDATE book_source_subscriptions SET last_chapter_count=?,last_chapter_key=?,last_chapter_title=?,checked_at=?,updated_at=? WHERE id=? AND user_id=?`, checked.ChapterCount, currentKey, checked.Latest, now, now, id, userID)
	} else {
		_, _ = db.Exec(`UPDATE book_source_subscriptions SET checked_at=? WHERE id=? AND user_id=?`, now, id, userID)
	}
	writeAPI(w, 200, 200, "检查完成", map[string]any{"id": id, "title": title, "source_name": sourceName, "source_id": sourceID, "update_available": updateAvailable, "previous_count": previousCount, "chapter_count": checked.ChapterCount, "latest_chapter": checked.Latest})
}

func importBookSubscription(w http.ResponseWriter, userID, id string) {
	var result cachedSearchResult
	var raw string
	err := db.QueryRow(`SELECT s.source_id,b.name,s.title,s.raw_result FROM book_source_subscriptions s JOIN book_sources b ON b.id=s.source_id AND b.user_id=s.user_id WHERE s.id=? AND s.user_id=? AND b.enabled=1`, id, userID).Scan(&result.SourceID, &result.SourceName, &result.Title, &raw)
	if err != nil {
		writeAPI(w, 404, 404, "书源已停用或不存在", nil)
		return
	}
	result.UserID, result.SourceType, result.Raw = userID, "legado", json.RawMessage(raw)
	job, status, err := startImportJob(userID, result, id)
	if err != nil {
		writeAPI(w, status, status, err.Error(), nil)
		return
	}
	writeAPI(w, 202, 202, "更新任务已加入队列", job)
}

func handleCreateBookImport(w http.ResponseWriter, r *http.Request) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	var body struct {
		ResultID string `json:"result_id"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	result, ok := getCachedResult(auth.User.ID, body.ResultID)
	if !ok {
		writeAPI(w, 404, 404, "搜索结果已失效，请重新搜索", nil)
		return
	}
	subscriptionID := ""
	if result.SourceType == "legado" {
		var err error
		subscriptionID, err = ensureBookSubscription(auth.User.ID, result)
		if err != nil {
			writeAPI(w, 500, 500, "保存追更信息失败", nil)
			return
		}
	}
	job, status, err := startImportJob(auth.User.ID, result, subscriptionID)
	if err != nil {
		writeAPI(w, status, status, err.Error(), nil)
		return
	}
	writeAPI(w, 202, 202, "任务已创建", job)
}

func startImportJob(userID string, result cachedSearchResult, subscriptionID string) (importJob, int, error) {
	var running int
	_ = db.QueryRow(`SELECT COUNT(*) FROM book_import_jobs WHERE user_id=? AND status IN ('queued','running')`, userID).Scan(&running)
	if running >= 1 {
		return importJob{}, 429, errors.New("每个账号同时只能生成一本书")
	}
	id := randomString(20)
	now := time.Now().Unix()
	tx, err := db.Begin()
	if err != nil {
		return importJob{}, 500, errors.New("创建导入任务失败")
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO book_import_jobs(id,user_id,source_id,source_type,status,stage,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, userID, result.SourceID, result.SourceType, "queued", "queued", now, now, time.Now().Add(generatedFileTTL).Unix())
	if err == nil && subscriptionID != "" {
		_, err = tx.Exec(`INSERT INTO book_import_subscriptions(job_id,subscription_id) VALUES(?,?)`, id, subscriptionID)
	}
	if err != nil || tx.Commit() != nil {
		return importJob{}, 500, errors.New("创建导入任务失败")
	}
	ctx, cancel := context.WithCancel(context.Background())
	jobMu.Lock()
	activeJobs[id] = cancel
	jobMu.Unlock()
	go runImportJob(ctx, id, userID, result)
	return importJob{ID: id, Status: "queued", Stage: "queued", SubscriptionID: subscriptionID, CreatedAt: now, UpdatedAt: now}, 202, nil
}

func ensureBookSubscription(userID string, result cachedSearchResult) (string, error) {
	var fields map[string]any
	_ = json.Unmarshal(result.Raw, &fields)
	bookRef := firstNonEmpty(anyString(fields["bookUrl"]), anyString(fields["tocUrl"]), result.Title+"\n"+strings.Join(result.Authors, "\n"))
	fingerprint := tokenHash(result.SourceID + "\n" + bookRef)
	var id string
	err := db.QueryRow(`SELECT id FROM book_source_subscriptions WHERE user_id=? AND source_id=? AND book_fingerprint=?`, userID, result.SourceID, fingerprint).Scan(&id)
	now := time.Now().Unix()
	if err == nil {
		_, err = db.Exec(`UPDATE book_source_subscriptions SET title=?,raw_result=?,updated_at=? WHERE id=? AND user_id=?`, result.Title, string(result.Raw), now, id, userID)
		return id, err
	}
	id = randomString(20)
	_, err = db.Exec(`INSERT INTO book_source_subscriptions(id,user_id,source_id,book_fingerprint,title,raw_result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, id, userID, result.SourceID, fingerprint, result.Title, string(result.Raw), now, now)
	return id, err
}

func runImportJob(ctx context.Context, id, userID string, result cachedSearchResult) {
	defer func() { jobMu.Lock(); delete(activeJobs, id); jobMu.Unlock() }()
	updateImportJob(id, "running", "preparing", 0, 0, "")
	if result.SourceType == "opds" {
		downloadOPDSJob(ctx, id, userID, result)
		return
	}
	var definition string
	if db.QueryRow(`SELECT definition FROM book_sources WHERE id=? AND user_id=?`, result.SourceID, userID).Scan(&definition) != nil {
		updateImportJob(id, "failed", "failed", 0, 0, "书源不存在")
		return
	}
	payload, _ := json.Marshal(map[string]any{"id": id, "source": json.RawMessage(definition), "book": result.Raw, "namespace": userID})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, legadoEngineURL()+"/internal/imports", strings.NewReader(string(payload)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Engine-Token", os.Getenv("LEGADO_ENGINE_TOKEN"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		updateImportJob(id, "failed", "failed", 0, 0, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		updateImportJob(id, "failed", "failed", 0, 0, string(message))
		return
	}
	_, _ = db.Exec(`UPDATE book_import_jobs SET engine_job_id=?,updated_at=? WHERE id=?`, id, time.Now().Unix(), id)
}

func downloadOPDSJob(ctx context.Context, id, userID string, result cachedSearchResult) {
	updateImportJob(id, "running", "downloading", 0, 0, "")
	resp, err := safeHTTPGet(ctx, result.DownloadURL, "application/epub+zip, application/pdf, text/plain, application/octet-stream")
	if err != nil {
		updateImportJob(id, "failed", "failed", 0, 0, err.Error())
		return
	}
	defer resp.Body.Close()
	dir := filepath.Join(env("SERVICE_FILES_DIR", "/data/files"), "generated", userID)
	if os.MkdirAll(dir, 0700) != nil {
		updateImportJob(id, "failed", "failed", 0, 0, "无法创建任务目录")
		return
	}
	name := safeFileName(result.Title) + "." + firstNonEmpty(result.Format, "epub")
	path := filepath.Join(dir, id+"-"+name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		updateImportJob(id, "failed", "failed", 0, 0, err.Error())
		return
	}
	written, copyErr := io.Copy(file, io.LimitReader(resp.Body, maxGeneratedBookSize+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || written > maxGeneratedBookSize {
		os.Remove(path)
		updateImportJob(id, "failed", "failed", 0, 0, "下载文件超过 512 MiB 或写入失败")
		return
	}
	now := time.Now().Unix()
	_, _ = db.Exec(`UPDATE book_import_jobs SET status='ready',stage='ready',file_name=?,file_path=?,updated_at=? WHERE id=?`, name, path, now, id)
}

func handleBookImportItem(w http.ResponseWriter, r *http.Request) {
	auth := requireAuth(w, r)
	if auth == nil {
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/book-imports/"), "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeAPI(w, 404, 404, "任务不存在", nil)
		return
	}
	id := parts[0]
	if len(parts) == 2 && parts[1] == "events" && r.Method == http.MethodPost {
		streamImportEvents(w, r, auth.User.ID, id)
		return
	}
	if len(parts) == 2 && parts[1] == "file" && r.Method == http.MethodGet {
		serveImportFile(w, r, auth.User.ID, id)
		return
	}
	switch r.Method {
	case http.MethodGet:
		job, err := readImportJob(auth.User.ID, id, true)
		if err != nil {
			writeAPI(w, 404, 404, "任务不存在", nil)
			return
		}
		writeAPI(w, 200, 200, "success", job)
	case http.MethodDelete:
		jobMu.Lock()
		if cancel := activeJobs[id]; cancel != nil {
			cancel()
		}
		jobMu.Unlock()
		result, _ := db.Exec(`UPDATE book_import_jobs SET status='cancelled',stage='cancelled',updated_at=? WHERE id=? AND user_id=? AND status IN ('queued','running')`, time.Now().Unix(), id, auth.User.ID)
		rows, _ := result.RowsAffected()
		if rows == 0 {
			writeAPI(w, 409, 409, "任务无法取消", nil)
			return
		}
		cancelEngineJob(id)
		writeAPI(w, 200, 200, "任务已取消", nil)
	default:
		writeAPI(w, 405, 405, "请求方法不支持", nil)
	}
}

func readImportJob(userID, id string, refresh bool) (importJob, error) {
	var job importJob
	var sourceType, engineID, filePath string
	var ready int
	err := db.QueryRow(`SELECT j.id,j.status,j.stage,j.current,j.total,j.error,j.file_name,j.file_path,j.source_type,j.engine_job_id,j.created_at,j.updated_at,COALESCE(s.subscription_id,'') FROM book_import_jobs j LEFT JOIN book_import_subscriptions s ON s.job_id=j.id WHERE j.id=? AND j.user_id=?`, id, userID).Scan(&job.ID, &job.Status, &job.Stage, &job.Current, &job.Total, &job.Error, &job.FileName, &filePath, &sourceType, &engineID, &job.CreatedAt, &job.UpdatedAt, &job.SubscriptionID)
	if err != nil {
		return job, err
	}
	if refresh && sourceType == "legado" && engineID != "" && (job.Status == "queued" || job.Status == "running") {
		if remote, err := getEngineJob(engineID); err == nil {
			job.Status = anyString(remote["status"])
			job.Stage = anyString(remote["stage"])
			job.Current = anyInt(remote["current"])
			job.Total = anyInt(remote["total"])
			job.Error = anyString(remote["error"])
			job.UpdatedAt = time.Now().Unix()
			_, _ = db.Exec(`UPDATE book_import_jobs SET status=?,stage=?,current=?,total=?,error=?,updated_at=? WHERE id=? AND user_id=?`, job.Status, job.Stage, job.Current, job.Total, job.Error, job.UpdatedAt, id, userID)
			if job.Status == "ready" && job.SubscriptionID != "" {
				latestTitle := anyString(remote["latest_chapter"])
				latestKey := firstNonEmpty(anyString(remote["latest_chapter_url"]), latestTitle)
				_, _ = db.Exec(`UPDATE book_source_subscriptions SET last_chapter_count=?,last_chapter_key=?,last_chapter_title=?,checked_at=?,updated_at=? WHERE id=? AND user_id=?`, job.Total, latestKey, latestTitle, job.UpdatedAt, job.UpdatedAt, job.SubscriptionID, userID)
			}
		} else {
			job.Status, job.Stage, job.Error, job.UpdatedAt = "failed", "failed", "规则引擎已重启，请重新创建导入任务", time.Now().Unix()
			_, _ = db.Exec(`UPDATE book_import_jobs SET status=?,stage=?,error=?,updated_at=? WHERE id=? AND user_id=?`, job.Status, job.Stage, job.Error, job.UpdatedAt, id, userID)
		}
	}
	ready = 0
	if job.Status == "ready" {
		ready = 1
	}
	job.Ready = ready == 1
	return job, nil
}

func streamImportEvents(w http.ResponseWriter, r *http.Request, userID, id string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPI(w, 500, 500, "服务不支持流式响应", nil)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		job, err := readImportJob(userID, id, true)
		if err != nil {
			return
		}
		data, _ := json.Marshal(job)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
		if job.Status == "ready" || job.Status == "failed" || job.Status == "cancelled" {
			fmt.Fprint(w, "data: [DONE]\n\n")
			flusher.Flush()
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

func serveImportFile(w http.ResponseWriter, r *http.Request, userID, id string) {
	job, err := readImportJob(userID, id, true)
	if err != nil || job.Status != "ready" {
		writeAPI(w, 409, 409, "任务尚未完成", nil)
		return
	}
	var sourceType, engineID, path, name string
	_ = db.QueryRow(`SELECT source_type,engine_job_id,file_path,file_name FROM book_import_jobs WHERE id=? AND user_id=?`, id, userID).Scan(&sourceType, &engineID, &path, &name)
	if sourceType == "legado" {
		proxyEngineFile(w, r, engineID)
		return
	}
	if path == "" {
		writeAPI(w, 404, 404, "文件不存在", nil)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	http.ServeFile(w, r, path)
}

func getEngineJob(id string) (map[string]any, error) {
	req, _ := http.NewRequest(http.MethodGet, legadoEngineURL()+"/internal/imports/"+url.PathEscape(id), nil)
	req.Header.Set("X-Engine-Token", os.Getenv("LEGADO_ENGINE_TOKEN"))
	client := http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("engine job unavailable")
	}
	var value map[string]any
	err = json.NewDecoder(resp.Body).Decode(&value)
	return value, err
}
func cancelEngineJob(id string) {
	req, _ := http.NewRequest(http.MethodDelete, legadoEngineURL()+"/internal/imports/"+url.PathEscape(id), nil)
	req.Header.Set("X-Engine-Token", os.Getenv("LEGADO_ENGINE_TOKEN"))
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}
func proxyEngineFile(w http.ResponseWriter, r *http.Request, id string) {
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, legadoEngineURL()+"/internal/imports/"+url.PathEscape(id)+"/file", nil)
	req.Header.Set("X-Engine-Token", os.Getenv("LEGADO_ENGINE_TOKEN"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeAPI(w, 502, 502, "读取 EPUB 失败", nil)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		writeAPI(w, resp.StatusCode, resp.StatusCode, "EPUB 尚未就绪", nil)
		return
	}
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Disposition"} {
		if value := resp.Header.Get(h); value != "" {
			w.Header().Set(h, value)
		}
	}
	w.WriteHeader(200)
	_, _ = io.Copy(w, resp.Body)
}
func updateImportJob(id, status, stage string, current, total int, message string) {
	_, _ = db.Exec(`UPDATE book_import_jobs SET status=?,stage=?,current=?,total=?,error=?,updated_at=? WHERE id=?`, status, stage, current, total, message, time.Now().Unix(), id)
}
func legadoEngineURL() string {
	return strings.TrimRight(env("LEGADO_ENGINE_URL", "http://legado-engine:9080"), "/")
}

func cacheSearchResult(item cachedSearchResult) {
	searchCacheMu.Lock()
	defer searchCacheMu.Unlock()
	now := time.Now()
	if len(searchCache) > 10000 {
		for id, value := range searchCache {
			if now.After(value.ExpiresAt) {
				delete(searchCache, id)
			}
		}
	}
	searchCache[item.ID] = item
}
func getCachedResult(userID, id string) (cachedSearchResult, bool) {
	searchCacheMu.Lock()
	defer searchCacheMu.Unlock()
	item, ok := searchCache[id]
	if !ok || item.UserID != userID || time.Now().After(item.ExpiresAt) {
		if ok {
			delete(searchCache, id)
		}
		return cachedSearchResult{}, false
	}
	return item, true
}

func safeHTTPGet(ctx context.Context, rawURL, accept string) (*http.Response, error) {
	return safeHTTPGetWithAuth(ctx, rawURL, accept, "", "")
}

func safeHTTPGetWithAuth(ctx context.Context, rawURL, accept, username, password string) (*http.Response, error) {
	parsed, err := validateRemoteURL(rawURL)
	if err != nil {
		return nil, err
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	request.Header.Set("Accept", accept)
	if username != "" || password != "" {
		request.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(username+":"+password)))
	}
	return safeHTTPClient().Do(request)
}
func fetchLimitedJSON(ctx context.Context, rawURL string) ([]byte, error) {
	response, err := safeHTTPGet(ctx, rawURL, "application/json,text/plain")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxSourceDefinition+1))
	if err == nil && int64(len(data)) > maxSourceDefinition {
		return nil, errors.New("远程书源超过 5 MiB")
	}
	return data, err
}
func validateRemoteURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("仅支持有效的 HTTP/HTTPS 地址")
	}
	if strings.EqualFold(parsed.Hostname(), "localhost") || strings.HasSuffix(strings.ToLower(parsed.Hostname()), ".local") {
		return nil, errors.New("目标地址被安全策略阻止")
	}
	return parsed, nil
}
func safeHTTPClient() *http.Client {
	allow := map[string]bool{}
	for _, host := range strings.Split(os.Getenv("BOOK_SOURCE_PRIVATE_HOSTS"), ",") {
		allow[strings.ToLower(strings.TrimSpace(host))] = true
	}
	dialer := net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			if allow[strings.ToLower(host)] || !blockedIP(ip.IP) {
				return dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			}
		}
		return nil, errors.New("目标地址被安全策略阻止")
	}}
	client := &http.Client{Timeout: 25 * time.Second, Transport: transport}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("重定向过多")
		}
		_, err := validateRemoteURL(req.URL.String())
		return err
	}
	return client
}
func blockedIP(ip net.IP) bool {
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsPrivate() || ip.IsMulticast() {
		return true
	}
	v4 := ip.To4()
	if v4 != nil {
		return v4[0] == 0 || (v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127) || v4[0] >= 224
	}
	return len(ip) == net.IPv6len && (ip[0]&0xfe) == 0xfc
}

func supportedDownloadType(contentType, href string) bool {
	value := strings.ToLower(contentType + " " + href)
	for _, ext := range []string{"epub", "pdf", "mobi", "azw3", "txt", "fb2", "cbz", "zip"} {
		if strings.Contains(value, ext) {
			return true
		}
	}
	return false
}
func fileExt(href, contentType string) string {
	value := strings.ToLower(href + " " + contentType)
	for _, ext := range []string{"epub", "pdf", "mobi", "azw3", "txt", "fb2", "cbz", "zip"} {
		if strings.Contains(value, ext) {
			return ext
		}
	}
	return "epub"
}
func resolveRemote(href, base string) string {
	parsed, err := url.Parse(href)
	if err != nil {
		return ""
	}
	root, _ := url.Parse(base)
	return root.ResolveReference(parsed).String()
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
func nonEmpty(value string) []string {
	if strings.TrimSpace(value) == "" {
		return []string{}
	}
	return []string{strings.TrimSpace(value)}
}
func anyString(value any) string {
	switch item := value.(type) {
	case string:
		return item
	case []any:
		if len(item) > 0 {
			return anyString(item[0])
		}
	}
	return ""
}
func anyStrings(value any) []string {
	switch item := value.(type) {
	case string:
		if item != "" {
			return []string{item}
		}
	case []any:
		result := []string{}
		for _, part := range item {
			if text := anyString(part); text != "" {
				result = append(result, text)
			}
		}
		return result
	}
	return []string{}
}
func anyInt(value any) int {
	switch item := value.(type) {
	case float64:
		return int(item)
	case int:
		return item
	case json.Number:
		value, _ := item.Int64()
		return int(value)
	}
	return 0
}
func safeFileName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "book"
	}
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-", "\"", "-", "<", "-", ">", "-", "|", "-")
	value = replacer.Replace(value)
	runes := []rune(value)
	if len(runes) > 80 {
		runes = runes[:80]
	}
	return string(runes)
}

func cleanupExpiredBookImports() {
	now := time.Now().Unix()
	rows, err := db.Query(`SELECT file_path,source_type,engine_job_id FROM book_import_jobs WHERE expires_at<?`, now)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var path, sourceType, engineJobID string
			if rows.Scan(&path, &sourceType, &engineJobID) == nil {
				if path != "" {
					_ = os.Remove(path)
				}
				if sourceType == "legado" && engineJobID != "" {
					cancelEngineJob(engineJobID)
				}
			}
		}
	}
	_, _ = db.Exec(`DELETE FROM book_import_jobs WHERE expires_at<?`, now)
}
func sortedSourceIDs(values []string) []string {
	result := append([]string{}, values...)
	sort.Strings(result)
	return result
}
