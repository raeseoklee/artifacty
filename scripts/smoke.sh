#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/artifacty-smoke-XXXXXX")"
PORT="${ARTIFACTY_SMOKE_PORT:-$((18000 + RANDOM % 1000))}"
URL="http://127.0.0.1:${PORT}"
TOKEN="artifacty-smoke-token"
SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID}" ]]; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${HOME_DIR}"
}
trap cleanup EXIT

ARTIFACTY_HOME="${HOME_DIR}" ARTIFACTY_API_TOKEN="${TOKEN}" \
  node "${ROOT}/src/server.js" --host 127.0.0.1 --port "${PORT}" \
  >"${HOME_DIR}/server.out.log" 2>"${HOME_DIR}/server.err.log" &
SERVER_PID="$!"

node --input-type=module - "${URL}" "${TOKEN}" <<'NODE'
const [url, token] = process.argv.slice(2);

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await waitForHealth();

let editorResponse = await fetch(`${url}/new`);
assert(editorResponse.status === 200, `expected editor page status 200, got ${editorResponse.status}`);
let editorPage = await editorResponse.text();
assert(editorPage.includes("/assets/editor.js"), "editor page missing CodeMirror script");

editorResponse = await fetch(`${url}/assets/editor.js`);
assert(editorResponse.status === 200, `expected editor asset status 200, got ${editorResponse.status}`);

editorResponse = await fetch(`${url}/vendor/npm/codemirror`);
assert(editorResponse.status === 200, `expected CodeMirror vendor status 200, got ${editorResponse.status}`);

let response = await fetch(`${url}/api/artifacts`);
assert(response.status === 401, `expected unauthenticated API to return 401, got ${response.status}`);

response = await fetch(`${url}/api/artifacts`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-artifacty-token": token
  },
  body: JSON.stringify({
    title: "Smoke Artifact",
    content: "# Smoke",
    format: "markdown",
    sourceAgent: "smoke"
  })
});
assert(response.status === 201, `expected create status 201, got ${response.status}`);
const created = await response.json();
assert(created.id && created.rawUrl, "create response missing artifact URLs");

response = await fetch(`${url}/api/artifacts`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-artifacty-token": token
  },
  body: JSON.stringify({
    title: "Blocked Secret",
    content: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    format: "text"
  })
});
assert(response.status === 400, `expected secret scan status 400, got ${response.status}`);
const blocked = await response.json();
assert(blocked.code === "SECRET_DETECTED", `unexpected secret scan code ${blocked.code}`);

response = await fetch(`${url}/api/audit`, {
  headers: { "x-artifacty-token": token }
});
assert(response.status === 200, `expected audit status 200, got ${response.status}`);
const audit = await response.json();
assert(audit.events.some((event) => event.action === "create"), "audit log missing create event");
NODE

ARTIFACTY_HOME="${HOME_DIR}" node "${ROOT}/src/cli.js" backup --file "${HOME_DIR}/backup.json" >/dev/null
ARTIFACTY_HOME="${HOME_DIR}" node "${ROOT}/src/cli.js" check --home "${HOME_DIR}" >/dev/null

printf 'Artifacty smoke passed: %s\n' "${URL}"
