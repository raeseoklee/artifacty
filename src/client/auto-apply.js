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
