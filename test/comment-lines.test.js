import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceCommentLines } from '../src/client/comment-lines.js';

function fixture({ hash = '', disabled = false } = {}) {
  let focused = false;
  const input = { value: '', disabled, events: [], addEventListener(type, handler) { this[type] = handler; }, dispatchEvent(event) { this.events.push(event.type); }, closest: () => ({ querySelector: () => ({ focus() { focused = true; } }) }) };
  const rows = [1, 2, 3].map(number => {
    const button = { dataset: { selectSourceLine: String(number) }, addEventListener(type, handler) { this[type] = handler; }, setAttribute(name, value) { this[name] = value; } };
    return { dataset: { sourceLine: String(number) }, selected: false, scrolled: false, button, classList: { toggle(_name, value) { rows[number - 1].selected = value; } }, querySelector: () => button, scrollIntoView() { this.scrolled = true; } };
  });
  const source = { dataset: { sourceVersion: '2' }, open: false, querySelectorAll: selector => selector === '[data-source-line]' ? rows : rows.map(row => row.button) };
  const link = { dataset: { commentLineLink: '2', commentLineVersion: '2' }, addEventListener(type, handler) { this[type] = handler; } };
  const document = { location: { hash }, querySelector: () => source, querySelectorAll: selector => selector === '[data-comment-line-input]' ? [input] : [link] };
  enhanceCommentLines(document);
  return { input, rows, source, link, focused: () => focused };
}

test('selecting a stored source line fills the comment location and focuses the composer', () => {
  const f = fixture();
  f.rows[1].button.click();
  assert.equal(f.input.value, '2');
  assert.deepEqual(f.input.events, ['input', 'change']);
  assert.equal(f.focused(), true);
  assert.equal(f.rows[1].selected, true);
  assert.equal(f.rows[1].button['aria-pressed'], 'true');
  f.rows[2].button.click();
  assert.equal(f.rows[1].selected, false);
  assert.equal(f.rows[2].selected, true);
});

test('comment links reveal the exact source location without changing a draft', () => {
  const f = fixture();
  let prevented = false;
  f.link.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.source.open, true);
  assert.equal(f.rows[1].scrolled, true);
  assert.equal(f.input.value, '');
});

test('valid source hashes open the panel while invalid line inputs do nothing', () => {
  const f = fixture({ hash: '#source-line-3' });
  assert.equal(f.rows[2].scrolled, true);
  for (const value of ['', '0', '-1', '4', '1.5', 'NaN']) {
    f.input.value = value;
    f.input.change();
    assert.equal(f.rows[2].selected, true);
  }
});

test('disabled composers and pages without numbered source remain unchanged', () => {
  const f = fixture({ disabled: true });
  f.rows[0].button.click();
  assert.equal(f.input.value, '');
  assert.equal(f.focused(), false);
  assert.doesNotThrow(() => enhanceCommentLines({ querySelector: () => null }));
});


test('historical comment links navigate to their own version without highlighting the current source', () => {
  const f = fixture();
  f.link.dataset.commentLineVersion = '1';
  let prevented = false;
  f.link.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(f.source.open, false);
  assert.equal(f.rows.some(row => row.selected || row.scrolled), false);
});
