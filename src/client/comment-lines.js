// Source anchors refer to stored text lines, never to visual lines in a rendered document.
export function enhanceCommentLines(document) {
  const source = document.querySelector('[data-comment-source]');
  if (!source) return;
  const rows = [...source.querySelectorAll('[data-source-line]')];
  const inputs = [...document.querySelectorAll('[data-comment-line-input]')];

  function reveal(value, scroll = false) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > rows.length) return false;
    const selected = rows.find(row => Number(row.dataset.sourceLine) === number);
    if (!selected) return false;
    for (const row of rows) {
      const active = row === selected;
      row.classList.toggle('is-selected', active);
      row.querySelector('[data-select-source-line]')?.setAttribute('aria-pressed', String(active));
    }
    source.open = true;
    if (scroll) selected.scrollIntoView({ block: 'center' });
    return true;
  }

  for (const button of source.querySelectorAll('[data-select-source-line]')) {
    button.addEventListener('click', () => {
      const number = button.dataset.selectSourceLine;
      if (!reveal(number)) return;
      const input = inputs.find(field => !field.disabled);
      if (!input) return;
      input.value = number;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.closest('form')?.querySelector('textarea[name="body"]')?.focus();
    });
  }
  for (const input of inputs) {
    input.addEventListener('change', () => { reveal(input.value); });
  }
  for (const link of document.querySelectorAll('[data-comment-line-link]')) {
    link.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
      if (link.dataset.commentLineVersion !== source.dataset.sourceVersion) return;
      if (reveal(link.dataset.commentLineLink, true)) event.preventDefault();
    });
  }
  const match = /^#source-line-(\d+)$/.exec(document.location?.hash || '');
  if (match) reveal(match[1], true);
}

if (typeof document !== 'undefined') enhanceCommentLines(document);
