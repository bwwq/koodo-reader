package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const sonovelBuiltInID = "builtin-sonovel"

var sonovelImportSemaphore = make(chan struct{}, 1)

type sonovelResult struct {
	SourceID      int    `json:"sourceId"`
	SourceName    string `json:"sourceName"`
	URL           string `json:"url"`
	BookName      string `json:"bookName"`
	Author        string `json:"author"`
	Intro         string `json:"intro"`
	LatestChapter string `json:"latestChapter"`
}

type sonovelLocalBook struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Timestamp int64  `json:"timestamp"`
}

type sonovelResponse struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func sonovelEngineURL() string {
	return strings.TrimRight(env("SONOVEL_ENGINE_URL", "http://sonovel-engine:7765"), "/")
}

func sonovelEngineHealthy() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, sonovelEngineURL()+"/sources", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func searchSoNovel(ctx context.Context, userID string, source bookSource, keyword string, page int) ([]cachedSearchResult, error) {
	if page > 1 {
		return []cachedSearchResult{}, nil
	}
	values, err := fetchSoNovelResults(ctx, keyword)
	if err != nil {
		return nil, err
	}
	items := make([]cachedSearchResult, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value.BookName) == "" || strings.TrimSpace(value.URL) == "" {
			continue
		}
		raw, _ := json.Marshal(value)
		name := firstNonEmpty(value.SourceName, source.Name)
		items = append(items, cachedSearchResult{
			ID:          randomString(24),
			UserID:      userID,
			SourceID:    source.ID,
			SourceName:  name,
			SourceType:  "sonovel",
			Title:       value.BookName,
			Authors:     nonEmpty(value.Author),
			Summary:     value.Intro,
			Latest:      value.LatestChapter,
			Format:      "epub",
			MediaType:   "text",
			Raw:         raw,
			DownloadURL: value.URL,
			ExpiresAt:   time.Now().Add(searchResultTTL),
		})
	}
	return items, nil
}

func fetchSoNovelResults(ctx context.Context, keyword string) ([]sonovelResult, error) {
	endpoint := sonovelEngineURL() + "/search/aggregated?kw=" + url.QueryEscape(keyword) + "&searchLimit=30"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("So Novel 引擎不可用: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("So Novel 返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(message)))
	}
	var values []sonovelResult
	if decodeSoNovelResponse(resp.Body, 10<<20, &values) != nil {
		return nil, errors.New("So Novel 搜索响应无效")
	}
	return values, nil
}

func runSoNovelImport(ctx context.Context, id, userID string, result cachedSearchResult) {
	select {
	case sonovelImportSemaphore <- struct{}{}:
		defer func() { <-sonovelImportSemaphore }()
	case <-ctx.Done():
		return
	}

	before, err := listSoNovelBooks(ctx)
	if err != nil {
		updateImportJob(id, "failed", "failed", 0, 0, err.Error())
		return
	}
	previous := make(map[string]int64, len(before))
	for _, item := range before {
		previous[item.Name] = item.Timestamp
	}

	updateImportJob(id, "running", "book_info", 0, 0, "")
	progressCtx, stopProgress := context.WithCancel(ctx)
	defer stopProgress()
	go watchSoNovelProgress(progressCtx, id)

	endpoint := sonovelEngineURL() + "/book-fetch?url=" + url.QueryEscape(result.DownloadURL) + "&format=epub&language=zh-cn&concurrency=4"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			updateImportJob(id, "failed", "failed", 0, 0, "So Novel 下载失败: "+err.Error())
		}
		return
	}
	message, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	resp.Body.Close()
	stopProgress()
	if resp.StatusCode != http.StatusOK {
		updateImportJob(id, "failed", "failed", 0, 0, fmt.Sprintf("So Novel 返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(message))))
		return
	}

	updateImportJob(id, "running", "packaging", 0, 0, "")
	after, err := listSoNovelBooks(ctx)
	if err != nil {
		updateImportJob(id, "failed", "failed", 0, 0, err.Error())
		return
	}
	generated := newestSoNovelBook(after, previous)
	if generated.Name == "" {
		updateImportJob(id, "failed", "failed", 0, 0, "So Novel 未生成 EPUB 文件")
		return
	}
	defer deleteSoNovelBook(generated.Name)
	if err := copySoNovelBook(ctx, id, userID, result.Title, generated); err != nil {
		updateImportJob(id, "failed", "failed", 0, 0, err.Error())
		return
	}
	updateSoNovelSubscription(id, userID, result)
}

func listSoNovelBooks(ctx context.Context) ([]sonovelLocalBook, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, sonovelEngineURL()+"/local-books", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("读取 So Novel 文件失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("读取 So Novel 文件失败: HTTP %d", resp.StatusCode)
	}
	var values []sonovelLocalBook
	if decodeSoNovelResponse(resp.Body, 2<<20, &values) != nil {
		return nil, errors.New("So Novel 文件列表无效")
	}
	return values, nil
}

func decodeSoNovelResponse(body io.Reader, limit int64, target any) error {
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return errors.New("So Novel 响应过大或读取失败")
	}
	var response sonovelResponse
	if json.Unmarshal(data, &response) != nil || response.Code != http.StatusOK || len(response.Data) == 0 {
		return errors.New("So Novel 响应无效")
	}
	return json.Unmarshal(response.Data, target)
}

