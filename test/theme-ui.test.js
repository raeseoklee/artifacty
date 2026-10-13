import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderDashboard } from '../src/lib/render.js';
const source=readFileSync(new URL('../src/client/theme.js',import.meta.url),'utf8');
function browser(saved, blocked=false) {
  const attributes={},events={},windowEvents={},controls=[{hidden:true}];
  const media={matches:true,addEventListener(name,fn){this[name]=fn;}};
  const buttons=['system','light','dark'].map(theme=>({dataset:{themeChoice:theme},attributes:{},setAttribute(name,value){this.attributes[name]=value;},addEventListener(name,fn){this[name]=fn;}}));
  const store={value:saved,writes:[],getItem(){if(blocked)throw Error();return this.value;},setItem(key,value){if(blocked)throw Error();this.writes.push([key,value]);this.value=value;}};
  vm.runInNewContext(source,{localStorage:store,document:{documentElement:{setAttribute:(name,value)=>attributes[name]=value,removeAttribute:name=>delete attributes[name]},querySelectorAll:selector=>selector==='[data-theme-choice]'?buttons:controls,addEventListener:(name,fn)=>events[name]=fn},window:{matchMedia:()=>media,addEventListener:(name,fn)=>windowEvents[name]=fn}});
  return {attributes,events,windowEvents,controls,buttons,store,media};
}
for(const saved of [undefined,'system','light','dark','invalid']) test(`theme initializes safely for ${saved}`,()=>{
  const b=browser(saved);assert.equal(b.attributes['data-theme'],['light','dark'].includes(saved)?saved:undefined);
  assert.equal(b.controls[0].hidden,true);b.events.DOMContentLoaded();assert.equal(b.controls[0].hidden,false);
  assert.equal(b.buttons.filter(button=>button.attributes['aria-pressed']==='true').length,1);
});
test('blocked storage does not prevent current-page theme changes',()=>{
  const b=browser('dark',true);assert.equal(b.attributes['data-theme'],undefined);b.events.DOMContentLoaded();b.buttons[2].click();assert.equal(b.attributes['data-theme'],'dark');b.buttons[0].click();assert.equal(b.attributes['data-theme'],undefined);
});
test('theme choice writes only its preference and syncs across tabs',()=>{
  const b=browser();b.events.DOMContentLoaded();b.buttons[1].click();assert.deepEqual(b.store.writes,[['artifacty_theme','light']]);b.store.value='dark';b.windowEvents.storage({key:'artifacty_theme'});assert.equal(b.attributes['data-theme'],'dark');
});
test('theme controls are translated, outside language forms, hidden without JS and CSS honors explicit choices',()=>{
  const html=renderDashboard({artifacts:[],baseUrl:'http://localhost',locale:'ko'});
  assert.ok(html.indexOf('<script src="/assets/theme.js">')<html.indexOf('<style>'));
  assert.match(html,/data-theme-controls hidden/);assert.match(html,/data-theme-choice="system"[^>]*aria-label="시스템"/);
  assert.match(html,/class="ui-icon"/);
  assert.match(html,/:root\[data-theme="dark"\]/);assert.match(html,/:root:not\(\[data-theme="light"\]\)/);
  const language=html.match(/<form class="language-switcher"[^>]*>([\s\S]*?)<\/form>/)[1];assert.doesNotMatch(language,/data-theme-choice/);
});

test('Bootstrap controls follow OS changes only in system mode',()=>{const b=browser('system');assert.equal(b.attributes['data-bs-theme'],'dark');b.media.matches=false;b.media.change();assert.equal(b.attributes['data-bs-theme'],'light');b.events.DOMContentLoaded();b.buttons[2].click();b.media.change();assert.equal(b.attributes['data-bs-theme'],'dark');});
