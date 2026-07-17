import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:9223/health");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("WebView service did not start");
};

test("renders JavaScript and returns the final page", async () => {
  const fixture = http.createServer((request, response) => {
    if (request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<html><body>posted:${Buffer.concat(chunks).toString("utf8")}</body></html>`);
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "fixture=yes; Path=/" });
    response.end("<html><body><div id='value'>before</div><script>document.querySelector('#value').textContent='rendered'</script></body></html>");
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixturePort = fixture.address().port;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      LEGADO_WEBVIEW_TOKEN: "integration-token",
      WEBVIEW_STATE_KEY: "integration-state-key",
      BOOK_SOURCE_PRIVATE_HOSTS: "127.0.0.1",
      WEBVIEW_DATA: "/tmp/koodo-webview-integration",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForHealth();
    const response = await fetch("http://127.0.0.1:9223/render", {
      method: "POST",
      headers: { "content-type": "application/json", "x-engine-token": "integration-token" },
      body: JSON.stringify({ namespace: "test-user", source: "fixture", url: `http://127.0.0.1:${fixturePort}/` }),
    });
    if (!response.ok) throw new Error(`render failed: ${response.status} ${await response.text()}`);
    const result = await response.json();
    assert.match(result.body, />rendered</);
    assert.equal(result.cookies.some((cookie) => cookie.name === "fixture" && cookie.value === "yes"), true);
    const postResponse = await fetch("http://127.0.0.1:9223/render", {
      method: "POST",
      headers: { "content-type": "application/json", "x-engine-token": "integration-token" },
      body: JSON.stringify({ namespace: "test-user", source: "fixture", url: `http://127.0.0.1:${fixturePort}/post`, post: true, body: "chapter=one" }),
    });
    if (!postResponse.ok) throw new Error(`POST render failed: ${postResponse.status} ${await postResponse.text()}`);
    assert.match((await postResponse.json()).body, /posted:chapter=one/);
  } finally {
    child.kill("SIGTERM");
    fixture.close();
  }
});
