import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminEmailPage, renderAdminUsersPage, renderDashboard } from '../src/lib/render.js';
import { createI18n } from '../src/lib/i18n.js';
const user = { id:'admin', role:'admin', email:'admin@example.com' };
const settings = { enabled:true,host:'smtp.example.com',port:587,tlsMode:'starttls',username:'<account>',from:'sender@example.com',hasPassword:true,password:'DO-NOT-RENDER' };
for (const locale of ['en','ko']) {
  test(`SMTP settings preserve fields without exposing saved secrets (${locale})`, () => {
    const html = renderAdminEmailPage({ user, settings, baseUrl:'http://localhost',locale,error:'raw SMTP response DO-NOT-RENDER' });
    assert.match(html,/action="\/admin\/email"/);
    assert.match(html,/name="password" type="password" value="" autocomplete="new-password"/);
    assert.match(html,/value="starttls" selected/);
    assert.match(html,/value="&lt;account&gt;"/);
    assert.doesNotMatch(html,/DO-NOT-RENDER|value="none"|rejectUnauthorized/);
    for (const name of ['enabled','host','port','tlsMode','username','from','password']) assert.match(html,new RegExp(`name="${name}"`));
    assert.match(html,locale==='ko'?/비워 두면 저장된 비밀번호 유지/:/Leave blank to keep the saved password/);
  });
}
test('reset statuses distinguish SMTP acceptance, uncertainty, and no configuration', () => {
  for (const [mailStatus, expected] of [['sent',/SMTP server accepted/],['failed',/delivery could not be confirmed/],['not-configured',/Email is not configured/]]) {
    const html=renderAdminUsersPage({user,baseUrl:'http://localhost',resetResult:{user,temporaryPassword:'Temporary<secret>',mailStatus}});
    assert.match(html,expected);assert.match(html,/Temporary&lt;secret&gt;/);
  }
});
test('SMTP navigation stays administrator-only and reset email is plaintext localized content', () => {
  for (const role of ['user','admin']) {
    const html=renderDashboard({artifacts:[],baseUrl:'http://localhost',user:{role}});
    assert.equal(html.includes('href="/admin/email"'),role==='admin');
  }
  const body=createI18n('ko').t('smtp.resetBody',{email:'user@example.com',password:'temporary'});
  assert.equal(body,'계정: user@example.com\n임시 비밀번호: temporary\nArtifacty에 로그인한 뒤 비밀번호를 변경하세요.');
});
