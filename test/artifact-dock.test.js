import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { createArtifact, updateArtifact } from "../src/lib/storage.js";

test("the artifact page carries an inert floating bar with the header actions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "artifacty-dock-"));
  const app = await startServer({ home, port: 0 });
  try {
    const single = await createArtifact(app.store, { title: "Single <version>", content: "# One", format: "markdown", sourceAgent: "test" });
    const page = await (await fetch(`${app.url}/artifacts/${single.id}`)).text();
    const dock = /<div class="artifact-dock" data-artifact-dock aria-hidden="true" inert>([\s\S]*?)\n      <\/div>/.exec(page)?.[1];
    assert.ok(dock, "the bar starts hidden and inert");
    assert.match(dock, /data-dock-top title="Single &lt;version&gt;">Single &lt;version&gt;<\/button>/);
    assert.match(dock, /class="artifact-dock-actions">[\s\S]*data-menu[\s\S]*class="is-primary" href="\/artifacts\/[^"]+\/edit\?version=1"/);
    assert.doesNotMatch(dock, /artifact-dock-versions/, "one version needs no switcher");

    await updateArtifact(app.store, single.id, { content: "# Two" });
    const twoVersions = await (await fetch(`${app.url}/artifacts/${single.id}`)).text();
    assert.match(twoVersions, /<nav class="version-strip artifact-dock-versions" aria-label="[^"]+"><a class="version" href="[^"]+version=1">v1<\/a><a class="version active"/);
    assert.match(twoVersions, /@property --sidebar-w \{ syntax: "<length>"; inherits: true; initial-value: 228px; \}/);
    assert.match(twoVersions, /:root\[data-sidebar-motion\] \{ transition: --sidebar-w/);
    assert.match(twoVersions, /prefers-reduced-motion: reduce\) \{ \.artifact-dock-bar/);
    assert.match(twoVersions, /@media \(max-width: 720px\) \{ \.artifact-dock \{ display: none; \} \}/, "phones keep the page header");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
