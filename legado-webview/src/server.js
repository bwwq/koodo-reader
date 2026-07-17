import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

const port = Number(process.env.WEBVIEW_PORT || 9223);
const dataDir = process.env.WEBVIEW_DATA || "/data";
const engineToken = process.env.LEGADO_WEBVIEW_TOKEN || "";
const stateKey = crypto.createHash("sha256").update(process.env.WEBVIEW_STATE_KEY || engineToken || "development-only").digest();
const allowedPrivateHosts = new Set((process.env.BOOK_SOURCE_PRIVATE_HOSTS || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
const sessions = new Map();
const maxInteractive = Number(process.env.WEBVIEW_MAX_INTERACTIVE || 2);
const maxRenderPages = Number(process.env.WEBVIEW_MAX_RENDER_PAGES || 4);
const maxBodyBytes = 10 * 1024 * 1024;
let browserPromise;
let proxyPromise;
let activeRenders = 0;
let pendingInteractive = 0;
const pendingNamespaces = new Set();

const json = (response, status, value) => {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
  response.end(body);
};

const authorized = (request) => engineToken && request.headers["x-engine-token"] === engineToken;

const readJson = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

const statePath = (namespace, source) => path.join(dataDir, "states", crypto.createHash("sha256").update(`${namespace}\0${source}`).digest("hex") + ".state");

const encrypt = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", stateKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
};

const decrypt = (value) => {
  const decipher = crypto.createDecipheriv("aes-256-gcm", stateKey, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"));
};

const loadState = async (namespace, source) => {
  try { return decrypt(await fs.readFile(statePath(namespace, source))); } catch { return undefined; }
};

const saveState = async (context, namespace, source) => {
  const state = await context.storageState({ indexedDB: true });
  const encoded = encrypt(state);
  if (encoded.length > 16 * 1024 * 1024) throw new Error("browser state exceeds 16 MiB");
  const target = statePath(namespace, source);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, encoded, { mode: 0o600 });
};

const exportedCookies = async (context) => (await context.cookies()).map((cookie) => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain,
  path: cookie.path,
  expires: cookie.expires,
  httpOnly: cookie.httpOnly,
  secure: cookie.secure,
  sameSite: cookie.sameSite,
}));

const isBlockedAddress = (address) => {
  if (address.includes(":")) {
    const value = address.toLowerCase();
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("ff");
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
};

const safeUrl = async (raw) => {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported browser URL scheme");
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("blocked browser host");
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!allowedPrivateHosts.has(host) && addresses.some((item) => isBlockedAddress(item.address))) throw new Error("private and special-purpose browser addresses are blocked");
  return url;
};

const resolveTarget = async (raw) => {
  const url = await safeUrl(raw);
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  const address = addresses.find((item) => allowedPrivateHosts.has(host) || !isBlockedAddress(item.address));
  if (!address) throw new Error("browser target has no permitted address");
  return { url, address: address.address };
};

