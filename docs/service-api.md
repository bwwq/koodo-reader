# Koodo Reader 自建服务 API v1

仓库中的 `httpserver/service` 已实现账号、管理员、邀请码和隔离同步接口。客户端只信任已验证访问令牌对应的账号身份；普通业务接口不接受 `user_id`，服务端从会话取得用户 ID。

## 通用响应

```json
{ "code": 200, "msg": "success", "data": {} }
```

错误同时使用对应 HTTP 状态码。同步版本冲突使用 HTTP 409。SSE 接口发送 `data: {"text":"增量文本"}`，完成时发送 `data: [DONE]`。

## 服务与账号

- `GET /v1/health`：`data` 为 `{ "version": "0.3.0", "capabilities": ["sync.data", "sync.koreader", "storage.files"] }`
- `GET /v1/auth/config`：`data` 为 `{ "registration_mode": "bootstrap" | "admin" | "invite", "service_name": "Koodo Reader" }`
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
  "user": { "id": "u_123", "username": "alice", "display_name": "Alice", "role": "admin" }
}
```

Access Token 默认 15 分钟；Refresh Token 默认 30 天并在每次刷新时轮换，旧令牌立即失效。邀请码默认只能成功核销一次。用户名限定为 3–32 位字母、数字、点、下划线或连字符；密码长度为 8–128 位。

数据库没有账号时注册模式为 `bootstrap`，第一个成功注册的账号自动成为管理员，且不需要邀请码。之后服务恢复管理员配置的注册模式。

## 管理员接口

以下接口要求当前账号的 `role` 为 `admin`：

- `GET /v1/admin/config`：读取服务名称、注册模式和已实现能力。
- `PUT /v1/admin/config`：接收 `{ "service_name", "registration_mode": "admin" | "invite", "koreader_registration_enabled": true }`。
- `POST /v1/admin/invites`：接收 `{ "count": 1, "expires_in_days": 7 }`，完整邀请码只在创建响应中返回一次。
- `GET /v1/admin/invites`：查看邀请码提示、状态和有效期，不返回完整邀请码。
- `GET /v1/admin/users`：查看已注册账号及角色。
- `POST /v1/admin/users`：管理员直接创建普通账号，接收 `{ "username", "password", "display_name" }`，不消耗邀请码。

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

没有配置其他数据源时，在线服务仍可独立保存上述阅读数据，不会再调用空数据源。配置了数据源后，客户端会先尝试保存数据源，再保存在线服务；其中一端失败不会阻止另一端的保存尝试，界面会报告部分同步失败。

## KOReader 兼容同步

服务同时提供 KOReader Sync Server 兼容接口，并以 `sync.koreader` 声明能力：

- `POST /users/create`
- `GET /users/auth`
- `PUT /syncs/progress`
- `GET /syncs/progress/{document}`
- `GET /healthcheck`

KOReader 接口使用 `x-auth-user` 与 `x-auth-key` 请求头。KOReader 账号及进度与普通在线服务会话分开保存，进度以 `(username, document)` 隔离。管理员可在客户端服务设置中开关公开注册；`ENABLE_KOREADER_REGISTRATION=false` 仅决定新数据库的默认值。

跨域请求默认只允许与请求 Host、协议均相同的来源；额外受信任来源通过逗号分隔的 `SERVICE_ALLOWED_ORIGINS` 配置。Capacitor 客户端使用的 `https://localhost` 与 `capacitor://localhost` 默认允许。

登录、注册、刷新令牌和 KOReader 账号接口按来源 IP 限速。普通 JSON 请求体默认最大 20 MiB，可通过 `SERVICE_MAX_BODY_BYTES` 调整。

## 账号隔离文件存储

服务以 `storage.files` 声明文件存储能力，可直接作为客户端的“Docker”数据源。文件接口使用在线服务账号的用户名和密码进行 HTTP Basic Auth，文件实际保存在 `SERVICE_FILES_DIR/<user_id>`，不同账号即使使用相同文件名也不会互相读取或覆盖。

- `POST /upload?dir=book`：`multipart/form-data` 上传文件。
- `GET /download?dir=book&filename=example.epub`
- `DELETE /delete?dir=book&filename=example.epub`
- `GET /list?dir=book`

文件请求默认最大 512 MiB，可通过 `SERVICE_FILE_MAX_BYTES` 调整。反向代理也必须代理上述四个路径并允许相同或更大的请求体。

## 独立 API 测试

`httpserver/service/main_test.go` 使用临时 SQLite 数据库直接覆盖账号生命周期、管理员权限、邀请码并发核销、刷新令牌轮换、同步版本冲突、账号隔离、KOReader 隔离和 CORS。构建服务镜像时会自动执行：

```bash
cd httpserver
go test ./service
```

`httpserver/service/smoke_test.py` 是面向完整 HTTP 服务的黑盒测试，包含真实注册、登录、写入、拉取和冲突请求。它要求目标是全新的临时实例，并会在发现目标不是 `bootstrap` 状态时停止，禁止将正式服务当作测试环境：

```bash
python3 service/smoke_test.py http://127.0.0.1:18082
```

建议让临时容器只监听回环地址，并使用独立的 `/data/test.db`；测试结束后删除临时容器和数据库。

## 预留：云存储 OAuth

当前仓库后端尚未实现以下接口，且不会声明 `storage.oauth`。客户端只有在服务端声明该能力时才显示新的 OAuth 数据源入口。

- `POST /v1/storage/oauth/authorize`：接收 `{ "provider", "redirect_uri" }`，`data` 返回 `{ "authorization_url", "state" }`
- `POST /v1/storage/oauth/exchange`：接收 `{ "provider", "code", "redirect_uri" }`
- `POST /v1/storage/oauth/refresh`：接收 `{ "provider", "refresh_token" }`

OAuth state、回调及一次性交换码必须绑定当前用户、提供商和回调地址，并设置短时有效期。返回的提供商令牌由客户端本地保存。

## 预留：可选阅读能力

当前仓库后端尚未实现以下接口，也不会声明对应的 `reader.*` 能力。客户端会回退到用户配置的 OpenAI 兼容模型。

服务通过 `/v1/health` 的 `capabilities` 声明已实现能力：

- `sync.data`、`storage.oauth`
- `reader.translation`、`reader.assistant`、`reader.dictionary`
- `reader.ocr`、`reader.tts`、`reader.batch-translation`
- `reader.word-definitions`、`reader.metadata`、`reader.role-analysis`、`reader.language-detect`

- SSE：`POST /v1/reader/translation/stream`、`/assistant/stream`、`/dictionary/stream`
- JSON：`POST /v1/reader/dictionary`、`/ocr`、`/tts`、`/batch-translation`、`/word-definitions`、`/metadata`、`/role-analysis`、`/language-detect`

常用返回数据分别为 `{ "text": "..." }`、`{ "audio_base64": "...", "mime_type": "audio/mpeg" }`、`{ "texts": [] }`、`{ "results": [] }`、书籍元数据数组及 `{ "sentences": [{ "text": "...", "index": 0, "role": "narrator" }] }`。
