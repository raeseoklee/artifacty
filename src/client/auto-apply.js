// Only opt-in GET forms auto-apply. Account and server mutations stay explicit.
export function enhanceAutoApply(document) {
  for (const form of document.querySelectorAll('form[data-auto-apply]')) {
    if (form.method.toLowerCase() !== 'get' || typeof form.requestSubmit !== 'function') continue;
    const controls = form.dataset.autoApply === 'filters'
      ? form.querySelectorAll('.dashboard-advanced select, .dashboard-advanced input, .category-filter select')
      : form.querySelectorAll('select');
    for (const control of controls) {
      control.addEventListener('change', () => {
        if (!form.reportValidity()) return;
        form.requestSubmit();
      });
    }
    const buttons = form.dataset.autoApply === 'filters'
      ? form.querySelectorAll('.dashboard-filter-actions')
      : form.querySelectorAll('button[type="submit"]');
    for (const button of buttons) button.hidden = true;
  }
}
if (typeof document !== 'undefined') enhanceAutoApply(document);

// Review status is the only opt-in mutation; save without navigating away from
// an unfinished comment. The ordinary submit remains available without JS.
export function enhanceReviewStatus(document, fetcher = globalThis.fetch) {
  for (const form of document.querySelectorAll('form[data-review-status]')) {
    const select = form.querySelector('select[name="status"]');
    const feedback = form.querySelector('[data-review-feedback]');
    const submit = form.querySelector('button[type="submit"]');
    if (!select || !feedback || !fetcher) continue;
    let saved = select.value;
    async function save(event) {
      event?.preventDefault();
      if (select.disabled || !form.reportValidity() || select.value === saved) return;
      const next = select.value;
      const body = new URLSearchParams(new FormData(form));
      select.disabled = true;
      feedback.textContent = form.dataset.saving;
      try {
        const response = await fetcher(form.action, { method: 'POST', body, credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok || (await response.json()).ok !== true) throw new Error('Save failed');
        saved = next;
        feedback.textContent = form.dataset.saved;
      } catch {
        select.value = saved;
        feedback.textContent = form.dataset.failed;
      } finally { select.disabled = false; }
    }
    select.addEventListener('change', save);
    form.addEventListener('submit', save);
    if (submit) submit.hidden = true;
  }
}
if (typeof document !== 'undefined') enhanceReviewStatus(document);