func newestSoNovelBook(values []sonovelLocalBook, previous map[string]int64) sonovelLocalBook {
	var newest sonovelLocalBook
	for _, item := range values {
		if !strings.HasSuffix(strings.ToLower(item.Name), ".epub") || item.Size <= 0 {
			continue
		}
		if old, existed := previous[item.Name]; existed && item.Timestamp <= old {
			continue
		}
		if newest.Name == "" || item.Timestamp > newest.Timestamp {
			newest = item
		}
	}
	return newest
}

func copySoNovelBook(ctx context.Context, id, userID, title string, generated sonovelLocalBook) error {
	if generated.Size > maxGeneratedBookSize {
		return errors.New("生成的 EPUB 超过 512 MiB")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, sonovelEngineURL()+"/book-download?filename="+url.QueryEscape(generated.Name), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("读取 So Novel EPUB 失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("读取 So Novel EPUB 失败: HTTP %d", resp.StatusCode)
	}
	dir := filepath.Join(env("SERVICE_FILES_DIR", "/data/files"), "generated", userID)
	if os.MkdirAll(dir, 0700) != nil {
		return errors.New("无法创建任务目录")
	}
	name := safeFileName(title) + ".epub"
	path := filepath.Join(dir, id+"-"+name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	written, copyErr := io.Copy(file, io.LimitReader(resp.Body, maxGeneratedBookSize+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || written > maxGeneratedBookSize {
		_ = os.Remove(path)
		return errors.New("EPUB 超过 512 MiB 或写入失败")
	}
	_, _ = db.Exec(`UPDATE book_import_jobs SET status='ready',stage='ready',file_name=?,file_path=?,updated_at=? WHERE id=?`, name, path, time.Now().Unix(), id)
	return nil
}

func watchSoNovelProgress(ctx context.Context, id string) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, sonovelEngineURL()+"/download-progress", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 4<<20))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var value struct {
			Type  string `json:"type"`
			Index int    `json:"index"`
			Total int    `json:"total"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &value) == nil && value.Type == "download-progress" {
			updateImportJob(id, "running", "chapters", value.Index, value.Total, "")
		}
	}
}

func deleteSoNovelBook(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, sonovelEngineURL()+"/book-delete?filename="+url.QueryEscape(name), nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
		resp.Body.Close()
	}
}

func updateSoNovelSubscription(jobID, userID string, result cachedSearchResult) {
	var subscriptionID string
	if db.QueryRow(`SELECT subscription_id FROM book_import_subscriptions WHERE job_id=?`, jobID).Scan(&subscriptionID) != nil {
		return
	}
	var value sonovelResult
	_ = json.Unmarshal(result.Raw, &value)
	latest := firstNonEmpty(value.LatestChapter, result.Latest)
	now := time.Now().Unix()
	_, _ = db.Exec(`UPDATE book_source_subscriptions SET last_chapter_count=1,last_chapter_key=?,last_chapter_title=?,raw_result=?,checked_at=?,updated_at=? WHERE id=? AND user_id=?`, latest, latest, string(result.Raw), now, now, subscriptionID, userID)
}

func checkSoNovelUpdate(ctx context.Context, raw, title string, previousCount int, previousKey string) (sonovelResult, bool, error) {
	var previous sonovelResult
	if json.Unmarshal([]byte(raw), &previous) != nil || previous.URL == "" {
		return sonovelResult{}, false, errors.New("追更记录无效")
	}
	values, err := fetchSoNovelResults(ctx, title)
	if err != nil {
		return sonovelResult{}, false, err
	}
	for _, value := range values {
		if value.URL != previous.URL {
			continue
		}
		latest := strings.TrimSpace(value.LatestChapter)
		return value, previousCount > 0 && latest != "" && previousKey != "" && latest != previousKey, nil
	}
	return sonovelResult{}, false, errors.New("原书籍已无法从 So Novel 搜索到")
}
