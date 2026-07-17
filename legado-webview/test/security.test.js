import assert from "node:assert/strict";
import test from "node:test";
import { htmlWithBase, isBlockedAddress } from "../src/server.js";

test("blocks private and metadata address ranges", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::1", "fd00::1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("adds a base URL without replacing document content", () => {
  const output = htmlWithBase("<html><head><title>x</title></head><body>ok</body></html>", "https://books.example/a/");
  assert.match(output, /<base href="https:\/\/books\.example\/a\/">/);
  assert.match(output, /<body>ok<\/body>/);
});
