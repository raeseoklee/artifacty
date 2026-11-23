import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";

test("Pretendard is served locally and is the first interface font on every platform", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-fonts-"));
  const app = await startServer({ home, port: 0 });
  try {
    const font = await fetch(`${app.url}/assets/pretendard-variable.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    const bytes = Buffer.from(await font.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2");
    assert.deepEqual(bytes, await readFile(new URL("../src/client/pretendard-variable.woff2", import.meta.url)));

    const page = await (await fetch(`${app.url}/login`)).text();
    assert.match(page, /@font-face\s*\{\s*font-family: "Pretendard Variable";\s*src: url\("\/assets\/pretendard-variable\.woff2"\)/);
    assert.match(page, /--sans: "Pretendard Variable", Pretendard, -apple-system/);
    const controls = await (await fetch(`${app.url}/assets/ui-controls.css`)).text();
    assert.match(controls, /--bs-body-font-family: ?"?Pretendard Variable"?, ?Pretendard, ?-apple-system/);
    const docs = await (await fetch(`${app.url}/docs/api`)).text();
    assert.match(docs, /font:15px\/1\.6 "Pretendard Variable",Pretendard,/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