const startFilteringProxy = () => proxyPromise ||= new Promise((resolve, reject) => {
  const proxy = http.createServer(async (request, response) => {
    try {
      const target = await resolveTarget(request.url);
      const client = target.url.protocol === "https:" ? https : http;
      const upstream = client.request({
        hostname: target.address,
        port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
        path: `${target.url.pathname}${target.url.search}`,
        method: request.method,
        headers: { ...request.headers, host: target.url.host },
        servername: target.url.hostname,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
    } catch (error) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end(error.message);
    }
  });
  proxy.on("connect", async (request, clientSocket, head) => {
    try {
      const connectUrl = new URL(`https://${request.url}/`);
      const target = await resolveTarget(connectUrl);
      const upstream = net.connect(Number(connectUrl.port) || 443, target.address, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    } catch {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });
  proxy.on("upgrade", async (request, clientSocket, head) => {
    try {
      const websocketUrl = new URL(request.url);
      const validationUrl = new URL(websocketUrl.toString());
      validationUrl.protocol = websocketUrl.protocol === "wss:" ? "https:" : "http:";
      const target = await resolveTarget(validationUrl);
      const port = Number(websocketUrl.port) || (websocketUrl.protocol === "wss:" ? 443 : 80);
      const upstream = net.connect(port, target.address, () => {
        const pathWithQuery = `${websocketUrl.pathname}${websocketUrl.search}`;
        upstream.write(`${request.method} ${pathWithQuery} HTTP/${request.httpVersion}\r\n`);
        for (const [name, value] of Object.entries(request.headers)) upstream.write(`${name}: ${value}\r\n`);
        upstream.write("\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    } catch {
      clientSocket.destroy();
    }
  });
  proxy.on("error", reject);
  proxy.listen(0, "127.0.0.1", () => resolve(proxy.address().port));
});

const launchBrowser = () => browserPromise ||= startFilteringProxy().then((proxyPort) => chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", `--proxy-server=http://127.0.0.1:${proxyPort}`] }));

const createContext = async (namespace, source, headers = {}) => {
  const browser = await launchBrowser();
  const storageState = await loadState(namespace, source);
  const context = await browser.newContext({ storageState, viewport: { width: 1200, height: 800 }, locale: "zh-CN", extraHTTPHeaders: headers });
  await context.route("**/*", async (route) => {
    try { await safeUrl(route.request().url()); await route.continue(); } catch { await route.abort("blockedbyclient"); }
  });
  return context;
};

const limitedText = async (response) => {
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBodyBytes) throw new Error("browser response exceeds 10 MiB");
  return text;
};

const installCompatibilityBridge = async (page) => {
  const install = () => {
    if (globalThis.java) return;
    const navigate = (url) => { if (typeof url === "string" && /^https?:\/\//i.test(url)) globalThis.location.href = url; };
    globalThis.java = {
      toast: () => {},
      longToast: () => {},
      log: (value) => String(value ?? ""),
      refreshExplore: () => globalThis.location.reload(),
      startBrowser: navigate,
      startBrowserAwait: navigate,
      startBrowserDp: navigate,
      showReadingBrowser: navigate,
      getWebViewUA: () => globalThis.navigator.userAgent,
    };
  };
  await page.addInitScript(install);
  await page.evaluate(install);
};

const htmlWithBase = (html, baseUrl) => {
  if (!baseUrl) return String(html);
  const base = `<base href="${String(baseUrl).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? String(html).replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${base}`)
    : `${base}${html}`;
};

const navigate = async (page, input) => {
  if (input.html) {
    if (input.url) await safeUrl(input.url);
    await page.setContent(htmlWithBase(String(input.html), input.url), { waitUntil: "domcontentloaded", timeout: 45_000 });
    return;
  }
  await safeUrl(input.url);
  if (input.post) {
    const response = await page.context().request.fetch(input.url, {
      method: "POST",
      data: input.body || "",
      headers: input.headers || {},
      timeout: 45_000,
    });
    const body = await limitedText(response);
    await page.setContent(htmlWithBase(body, response.url()), { waitUntil: "domcontentloaded", timeout: 45_000 });
    return;
  }
  await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
};

const render = async (input) => {
  if (activeRenders >= maxRenderPages) throw new Error("browser render capacity reached");
  activeRenders += 1;
  const namespace = String(input.namespace || "default");
  const source = String(input.source || "default");
  let context;
  try {
    context = await createContext(namespace, source, input.headers || {});
    const page = await context.newPage();
    await installCompatibilityBridge(page);
    let matched = null;
    const matcher = input.sourceRegex ? new RegExp(input.sourceRegex) : null;
    page.on("response", (response) => {
      if (!matched && matcher?.test(response.url())) matched = response;
    });
    await navigate(page, input);
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    let body;
    if (matched) body = await limitedText(matched);
    else if (input.javaScript) body = await page.evaluate((script) => { const value = globalThis.eval(script); return value == null ? "" : typeof value === "string" ? value : JSON.stringify(value); }, String(input.javaScript));
    else body = await page.content();
    if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("browser result exceeds 10 MiB");
    await saveState(context, namespace, source);
    return { url: matched?.url() || page.url(), body, cookies: await exportedCookies(context) };
  } finally {
    activeRenders -= 1;
    await context?.close();
  }
};

const createSession = async (input) => {
  const namespace = String(input.namespace || "default");
  if ([...sessions.values()].filter((item) => item.state === "active").length + pendingInteractive >= maxInteractive) throw new Error("interactive browser capacity reached");
  const existing = [...sessions.values()].find((item) => item.namespace === namespace && item.state === "active");
  if (existing || pendingNamespaces.has(namespace)) throw new Error("this account already has an interactive browser session");
  pendingInteractive += 1;
  pendingNamespaces.add(namespace);
  const source = String(input.source || "default");
  try {
    const context = await createContext(namespace, source, input.headers || {});
    const page = await context.newPage();
    await installCompatibilityBridge(page);
    const id = crypto.randomBytes(18).toString("base64url");
    const session = { id, namespace, source, title: String(input.title || "网页登录"), context, page, state: "active", body: "", cookies: [], error: "", createdAt: Date.now(), touchedAt: Date.now(), clients: new Set() };
    sessions.set(id, session);
    page.on("popup", async (popup) => { await installCompatibilityBridge(popup).catch(() => {}); session.page = popup; });
    try {
      await navigate(page, input);
      if (input.javaScript) await page.evaluate((script) => globalThis.eval(script), String(input.javaScript));
    } catch (error) { session.error = error.message; }
    return session;
  } finally {
    pendingInteractive -= 1;
    pendingNamespaces.delete(namespace);
  }
};

const finishSession = async (session, cancelled = false) => {
  if (session.state !== "active") return;
  try {
    session.body = cancelled ? "" : await session.page.content();
    if (!cancelled) {
      session.cookies = await exportedCookies(session.context);
      await saveState(session.context, session.namespace, session.source);
    }
    session.state = cancelled ? "cancelled" : "finished";
  } catch (error) { session.error = error.message; session.state = "failed"; }
  await session.context.close().catch(() => {});
  for (const socket of session.clients) socket.close();
};

const publicSession = (session) => ({ id: session.id, namespace: session.namespace, source: session.source, title: session.title, url: session.page?.url?.() || "", state: session.state, error: session.error, created_at: Math.floor(session.createdAt / 1000), expires_at: Math.floor((session.createdAt + 30 * 60_000) / 1000) });

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/health") return json(response, 200, { status: "ok", version: "0.6.0" });
    if (!authorized(request)) return json(response, 401, { error: "unauthorized" });
    if (request.method === "POST" && url.pathname === "/render") return json(response, 200, await render(await readJson(request)));
    if (request.method === "POST" && url.pathname === "/sessions") return json(response, 201, publicSession(await createSession(await readJson(request))));
    if (request.method === "GET" && url.pathname === "/sessions") {
      const namespace = url.searchParams.get("namespace") || "";
      return json(response, 200, [...sessions.values()].filter((item) => !namespace || item.namespace === namespace).map(publicSession));
    }
    if (request.method === "DELETE" && url.pathname === "/state") {
      const input = await readJson(request);
      const namespace = String(input.namespace);
      const source = String(input.source);
      for (const session of sessions.values()) {
        if (session.namespace === namespace && session.source === source && session.state === "active") await finishSession(session, true);
      }
      await fs.rm(statePath(namespace, source), { force: true });
      return json(response, 200, { ok: true });
    }
    const match = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(finish))?$/);
    if (match) {
      const session = sessions.get(match[1]);
      if (!session) return json(response, 404, { error: "session not found" });
      session.touchedAt = Date.now();
      if (request.method === "GET" && !match[2]) return json(response, 200, { ...publicSession(session), body: session.state === "finished" ? session.body : "", cookies: session.state === "finished" ? session.cookies : [] });
      if (request.method === "POST" && match[2]) { await finishSession(session, false); return json(response, 200, publicSession(session)); }
      if (request.method === "DELETE" && !match[2]) { await finishSession(session, true); return json(response, 200, publicSession(session)); }
    }
    return json(response, 404, { error: "not found" });
  } catch (error) { return json(response, 422, { error: error.message || "request failed" }); }
});

const websocket = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
server.on("upgrade", (request, socket, head) => {
  const match = new URL(request.url, "http://localhost").pathname.match(/^\/sessions\/([^/]+)\/ws$/);
  const session = match && sessions.get(match[1]);
  if (!authorized(request) || !session || session.state !== "active") return socket.destroy();
  websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, session));
});

