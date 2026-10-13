import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminUsersPage } from '../src/lib/render.js';
const admin = { id: 'self', email: 'admin@example.com', name: 'Admin', role: 'admin', active: true };
const member = { id: 'user/1', email: '<member>@example.com', name: 'Member', role: 'user', active: true };
for (const locale of ['en', 'ko']) {
  test(`user roles have separate accessible forms with explicit save (${locale})`, () => {
    const html = renderAdminUsersPage({ baseUrl: 'http://localhost', user: admin, users: [admin,member], locale });
    const forms = [...html.matchAll(/<form class="user-role-form"[^>]*>([\s\S]*?)<\/form>/g)];
    assert.equal(forms.length,2);
    assert.match(forms[0][1], /value="admin" selected/);
    assert.match(forms[1][0], /action="\/admin\/users\/user%2F1\/role"/);
    assert.match(forms[1][1], /value="user" selected/);
    assert.match(forms[1][1], /aria-label="[^"<>]*&lt;member&gt;@example.com[^"<>]*"/);
    assert.match(forms[1][1], /<button type="submit"/);
    assert.doesNotMatch(forms[1][1], /<form/);
    if (locale === 'ko') assert.match(forms[1][1], /name="lang" value="ko"/);
    assert.match(html, locale === 'ko' ? /활성 관리자 계정이 최소 한 개/ : /At least one active administrator/);
    assert.match(html, /action="\/admin\/users\/user%2F1\/disable"/);
  });
}
test('role errors are escaped and displayed by the user list', () => {
  const html = renderAdminUsersPage({ baseUrl:'http://localhost', user:admin, roleError:'<unsafe>' });
  assert.match(html, /role="alert">&lt;unsafe&gt;/); assert.doesNotMatch(html, /<unsafe>/);
});

test('password reset requires a separate explicit action and only returned results show the secret', () => {
  const props = { baseUrl: 'http://localhost', user: admin, users: [admin, member], locale: 'ko' };
  const ordinary = renderAdminUsersPage(props);
  assert.match(ordinary, /action="\/admin\/users\/self\/reset-password"/);
  assert.match(ordinary, /action="\/admin\/users\/user%2F1\/reset-password"/);
  assert.doesNotMatch(ordinary, /Temporary&lt;secret&gt;|임시 비밀번호 생성됨/);
  const result = renderAdminUsersPage({ ...props, resetResult: { user: member, temporaryPassword: 'Temporary<secret>' } });
  assert.match(result, /<code>Temporary&lt;secret&gt;<\/code>/);
  assert.match(result, /계정: &lt;member&gt;@example.com/);
  assert.match(result, /기존 세션은 종료되었습니다/);
  assert.doesNotMatch(result, /(?:href|action)="[^"]*Temporary/);
});
