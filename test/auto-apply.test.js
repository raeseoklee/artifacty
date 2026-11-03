import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceAutoApply } from '../src/client/auto-apply.js';
function fixture(method='get',valid=true) {
  const control={addEventListener(type,handler){this[type]=handler;}};
  const button={hidden:false};let count=0;
  const form={method,dataset:{autoApply:'all'},reportValidity:()=>valid,requestSubmit(){count++;},querySelectorAll:q=>q==='select'?[control]:[button]};
  enhanceAutoApply({querySelectorAll:()=>[form]});
  return {control,button,count:()=>count};
}
test('GET preferences apply on change and hide redundant submit buttons',()=>{const f=fixture();assert.equal(f.button.hidden,true);f.control.change();assert.equal(f.count(),1);});
test('mutation forms remain explicit and invalid forms do not navigate',()=>{const p=fixture('post');assert.equal(p.button.hidden,false);assert.equal(p.control.change,undefined);const f=fixture('get',false);f.control.change();assert.equal(f.count(),0);});

test('review dropdown saves without navigation and restores the selection on failure', async (t) => {
  const { enhanceReviewStatus } = await import('../src/client/auto-apply.js');
  t.mock.method(globalThis, 'FormData', function () { return [['status', 'approved'], ['token', 'fixture-token']]; });
  const select = { value: 'none', disabled: false, addEventListener(type, fn) { this[type] = fn; } };
  const feedback = { textContent: '' }, button = { hidden: false };
  const form = { action: '/artifacts/demo/review-status', dataset: { saving: 'saving', saved: 'saved', failed: 'failed' }, reportValidity: () => true,
    querySelector: selector => selector.startsWith('select') ? select : selector.startsWith('button') ? button : feedback,
    addEventListener(type, fn) { this[type] = fn; } };
  let fail = false;
  enhanceReviewStatus({ querySelectorAll: () => [form] }, async (url, options) => {
    assert.equal(url, form.action);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.body.get('token'), 'fixture-token');
    return { ok: !fail, json: async () => ({ ok: true }) };
  });
  assert.equal(button.hidden, true);
  select.value = 'approved'; await select.change();
  assert.equal(feedback.textContent, 'saved');
  fail = true; select.value = 'pending'; await select.change();
  assert.equal(select.value, 'approved');
  assert.equal(select.disabled, false);
  assert.equal(feedback.textContent, 'failed');
});
