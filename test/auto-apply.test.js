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
