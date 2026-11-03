import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { renderAdminUpdatePage } from "../src/lib/render.js";

const check = { supported: true, updateAvailable: true, confirmationId: 'id<unsafe>', targetVersion: '99.0.0', expiresAt: '2099-01-01T01:02:00.000Z' };
function render(status, locale = "en") {
  return renderAdminUpdatePage({ baseUrl: "http://localhost", user: { role: "admin" }, locale, status: { currentVersion: "0.14.0", ...status } });
}

for (const locale of ["en", "ko"]) {
  test(`update confirmation is explicit, escaped, and has a timezone (${locale})`, () => {
    const html = render({ check }, locale);
    assert.match(html, /name="confirmUpdate" value="true" required/);
    assert.match(html, /id&lt;unsafe&gt;/);
    assert.match(html, /href="https:\/\/github.com\/raeseoklee\/artifacty\/releases\/tag\/v99.0.0"/);
    assert.match(html, /<time datetime="2099-01-01T01:02:00.000Z"[^>]*>[^<]+ UTC<\/time>/);
    assert.match(html, locale === "ko" ? /업데이트가 있습니다/ : /An update is available/);
  });
}

test("update start requires a fresh supported confirmation and no blocking run", () => {
  for (const patch of [{ supported: false }, { confirmationId: null }, { expiresAt: '2000-01-01' }, { expiresAt: 'invalid' }, { errorCode: 'UPDATE_CHECK_FAILED' }, { targetVersion: null }, { updateAvailable: false }]) {
    assert.doesNotMatch(render({ check: { ...check, ...patch } }), /action="\/admin\/update\/start"/);
  }
  for (const state of ["queued", "running", "interrupted"]) {
    assert.doesNotMatch(render({ check, run: { state } }), /action="\/admin\/update\/start"/);
  }
  assert.doesNotMatch(render({ check, currentVersion: check.targetVersion }), /action="\/admin\/update\/start"/);
  assert.doesNotMatch(render({}), /action="\/admin\/update\/start"/);
});

test("lookup errors do not claim the installation is up to date", () => {
  const html = render({ check: { ...check, updateAvailable: false, errorCode: 'UPDATE_CHECK_FAILED' } });
  assert.match(html, /Could not check the latest version/);
  assert.doesNotMatch(html, /This installation is up to date/);
});

const client = readFileSync(new URL("../src/client/update.js", import.meta.url), "utf8");
for (const scenario of ["succeeded", "failed", "interrupted", "running", "offline", "401", "403"]) {
  test(`update polling handles ${scenario} without submitting an update`, async () => {
    const state = {}, error = {}, version = {}, login = { hidden: true }, timers = [], requests = [];
    const messages = { succeeded: "done", failed: "failed", interrupted: "interrupted", running: "running", signIn: "login", reconnect: "reconnect" };
    const panel = { dataset: { active: "true", messages: JSON.stringify(messages) }, querySelector: (selector) => selector.includes("state") ? state : selector.includes("error") ? error : selector.includes("login") ? login : null };
    const fetch = async (url, options) => {
      requests.push({ url, options });
      if (scenario === "offline") throw new Error("offline");
      const status = Number(scenario) || 200;
      return { status, ok: status === 200, json: async () => ({ currentVersion: "99.0.0", run: { state: scenario, error: "<unsafe>" } }) };
    };
    vm.runInNewContext(client, { document: { querySelector: (selector) => selector.includes("status") ? panel : version }, fetch, window: { setTimeout: (callback) => timers.push(callback) } });
    await timers.shift()();
    assert.equal(timers.length, ["running", "offline"].includes(scenario) ? 1 : 0);
    assert.equal(requests[0].url, "/admin/update/status");
    assert.equal(requests[0].options.method, undefined);
    if (["401", "403"].includes(scenario)) { assert.equal(login.hidden, false); assert.equal(state.textContent, "login"); }
    else if (scenario === "offline") assert.equal(state.textContent, "reconnect");
    else { assert.equal(state.textContent, messages[scenario]); assert.equal(error.textContent, "<unsafe>"); }
  });
}

