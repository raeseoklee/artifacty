// Progressive enhancement only: native disclosures and examples work without JavaScript.
export function matchesOperation(searchText, query) {
  return query.trim().toLowerCase().split(/\s+/).every((word) => searchText.toLowerCase().includes(word));
}

export function enhanceApiDocs(document, clipboard) {
  const search = document.querySelector('#api-search');
  const operations = [...document.querySelectorAll('[data-operation]')];
  if (search) {
    document.querySelector('[data-search-controls]').hidden = false;
    search.addEventListener('input', () => {
      for (const operation of operations) operation.hidden = !matchesOperation(operation.dataset.search, search.value);
      for (const group of document.querySelectorAll('[data-tag-group]')) group.hidden = ![...group.querySelectorAll('[data-operation]')].some((operation) => !operation.hidden);
      document.querySelector('[data-no-results]').hidden = operations.some((operation) => !operation.hidden);
    });
  }
  if (!clipboard?.writeText) return;
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.hidden = false;
    button.addEventListener('click', async () => {
      const status = document.querySelector('[data-copy-status]');
      try {
        await clipboard.writeText(button.parentElement.querySelector('code').textContent);
        status.textContent = document.body.dataset.copySuccess;
      } catch {
        status.textContent = document.body.dataset.copyFailure;
      }
    });
  }
}

if (typeof document !== 'undefined') enhanceApiDocs(document, navigator.clipboard);
