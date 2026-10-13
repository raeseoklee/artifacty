import test from "node:test";
import assert from "node:assert/strict";
import { renderAdminAccessPage, renderArtifactSharingPage, renderSharedArtifactPage, renderInboxPage, renderArtifactPage } from "../src/lib/render.js";
const baseUrl = "http://localhost:8787";
const user = { id: "owner", role: "admin" };
const version = { version: 1, format: "text", metadata: {}, sizeBytes: 5, createdAt: "2026-10-13", sha256: "a".repeat(64) };
const artifact = { id: "secret-id", title: "Manual", ownerUserId: "owner", versions: [version], relations: [{ targetId: "secret-relation" }] };

test("access settings preview exposure and confirm or roll back network changes", () => {
  const initial = renderAdminAccessPage({ baseUrl, user, mode: "private" });
  assert.match(initial, /action="\/admin\/access\/preview"/);
  assert.doesNotMatch(initial, /<form[^>]*method="post"[^>]*action="\/admin\/access"/);
  const html = renderAdminAccessPage({ baseUrl, user, mode: "private", preview: { mode: "public", anonymousArtifactCount: 12 }, pendingNetworkPolicy: { id: 'p"1', expiresAt: "2026-10-13" }, shareLinkPolicy: { enabledInPrivate: true } });
  assert.match(html, /12 artifacts will be readable/);
  assert.match(html, /action="\/admin\/access"/);
  assert.match(html, /action="\/admin\/access\/network\/confirm"/);
  assert.match(html, /action="\/admin\/access\/network\/rollback"/);
  assert.match(html, /name="id" value="p&quot;1"/);
  assert.match(html, /name="enabledInPrivate" value="true" checked/);
  assert.match(html, /action="\/admin\/samples\/install"/);
  assert.match(html, /action="\/admin\/samples\/remove"/);
});

test("sharing selects grant levels and explains effective and network permissions", () => {
  const options = { baseUrl, user, artifact, users: [{ id: 'u"1', name: "<User>" }, { id: "disabled", active: false }], teams: [{ id: "t1", name: "Team" }], sharing: { userIds: ['u"1'], teamIds: ["t1"], userPermissions: { 'u"1': "comment" }, teamPermissions: { t1: "edit" } }, accessReport: { anonymousRead: false, users: [{ id: "u1", name: "User", permission: "comment", reasons: ["<direct>"] }] }, networkPolicy: { allowedCidrs: ["10.0.0.0/8"] } };
  const html = renderArtifactSharingPage(options);
  assert.match(html, /name="userPermission:u&quot;1"/);
  assert.match(html, /value="comment" selected/);
  assert.match(html, /name="teamPermission:t1"/);
  assert.match(html, /value="edit" selected/);
  assert.match(html, /10\.0\.0\.0\/8/);
  assert.match(html, /&lt;direct&gt;/);
  assert.doesNotMatch(html, /value="disabled"/);
  assert.doesNotMatch(renderArtifactSharingPage({ ...options, user: { id: "other", role: "user" } }), /&lt;direct&gt;/);
});

test("share links expose token once and support expiration, pinning and revocation", () => {
  const html = renderArtifactSharingPage({ baseUrl, user, artifact, createdShareLink: { token: "one/token" }, shareLinks: [{ id: "l1", version: 1, expiresAt: "2026-10-20" }, { id: "l2", revokedAt: "2026-10-14", expiresAt: "2026-10-20" }] });
  assert.match(html, /http:\/\/localhost:8787\/s\/one%2Ftoken/);
  assert.match(html, /name="version"/);
  assert.match(html, /name="days"/);
  assert.match(html, /share-links\/l1\/revoke/);
  assert.doesNotMatch(html, /share-links\/l2\/revoke/);
});

test("public shared viewer reveals content without private navigation or metadata", () => {
  const html = renderSharedArtifactPage({ artifact, version, content: "hello", sharePath: "/s/token" });
  assert.match(html, /hello/);
  assert.doesNotMatch(html, /secret-id|secret-relation|href="\/artifacts|<form\b[^>]*\baction=|href="\/account/);
  const image = renderSharedArtifactPage({ artifact, version: { ...version, format: "image", metadata: { contentType: "image/png" } }, content: "YWJj", sharePath: "/s/token" });
  assert.match(image, /src="\/s\/token\/raw"/);
});

test("inbox uses escaped notification content and explicit read actions", () => {
  const html = renderInboxPage({ baseUrl, user, unreadCount: 1, notifications: [{ id: "n/1", artifactId: "a/1", title: "<Manual>", type: "shared", createdAt: "2026-10-13" }] });
  assert.match(html, /&lt;Manual&gt;/);
  assert.match(html, /href="\/artifacts\/a%2F1"/);
  assert.match(html, /action="\/inbox\/n%2F1\/read"/);
  assert.match(html, /action="\/inbox\/read-all"/);
});

test("readers cannot see comment or edit controls; comment grants show only comment controls", () => {
  const options = { artifact: { ...artifact, relations: undefined }, version, content: "hello", baseUrl, user: { id: "reader", role: "user" }, comments: [] };
  const read = renderArtifactPage({ ...options, permission: "read" });
  assert.doesNotMatch(read, /href="\/artifacts\/secret-id\/edit"|action="\/artifacts\/secret-id\/(archive|comments)"/);
  const comment = renderArtifactPage({ ...options, permission: "comment" });
  assert.match(comment, /action="\/artifacts\/secret-id\/comments"/);
  assert.doesNotMatch(comment, /href="\/artifacts\/secret-id\/edit"/);
});

test("public share previews never execute active artifact source", () => {
  for (const format of ["notebook", "svg", "mermaid", "react"]) {
    const html = renderSharedArtifactPage({ artifact, version: { ...version, format }, content: '<script>fetch(document.baseURI)</script>', sharePath: "/s/private-token" });
    assert.doesNotMatch(html, /<script>fetch|srcdoc=|allow-scripts/);
    assert.match(html, /&lt;script&gt;fetch/);
  }
});

test("edit grants enable editing and comments but retain owner-only archival", () => {
  const options = { artifact: { ...artifact, relations: undefined }, version, content: "hello", baseUrl, user: { id: "editor", role: "user" } };
  const edit = renderArtifactPage({ ...options, permission: "edit" });
  assert.match(edit, /href="\/artifacts\/secret-id\/edit"/);
  assert.match(edit, /action="\/artifacts\/secret-id\/comments"/);
  assert.doesNotMatch(edit, /action="\/artifacts\/secret-id\/archive"/);
  const owner = renderArtifactPage({ ...options, user, permission: "owner" });
  assert.match(owner, /action="\/artifacts\/secret-id\/archive"/);
});


test("public HTML preview is confined to a scriptless capability iframe", () => {
  const html = renderSharedArtifactPage({ artifact, version: { ...version, format: "html" }, content: '<script>fetch(document.baseURI)</script>', sharePath: "/s/private-token" });
  assert.match(html, /<iframe class="artifact-frame" sandbox="" referrerpolicy="no-referrer" src="\/s\/private-token\/raw"><\/iframe>/);
  assert.match(html, /Static preview/);
  assert.doesNotMatch(html, /srcdoc=|allow-scripts|fetch\(document.baseURI\)|secret-id/);
});
