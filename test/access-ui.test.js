import test from "node:test";
import assert from "node:assert/strict";
import { renderAdminAccessPage, renderArtifactSharingPage, renderArtifactPage, renderAccountPage } from "../src/lib/render.js";

const user = { id: "owner", role: "admin", name: "Owner", email: "owner@example.com" };
const users = [{ id: 'u"1', name: "<script>person</script>", email: "user@example.com" }];
const teams = [{ id: "team/1", name: "<b>Research</b>", memberIds: ['u"1'] }];
const artifact = { id: "artifact/1", title: "<b>Manual</b>", ownerUserId: "owner", sourceAgent: "codex", tags: [], versions: [{ version: 1 }] };

test("admin access forms expose modes, membership and escaped values", () => {
  const html = renderAdminAccessPage({ baseUrl: "http://localhost", user, mode: "private", users, teams, networkPolicy: { allowedCidrs: ["127.0.0.1/32", "::1/128"] }, currentIp: "127.0.0.1" });
  assert.match(html, /action="\/admin\/access\/preview"/);
  assert.match(html, /name="mode" value="private" checked/);
  assert.match(html, /without signing in/);
  assert.match(html, /explicitly allowed users or team members/);
  assert.match(html, /action="\/admin\/teams\/team%2F1\/members"/);
  assert.match(html, /name="userIds" value="u&quot;1" checked/);
  assert.match(html, /&lt;script&gt;person&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>person/);
  assert.match(html, /action="\/admin\/access\/network"/);
  assert.match(html, /name="allowedCidrs"/);
  assert.match(html, /127\.0\.0\.1\/32\n::1\/128/);
  assert.match(html, /direct connection IP/);
  assert.match(html, /name="allowSharedLinks" value="true" class=/);
  assert.match(html, /The dashboard and APIs stay restricted/);
  const enabled = renderAdminAccessPage({ baseUrl: "http://localhost", user, mode: "private", networkPolicy: { allowedCidrs: [], allowSharedLinks: true }, locale: "ko" });
  assert.match(enabled, /name="allowSharedLinks" value="true" checked/);
  assert.match(enabled, /허용 IP 대역 밖에서도 공유 링크 열람 허용/);
});

test("sharing grant levels are explained, selected and localized", () => {
  const html = renderArtifactSharingPage({ baseUrl: "http://localhost", user, artifact, users, teams, sharing: { userIds: ['u"1'], teamIds: ["team/1"] } });
  assert.match(html, /action="\/artifacts\/artifact%2F1\/sharing"/);
  assert.match(html, /name="teamIds" value="team\/1" checked/);
  assert.match(html, /strongest user or team grant applies/);
  assert.match(html, /administrators always retain access/);
  assert.match(html, /&lt;b&gt;Manual&lt;\/b&gt;/);
  const korean = renderAdminAccessPage({ baseUrl: "http://localhost", user, mode: "public", locale: "ko" });
  assert.match(korean, /퍼블릭/);
  assert.match(korean, /프라이빗/);
  assert.match(korean, /네트워크 접근/);
  assert.match(korean, /name="lang" value="ko"/);
});

test("artifact sharing navigation is limited to owner and administrator", () => {
  const version = { version: 1, format: "text", metadata: {}, sizeBytes: 5, createdAt: "2026-10-13", sha256: "a".repeat(64) };
  const options = { artifact, version, content: "hello", baseUrl: "http://localhost" };
  for (const viewer of [user, { id: "owner", role: "user" }]) {
    assert.match(renderArtifactPage({ ...options, user: viewer }), /href="\/artifacts\/artifact%2F1\/sharing"/);
  }
  for (const viewer of [null, { id: "reader", role: "user" }]) {
    assert.doesNotMatch(renderArtifactPage({ ...options, user: viewer }), /href="\/artifacts\/artifact%2F1\/sharing"/);
  }
  assert.match(renderAccountPage({ baseUrl: "http://localhost", user }), /href="\/admin\/access"/);
});