websocket.on("connection", (socket, session) => {
  session.clients.add(socket);
  const sendFrame = async () => {
    if (socket.readyState !== 1 || session.state !== "active") return;
    try { socket.send(await session.page.screenshot({ type: "jpeg", quality: 72 }), { binary: true }); } catch {}
  };
  const timer = setInterval(sendFrame, 750);
  sendFrame();
  socket.on("message", async (raw, binary) => {
    if (binary) return;
    session.touchedAt = Date.now();
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === "click") await session.page.mouse.click(Number(event.x), Number(event.y), { button: event.button || "left" });
      else if (event.type === "text") await session.page.keyboard.insertText(String(event.text || ""));
      else if (event.type === "key") await session.page.keyboard.press(String(event.key || "Enter"));
      else if (event.type === "scroll") await session.page.mouse.wheel(Number(event.deltaX || 0), Number(event.deltaY || 0));
      else if (event.type === "resize") await session.page.setViewportSize({ width: Math.max(320, Math.min(1920, Number(event.width) || 1200)), height: Math.max(320, Math.min(1600, Number(event.height) || 800)) });
      else if (event.type === "reload") await session.page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
      else if (event.type === "finish") await finishSession(session, false);
      else if (event.type === "cancel") await finishSession(session, true);
      await sendFrame();
    } catch (error) { socket.send(JSON.stringify({ type: "error", message: error.message })); }
  });
  socket.on("close", () => { clearInterval(timer); session.clients.delete(socket); });
});

setInterval(async () => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.state === "active" && (now - session.touchedAt > 10 * 60_000 || now - session.createdAt > 30 * 60_000)) await finishSession(session, true);
    if (session.state !== "active" && now - session.createdAt > 30 * 60_000) sessions.delete(session.id);
  }
}, 30_000).unref();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  server.listen(port, "0.0.0.0", () => console.log(`Koodo Legado WebView 0.6.0 listening on :${port}`));
}

export { htmlWithBase, isBlockedAddress };
