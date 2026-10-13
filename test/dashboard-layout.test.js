import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderDashboard } from "../src/lib/render.js";

const render = (options = {}) => renderDashboard({ artifacts: [], baseUrl: "http://127.0.0.1:8787", ...options });
const decode = (value) => value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], decode(match[2])]));

function form(html, className) {
  const found = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].find((match) => (attributes(match[1]).class || "").split(" ").includes(className));
  assert.ok(found, `Missing ${className} form`);
  return { attributes: attributes(found[1]), content: found[2] };
}

function fields(content) {
  const result = new URLSearchParams();
  for (const match of content.matchAll(/<input\b[^>]*>/g)) {
    const input = attributes(match[0]);
    if (!input.name || /\bdisabled\b/.test(match[0])) continue;
    if (input.type === "checkbox" && !/\bchecked\b/.test(match[0])) continue;
    result.append(input.name, input.value || "");
  }
  for (const match of content.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attributes(match[1]).name;
    const options = [...match[2].matchAll(/<option\b([^>]*)>/g)];
    const chosen = options.find((option) => /\bselected\b/.test(option[1])) || options[0];
    if (name && chosen) result.append(name, attributes(chosen[1]).value || "");
  }
  return result;
}

function collapsed(html, className) {
  const tag = [...html.matchAll(/<details\b[^>]*>/g)].find((match) => (attributes(match[0]).class || "").split(" ").includes(className));
  assert.ok(tag, `Missing ${className} disclosure`);
  assert.doesNotMatch(tag[0], /\bopen(?:\s|=|>)/, `${className} should start collapsed`);
}

test("the primary search stays visible while advanced filters and saved views start collapsed", () => {
  const html = render();
  collapsed(html, "dashboard-advanced");
  collapsed(html, "dashboard-saved-views");
  const search = form(html, "filter-form");
  assert.equal(search.attributes.method, "get");
  assert.equal(search.attributes.action, "/");
  const advancedIndex = search.content.indexOf("<details");
  assert.ok(advancedIndex > search.content.indexOf('name="q"'));
  assert.match(search.content.slice(0, advancedIndex), /type="submit"/);
  assert.doesNotMatch(search.content, /<form\b/);
  assert.match(html, /<summary[^>]*>[\s\S]*?Advanced filters/);
  assert.match(html, /Saved views/);
});

test("search submission preserves advanced, relationship, grouping, locale, and page-size filters", () => {
  const filters = {
    query: "Search & compare", tag: "manual", sourceAgent: "codex", artifactType: "document",
    publisher: "editor@example.com", createdAfter: "2026-01-01", createdBefore: "2026-12-31",
    reviewStatus: "pending", relatedTo: "source-123", relation: "derived-from", includeArchived: true,
    mode: "hybrid", groupBy: "sourceAgent", limit: "25"
  };
  const html = render({ filters, locale: "ko", embeddingsAvailable: true });
  collapsed(html, "dashboard-advanced");
  const search = fields(form(html, "filter-form").content);
  for (const [key, value] of Object.entries(filters)) {
    const name = key === "query" ? "q" : key;
    assert.deepEqual(search.getAll(name), [String(value)], `${name} should submit once`);
  }
  assert.equal(search.get("lang"), "ko");
  assert.equal(search.has("offset"), false, "A changed search starts at its first page");
});

test("active filter count excludes the main query and clear retains only the selected locale", () => {
  const html = render({ locale: "ko", filters: { query: "keyword", tag: "manual", relatedTo: "source-123", relation: "references", includeArchived: true, groupBy: "day", limit: "25" } });
  const count = /<[^>]+class="[^"]*dashboard-filter-count[^>]*>([\s\S]*?)<\//.exec(html);
  assert.ok(count);
  assert.equal(count[1].trim(), "5개 적용");
  assert.match(html, /상세 필터/);
  assert.match(html, /저장된 뷰/);
  const clear = [...form(html, "filter-form").content.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].find((match) => match[2].includes("초기화"));
  assert.ok(clear);
  const url = new URL(attributes(clear[1]).href, "http://localhost");
  assert.equal(url.pathname, "/");
  assert.deepEqual([...url.searchParams], [["lang", "ko"]]);
});

test("every visible search control has a text label in both dashboard locales", () => {
  for (const locale of ["en", "ko"]) {
    const search = form(render({ locale, embeddingsAvailable: true }), "filter-form");
    const labels = [...search.content.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)];
    const controls = [...search.content.matchAll(/<(?:input|select)\b[^>]*>/g)]
      .filter((match) => attributes(match[0]).type !== "hidden");
    for (const [control] of controls) {
      const name = attributes(control).name;
      const label = labels.find((match) => match[1].includes(control));
      assert.ok(label, `${locale}: ${name} needs a label`);
      const labelText = label[1].replace(/<select\b[\s\S]*?<\/select>/g, "").replace(/<[^>]*>/g, "").trim();
      assert.ok(labelText, `${locale}: ${name} needs label text`);
    }
  }
});

test("unavailable embedding controls preserve an existing search mode", () => {
  const search = form(render({ filters: { mode: "semantic" }, embeddingsAvailable: false }), "filter-form");
  assert.equal(fields(search.content).get("mode"), "semantic");
  assert.doesNotMatch(search.content, /<select[^>]*name="mode"/);
});

test("active input values and saved-view names are escaped without losing submitted values", () => {
  const unsafe = '\"><img src=x onerror="alert(1)">&';
  const html = render({ filters: { query: unsafe, tag: unsafe, relatedTo: unsafe, publisher: unsafe }, savedViews: [{ id: "view-1", name: unsafe, shared: true }] });
  assert.ok(!html.includes(unsafe));
  assert.doesNotMatch(html, /<img src=x/);
  const search = fields(form(html, "filter-form").content);
  for (const name of ["q", "tag", "relatedTo", "publisher"]) assert.equal(search.get(name), unsafe);
  const saved = fields(form(html, "saved-view-form").content);
  assert.equal(saved.get("query"), unsafe);
  assert.equal(saved.get("relatedTo"), unsafe);
});

