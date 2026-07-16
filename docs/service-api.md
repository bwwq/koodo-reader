# Koodo Reader 自建服务 API v1

客户端只信任访问令牌中的账号身份。除管理员接口外，所有业务接口都必须忽略或拒绝客户端提交的 `user_id`，并从已验证令牌的 `sub` 取得用户 ID。

## 通用响应

```json
{ "code": 200, "msg": "success", "data": {} }
```

错误同时使用对应 HTTP 状态码。同步版本冲突使用 HTTP 409。SSE 接口发送 `data: {"text":"增量文本"}`，完成时发送 `data: [DONE]`。

## 服务与账号

- `GET /v1/health`：`data` 为 `{ "version": "1.0.0", "capabilities": ["sync.data", "storage.oauth"] }`
- `GET /v1/auth/config`：`data` 为 `{ "registration_mode": "admin" | "invite" }`
- `POST /v1/auth/register`：`{ "username", "password", "invite_code" }`
- `POST /v1/auth/login`：`{ "username", "password", "device" }`
- `POST /v1/auth/refresh`：`{ "refresh_token" }`
- `GET /v1/auth/me`
- `POST /v1/auth/logout`

登录和刷新响应的 `data`：

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 900,
  "user": { "id": "u_123", "username": "alice", "display_name": "Alice" }
}
```

Access Token 默认 15 分钟；Refresh Token 默认 30 天并在每次刷新时轮换，旧令牌立即失效。邀请码默认只能成功核销一次。用户名限定为 3–32 位字母、数字、点、下划线或连字符；密码长度为 8–128 位。

## 数据隔离与同步

推荐表结构：

```sql
CREATE TABLE sync_items (
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, type)
);
```

- `GET /v1/sync/{type}` 的 `data` 为 `{ "type": "notes", "content": "...", "version": 1, "updated_at": 0 }`
- `PUT /v1/sync` 接收 `{ "items": { "notes": "[...]" }, "versions": { "notes": 1 } }`，成功时 `data` 返回本次保存后的类型到同步项映射。

`versions[type]` 是客户端最近一次读到的服务端版本，而不是客户端时间戳。服务端必须在同一事务中按 `(user_id, type)` 比较版本并写入；任一版本不匹配时整体返回 HTTP 409。`type` 只允许 `sync`、`config`、`books`、`notes`、`bookmarks`、`words`、`plugins`。所有 SQL 查询、写入、版本比较和删除都必须包含当前令牌的 `user_id`。

客户端同时启用 WebDAV、S3、FTP/SFTP、本地目录等存储与在线同步时：

- 读取两端数据，以 `updated_at` 选择较新的阅读数据；两端版本号相互独立，不跨存储比较版本号。
- 保存时先写用户选择的存储，再写本接口；在线同步开启但服务端写入失败时，客户端会报告同步失败并保留待写数据。
- 书籍文件和封面只保存到用户选择的存储，在线服务保存进度、笔记、书签、生词及同步配置。

## 云存储 OAuth

- `POST /v1/storage/oauth/authorize`：接收 `{ "provider", "redirect_uri" }`，`data` 返回 `{ "authorization_url", "state" }`
- `POST /v1/storage/oauth/exchange`：接收 `{ "provider", "code", "redirect_uri" }`
- `POST /v1/storage/oauth/refresh`：接收 `{ "provider", "refresh_token" }`

OAuth state、回调及一次性交换码必须绑定当前用户、提供商和回调地址，并设置短时有效期。返回的提供商令牌由客户端本地保存。

## 可选阅读能力

服务通过 `/v1/health` 的 `capabilities` 声明已实现能力：

- `sync.data`、`storage.oauth`
- `reader.translation`、`reader.assistant`、`reader.dictionary`
- `reader.ocr`、`reader.tts`、`reader.batch-translation`
- `reader.word-definitions`、`reader.metadata`、`reader.role-analysis`、`reader.language-detect`

- SSE：`POST /v1/reader/translation/stream`、`/assistant/stream`、`/dictionary/stream`
- JSON：`POST /v1/reader/dictionary`、`/ocr`、`/tts`、`/batch-translation`、`/word-definitions`、`/metadata`、`/role-analysis`、`/language-detect`

常用返回数据分别为 `{ "text": "..." }`、`{ "audio_base64": "...", "mime_type": "audio/mpeg" }`、`{ "texts": [] }`、`{ "results": [] }`、书籍元数据数组及 `{ "sentences": [{ "text": "...", "index": 0, "role": "narrator" }] }`。
