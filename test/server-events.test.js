// SSE / polling coverage for GET /api/events (roadmap section 3).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createArtifact, createStore } from "../src/lib/storage.js";

// Reads chunks from `reader` sequentially (never more than one outstanding
// read() at a time) until `predicate(buffer)` is true or `timeoutMs`
// elapses.
async function readUntil(reader, predicate, timeoutMs = 5000) {
  let buffer = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), Math.max(remaining, 0)))
    ]);
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }
    if (predicate(buffer)) {
      return buffer;
    }
    if (done) {
      break;
    }
  }
  throw new Error(`Timed out waiting for stream content. Buffer so far:\n${buffer}`);
}

test("GET /api/events with Accept: text/event-stream streams an event published after a create", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-sse-"));
  const app = await startServer({ port: 0, home });
  const controller = new AbortController();
  try {
    const streamResponse = await fetch(`${app.url}/api/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") || "", /text\/event-stream/);

    const reader = streamResponse.body.getReader();
    await readUntil(reader, (text) => text.includes(": connected"));

    const createResponse = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "SSE Demo", content: "hello", sourceAgent: "test", tags: ["sse"] })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();

    const buffer = await readUntil(reader, (text) => text.includes(created.id));
    assert.match(buffer, /event: artifact\.created/);
    assert.match(buffer, /data: \{.*"artifactId":"[^"]*"/s);
  } finally {
    controller.abort();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("GET /api/events replays from Last-Event-ID and supports the JSON polling mode with ?since=", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-sse-"));
  const app = await startServer({ port: 0, home });
  const controller = new AbortController();
  try {
    const first = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "One", content: "1", sourceAgent: "test" })
    }).then((r) => r.json());

    const pollAll = await fetch(`${app.url}/api/events?since=0`).then((r) => r.json());
    assert.equal(pollAll.events.length, 1);
    assert.equal(pollAll.events[0].type, "artifact.created");
    assert.equal(pollAll.events[0].artifactId, first.id);
    const seqAfterFirst = pollAll.seq;

    const second = await fetch(`${app.url}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Two", content: "2", sourceAgent: "test" })
    }).then((r) => r.json());

    const pollSince = await fetch(`${app.url}/api/events?since=${seqAfterFirst}`).then((r) => r.json());
    assert.equal(pollSince.events.length, 1);
    assert.equal(pollSince.events[0].artifactId, second.id);

    // Last-Event-ID replay via the SSE stream should pick up exactly the
    // one event created after seqAfterFirst, and not repeat the first one.
    const replayResponse = await fetch(`${app.url}/api/events`, {
      headers: { accept: "text/event-stream", "last-event-id": String(seqAfterFirst) },
      signal: controller.signal
    });
    const reader = replayResponse.body.getReader();
    const buffer = await readUntil(reader, (text) => text.includes(second.id));
    assert.ok(!buffer.includes(first.id), "replay should not repeat the already-seen first event");
  } finally {
    controller.abort();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("GET /api/events returns 503 once ARTIFACTY_SSE_MAX_CLIENTS is exceeded", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-sse-"));
  const originalMax = process.env.ARTIFACTY_SSE_MAX_CLIENTS;
  process.env.ARTIFACTY_SSE_MAX_CLIENTS = "1";
  const app = await startServer({ port: 0, home });
  const controllerA = new AbortController();
  try {
    const first = await fetch(`${app.url}/api/events`, {
      headers: { accept: "text/event-stream" },
      signal: controllerA.signal
    });
    assert.equal(first.status, 200);
    // Give the server a tick to register the connection before the second request.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await fetch(`${app.url}/api/events`, { headers: { accept: "text/event-stream" } });
    assert.equal(second.status, 503);
    const body = await second.json();
    assert.equal(body.code, "sse_capacity");
  } finally {
    controllerA.abort();
    if (originalMax === undefined) {
      delete process.env.ARTIFACTY_SSE_MAX_CLIENTS;
    } else {
      process.env.ARTIFACTY_SSE_MAX_CLIENTS = originalMax;
    }
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("GET /api/events requires a token when ARTIFACTY_API_TOKEN is configured", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-sse-"));
  const app = await startServer({ port: 0, home, apiToken: "secret-token" });
  try {
    const unauthorized = await fetch(`${app.url}/api/events?since=0`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${app.url}/api/events?since=0`, {
      headers: { authorization: "Bearer secret-token" }
    });
    assert.equal(authorized.status, 200);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("an event written by a different process sharing the same store (e.g. the CLI or another local MCP server) still reaches an SSE client", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-sse-"));
  const originalPollMs = process.env.ARTIFACTY_EVENT_POLL_MS;
  process.env.ARTIFACTY_EVENT_POLL_MS = "50";
  const app = await startServer({ port: 0, home });
  const controller = new AbortController();
  try {
    const streamResponse = await fetch(`${app.url}/api/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    await readUntil(reader, (text) => text.includes(": connected"));

    // Simulate a second process (a separate DatabaseSync handle onto the
    // same store, exactly like a sibling `artifacty publish` CLI invocation
    // or a local stdio MCP server) writing an artifact directly through
    // storage.js rather than through this server's in-process createArtifact
    // call. This does NOT go through this process's events.publish(), so it
    // can only be observed by this server via the store-backed poller.
    const otherProcessStore = createStore({ home });
    const artifact = await createArtifact(otherProcessStore, {
      title: "From another process",
      content: "hello",
      sourceAgent: "test"
    });

    const buffer = await readUntil(reader, (text) => text.includes(artifact.id), 5000);
    assert.match(buffer, /event: artifact\.created/);
    assert.ok(buffer.includes(artifact.id));
  } finally {
    controller.abort();
    if (originalPollMs === undefined) {
      delete process.env.ARTIFACTY_EVENT_POLL_MS;
    } else {
      process.env.ARTIFACTY_EVENT_POLL_MS = originalPollMs;
    }
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
