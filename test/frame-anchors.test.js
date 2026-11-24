import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { startServer } from "../src/server.js";
import { createArtifact } from "../src/lib/storage.js";

const HTML = '<!doctype html><html><body><nav><a href="#s3b">Retention</a><a href="#missing">Missing</a><a href="#s3b" target="_blank">New tab</a><a href="https://example.test/">Out</a></nav><h2 id="s3b">3b</h2></body></html>';

function decodeAttribute(value) {
  return value.replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

// Objects created inside the vm context have another realm's prototype.
const plain = (value) => JSON.parse(JSON.stringify(value));

function scripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

async function renderedPage() {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-frame-anchors-"));
  const app = await startServer({ home, port: 0 });
  try {
    const artifact = await createArtifact(app.store, { title: "Anchors", content: HTML, format: "html", sourceAgent: "test" });
    return await (await fetch(`${app.url}/artifacts/${artifact.id}`)).text();
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// A minimal document for the frame script: links are found through closest(),
// and only #s3b exists.
function frameHarness() {
  const posted = [];
  const listeners = {};
  const heading = { getBoundingClientRect: () => ({ top: 640 }) };
  const parent = { postMessage: (message) => posted.push(message) };
  const document = {
    addEventListener: (type, handler) => { listeners[`document:${type}`] = handler; },
    getElementById: (id) => (id === "s3b" ? heading : null),
    getElementsByName: () => []
  };
  const window = {
    pageYOffset: 0,
    addEventListener: (type, handler) => { listeners[`window:${type}`] = handler; }
  };
  const click = (href, extra = {}) => {
    let prevented = false;
    const link = { getAttribute: (name) => (name === "href" ? href : extra.target || null) };
    listeners["document:click"]({
      button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      ...extra,
      target: { closest: () => link },
      preventDefault: () => { prevented = true; }
    });
    return prevented;
  };
  return { context: { document, window, parent, decodeURIComponent }, posted, listeners, click, parent };
}

test("in-document links inside an HTML artifact frame scroll the page instead of navigating", async () => {
  const page = await renderedPage();
  const srcdoc = decodeAttribute(/class="artifact-frame" sandbox="allow-scripts allow-forms allow-popups" srcdoc="([^"]*)"/.exec(page)[1]);
  const frameScript = scripts(srcdoc).find((source) => source.includes("__artifactyFind"));
  assert.ok(frameScript, "the frame carries the anchor script");

  const harness = frameHarness();
  vm.runInNewContext(frameScript, harness.context);

  assert.equal(harness.click("#s3b"), true, "the default navigation is cancelled");
  assert.deepEqual(plain(harness.posted.pop()), { __artifactyScroll: 640, __artifactyHash: "s3b" });
  assert.equal(harness.click("#top"), true);
  assert.deepEqual(plain(harness.posted.pop()), { __artifactyScroll: 0, __artifactyHash: "top" });
  assert.equal(harness.click("#missing"), true, "a missing target still never loads the parent URL in the frame");
  assert.equal(harness.posted.length, 0);
  assert.equal(harness.click("#s3b", { target: "_blank" }), false, "other targets keep their default");
  assert.equal(harness.click("#s3b", { ctrlKey: true }), false, "modified clicks keep their default");
  assert.equal(harness.click("https://example.test/"), false, "ordinary links are untouched");
  assert.equal(harness.posted.length, 0);

  harness.listeners["window:message"]({ source: {}, data: { __artifactyFind: "s3b" } });
  assert.equal(harness.posted.length, 0, "only the parent may ask for a target");
  harness.listeners["window:message"]({ source: harness.parent, data: { __artifactyFind: "s3b" } });
  assert.deepEqual(plain(harness.posted.pop()), { __artifactyScroll: 640, __artifactyRestore: true });
});

test("the page scrolls only within the frame that asked and records the hash", async () => {
  const page = await renderedPage();
  const pageScript = scripts(page).find((source) => source.includes("__artifactyScroll"));
  assert.ok(pageScript, "the page carries the frame listener");

  const frameWindow = { postMessage: () => {} };
  const frame = { contentWindow: frameWindow, offsetHeight: 900, style: {}, getBoundingClientRect: () => ({ top: 200 }) };
  const scrolls = [];
  const pushed = [];
  const listeners = {};
  const window = {
    pageYOffset: 100,
    addEventListener: (type, handler) => { listeners[type] = handler; },
    scrollTo: (options) => scrolls.push(options),
    matchMedia: () => ({ matches: false })
  };
  const context = {
    window,
    document: { querySelectorAll: () => [frame] },
    location: { hash: "", pathname: "/artifacts/a", search: "?lang=ko" },
    history: { pushState: (_state, _title, url) => pushed.push(url) },
    setTimeout,
    isFinite
  };
  vm.runInNewContext(pageScript, context);
  const send = (data, source = frameWindow) => listeners.message({ source, data });

  send({ __artifactyScroll: 640, __artifactyHash: "s3b" });
  assert.deepEqual(plain(scrolls.pop()), { top: 200 + 100 + 640 - 16, behavior: "smooth" });
  assert.deepEqual(pushed.pop(), "/artifacts/a?lang=ko#s3b");

  send({ __artifactyScroll: 1e9, __artifactyHash: "far" });
  assert.equal(scrolls.pop().top, 200 + 100 + 900 - 16, "the offset is clamped to the frame");
  assert.equal(pushed.pop(), "/artifacts/a?lang=ko#far");

  send({ __artifactyScroll: 50 }, { postMessage: () => {} });
  send({ __artifactyScroll: Number.NaN });
  assert.equal(scrolls.length, 0, "unknown sources and invalid offsets are ignored");

  send({ __artifactyScroll: 640, __artifactyRestore: true });
  assert.equal(scrolls.pop().behavior, "auto");
  assert.equal(pushed.length, 0, "restoring a hash does not add history");

  send({ __artifactyHeight: 1234 });
  assert.equal(frame.style.height, "1234px", "height messages still size the frame");
});

test("frame height includes the frame's own border so the document never scrolls inside it", async () => {
  const page = await renderedPage();
  const pageScript = scripts(page).find((source) => source.includes("__artifactyScroll"));
  const frameWindow = { postMessage: () => {} };
  // A 1px border on each side: offsetHeight - clientHeight = 2.
  const frame = { contentWindow: frameWindow, offsetHeight: 322, clientHeight: 320, style: {} };
  const listeners = {};
  const context = {
    window: { innerHeight: 1000, pageYOffset: 0, addEventListener: (type, handler) => { listeners[type] = handler; } },
    document: { querySelectorAll: () => [frame] },
    location: { hash: "", pathname: "/", search: "" },
    history: {},
    setTimeout,
    isFinite
  };
  vm.runInNewContext(pageScript, context);
  const send = (data) => listeners.message({ source: frameWindow, data });
  send({ __artifactyHeight: 2767.4 });
  assert.equal(frame.style.height, "2770px", "content rounded up plus 2px of border");
  send({ __artifactyHeight: 318, __artifactyFillsViewport: true });
  assert.equal(frame.style.height, "852px", "a screen-filling app document gets about one screen of height");
  send({ __artifactyHeight: 10 });
  assert.equal(frame.style.height, "200px", "the minimum still applies");

  const srcdoc = decodeAttribute(/class="artifact-frame" sandbox="allow-scripts allow-forms allow-popups" srcdoc="([^"]*)"/.exec(page)[1]);
  assert.match(srcdoc, /function fillsViewport\(\)/);
  assert.match(srcdoc, /__artifactyFillsViewport:fillsViewport\(\)/);
});