test("an up-to-date installation shows only the current-version message without target or release links", () => {
  for (const locale of ["en", "ko"]) {
    const html = render({ check: { ...check, targetVersion: '0.14.0', updateAvailable: false } }, locale);
    assert.match(html, locale === 'ko' ? /최신 버전입니다/ : /You’re up to date/);
    assert.doesNotMatch(html, /releases\/tag|action="\/admin\/update\/start"|<h2>Available version<\/h2>|<h2>업데이트할 버전<\/h2>/);
    assert.match(html, /data-update-version>0.14.0/);
  }
});

test("system services show administrator CLI guidance in both languages", () => {
  for (const locale of ["en", "ko"]) {
    const html = render({ check: { ...check, supported: false, reasonCode: "SYSTEM_UPDATE_REQUIRES_ADMIN", reason: "SECRET" } }, locale);
    assert.match(html, /--service-scope system/);
    assert.match(html, /--service-name/);
    assert.doesNotMatch(html, /SECRET|action="\/admin\/update\/start"/);
  }
});


test("update progress tracks structured steps without claiming completion before health passes", () => {
  for (const [step, value, number] of [["preparing", 0, 1], ["staging", 1, 2], ["backup", 2, 3], ["switching", 3, 4], ["health", 4, 5]]) {
    const html = render({ run: { state: "running", step, targetVersion: "99.0.0" } });
    assert.match(html, new RegExp(`aria-valuenow="${value}"`));
    assert.match(html, new RegExp(`Step ${number} of 5:`));
    assert.match(html, new RegExp(`style="width: ${value * 20}%"`));
    assert.doesNotMatch(html, /data-update-step[^>]*>All update steps completed/);
  }
  const success = render({ run: { state: "succeeded", targetVersion: "99.0.0" } });
  assert.match(success, /aria-valuenow="5"/);
  assert.match(success, /data-update-step[^>]*>All update steps completed/);
  for (const run of [{state:"queued"}, {state:"running",step:"future-step"}, {state:"running",step:"recovery"}, {state:"failed",step:"completed"}, {state:"interrupted",step:"completed"}]) {
    const html = render({run});
    assert.match(html, /role="progressbar"/);
    assert.doesNotMatch(html, /aria-valuenow=|data-update-step[^>]*>All update steps completed/);
  }
});

test("refreshing the updated version dismisses a completed run but preserves recovery warnings", () => {
  assert.doesNotMatch(render({ run: { state: "succeeded", targetVersion: "0.14.0" } }), /data-update-status|All update steps completed/);
  for (const state of ["failed", "interrupted"]) {
    assert.match(render({ run: { state, targetVersion: "0.14.0" } }), /data-update-status/);
  }
});

test("polling updates accessible progress and removes numeric values for recovery", async () => {
  const attributes = new Map(), toggles = new Map(), timers = [];
  const progress = { setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
  const bar = { style: {}, classList: { toggle: (name, value) => toggles.set(name, value) } };
  const step = {}, state = {}, error = {}, version = {};
  const messages = { running: "running", succeeded: "done", steps: { staging: "Checking release", health: "Checking health", completed: "All steps done", recovery: "Restoring backup" }, stepCount: "Step {current} of {total}: {phase}" };
  const elements = { "[data-update-progress]": progress, "[data-update-bar]": bar, "[data-update-step]": step, "[data-update-state]": state, "[data-update-error]": error };
  const panel = { dataset: { active: "true", messages: JSON.stringify(messages) }, querySelector: selector => elements[selector] || null };
  let run = { state: "running", step: "staging" };
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ run }) });
  vm.runInNewContext(client, { document: { querySelector: selector => selector.includes("status") ? panel : version }, fetch, window: { setTimeout: callback => timers.push(callback) } });
  await timers.shift()();
  assert.equal(attributes.get("aria-valuenow"), "1");
  assert.equal(step.textContent, "Step 2 of 5: Checking release");
  assert.equal(bar.style.width, "20%");
  run = { state: "running", step: "recovery" };
  await timers.shift()();
  assert.equal(attributes.has("aria-valuenow"), false);
  assert.equal(step.textContent, "Restoring backup");
  run = { state: "succeeded", step: "completed" };
  await timers.shift()();
  assert.equal(attributes.get("aria-valuenow"), "5");
  assert.equal(bar.style.width, "100%");
  assert.equal(timers.length, 0);
});