test("saving the current view retains all persisted filter values in a separate POST form", () => {
  const filters = { query: "manual", tag: "docs", sourceAgent: "claude", artifactType: "document", publisher: "owner", createdAfter: "2026-01-01", createdBefore: "2026-02-01", reviewStatus: "approved", relatedTo: "manual-1", relation: "reviews", includeArchived: true, mode: "keyword" };
  const html = render({ filters, locale: "ko" });
  const saved = form(html, "saved-view-form");
  assert.equal(saved.attributes.method, "post");
  assert.equal(new URL(saved.attributes.action, "http://localhost").pathname, "/views");
  const values = fields(saved.content);
  for (const [key, value] of Object.entries(filters)) assert.equal(values.get(key), String(value));
  assert.equal(values.get("lang"), "ko");
  assert.doesNotMatch(saved.content, /<form\b/);
});

const adminPaths = ["/admin/access", "/admin/users", "/admin/backup", "/admin/retention", "/admin/webhooks"];
const member = { id: "member", name: "Member", email: "member@example.com", role: "user" };
const admin = { ...member, id: "admin", role: "admin" };
const version = { version: 1, format: "text", sizeBytes: 5, sha256: "a".repeat(64), createdAt: "2026-10-13", metadata: {} };
const artifact = { id: "example", title: "Example", sourceAgent: "artifacty", tags: [], versions: [version], latestVersion: 1, ownerUserId: member.id, visibility: "team" };
const pageOptions = { baseUrl: "http://localhost", artifact, version, content: "Hello", locale: "ko" };
const links = (html) => [...html.matchAll(/<a\b([^>]*)>/g)].map((match) => new URL(attributes(match[1]).href, "http://localhost"));

function assertWorkspaceLinks(html, user) {
  const urls = links(html);
  for (const pathname of ["/", "/new", "/import", "/docs/api", ...(user ? ["/inbox", "/account", "/account/password"] : ["/login"])]) {
    assert.ok(urls.some((url) => url.pathname === pathname && url.searchParams.get("lang") === "ko"), `Missing localized navigation to ${pathname}`);
  }
  for (const pathname of adminPaths) {
    assert.equal(urls.some((url) => url.pathname === pathname), user?.role === "admin", `${pathname} must respect role`);
  }
}

test("workspace navigation exposes administrative routes only to administrators", () => {
  for (const user of [null, member, admin]) assertWorkspaceLinks(render({ user, locale: "ko" }), user);
});

test("viewer, editor, import, and administration retain the same role-aware workspace destinations", async () => {
  const { renderArtifactPage, renderArtifactFormPage, renderImportArtifactPage, renderAdminAccessPage } = await import("../src/lib/render.js");
  for (const user of [member, admin]) {
    assertWorkspaceLinks(renderArtifactPage({ ...pageOptions, user, permission: "owner" }), user);
    assertWorkspaceLinks(renderArtifactFormPage({ ...pageOptions, user, mode: "edit" }), user);
    assertWorkspaceLinks(renderImportArtifactPage({ ...pageOptions, user }), user);
  }
  assertWorkspaceLinks(renderAdminAccessPage({ ...pageOptions, user: admin, mode: "private" }), admin);
});

test("artifact edit and sharing actions retain their existing permission boundaries", async () => {
  const { renderArtifactPage } = await import("../src/lib/render.js");
  for (const permission of ["read", "comment", "edit", "owner", "admin"]) {
    const user = permission === "admin" ? admin : permission === "owner" ? member : { ...member, id: "other" };
    const paths = links(renderArtifactPage({ ...pageOptions, user, permission })).map((url) => url.pathname);
    assert.equal(paths.includes("/artifacts/example/edit"), ["edit", "owner", "admin"].includes(permission));
    assert.equal(paths.includes("/artifacts/example/sharing"), ["owner", "admin"].includes(permission));
  }
});

test("public capability viewers and embedded frames do not expose workspace navigation", async () => {
  const { renderSharedArtifactPage, renderReactFramePage } = await import("../src/lib/render.js");
  const shared = renderSharedArtifactPage({ ...pageOptions, sharePath: "/s/capability", version: { ...version, format: "html" }, content: "<p>Shared</p>" });
  const frame = renderReactFramePage({ title: "Embedded", content: "export default function App() { return null; }" });
  for (const html of [shared, frame]) {
    const paths = links(html).map((url) => url.pathname);
    for (const pathname of ["/", "/new", "/import", "/account", "/inbox", ...adminPaths]) assert.ok(!paths.includes(pathname), `${pathname} leaked into a standalone viewer`);
    assert.doesNotMatch(html, /<nav\b/);
  }
  assert.match(shared, /sandbox=""/);
  assert.match(shared, /src="\/s\/capability\/raw"/);
});

test("dashboard omits storage backend details and shows the installed release only to administrators", () => {
  const installedVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  for (const locale of ["en", "ko"]) {
    for (const user of [null, member, admin]) {
      const html = render({ user, locale, pagination: { total: 0, offset: 0, limit: 50, search: { backend: "sqlite-fts5" } } });
      const visibleText = html.replace(/<style\b[\s\S]*?<\/style>/g, "").replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, " ");
      assert.doesNotMatch(visibleText, /sqlite/i);
      assert.equal(visibleText.includes(installedVersion), user?.role === "admin", `${locale}: installed release must be visible only to administrators`);
    }
  }
});
