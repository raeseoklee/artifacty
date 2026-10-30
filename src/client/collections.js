const form = document.querySelector('[data-collection-editor]');
if (form) {
  const hidden = form.querySelector('[name="content"]');
  const model = JSON.parse(hidden.value);
  const labels = JSON.parse(form.dataset.collectionLabels);
  const candidates = JSON.parse(form.querySelector('[data-collection-candidates]').textContent);
  const container = form.querySelector('[data-collection-sections]');
  const description = form.querySelector('[data-collection-description]');
  const button = (label, action) => {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'btn btn-outline-secondary'; el.textContent = label; el.addEventListener('click', action); return el;
  };
  const field = (label, value, change, type = 'text') => {
    const wrap = document.createElement('label'); wrap.className = 'field';
    const title = document.createElement('span'); title.textContent = label;
    const input = document.createElement('input'); input.type = type; input.value = value; input.className = 'form-control'; input.required = true;
    input.addEventListener('input', () => change(input.value)); wrap.append(title, input); return wrap;
  };
  const select = (label, choices, value, change) => {
    const wrap = document.createElement('label'); wrap.className = 'field';
    const title = document.createElement('span'); title.textContent = label;
    const input = document.createElement('select'); input.className = 'form-select';
    for (const [id, name] of choices) { const option = document.createElement('option'); option.value = id; option.textContent = name; input.append(option); }
    input.value = value; input.addEventListener('change', () => change(input.value)); wrap.append(title, input); return wrap;
  };
  const move = (array, index, delta) => { const to = index + delta; if (to < 0 || to >= array.length) return; [array[index], array[to]] = [array[to], array[index]]; render(); };
  function render() {
    container.replaceChildren();
    for (const [index, section] of model.sections.entries()) {
      const card = document.createElement('section'); card.className = 'collection-editor-section meta-card';
      card.append(field(labels.sectionTitle, section.title, value => { section.title = value; }));
      const actions = document.createElement('div'); actions.className = 'collection-actions';
      actions.append(button(labels.up, () => move(model.sections, index, -1)), button(labels.down, () => move(model.sections, index, 1)), button(labels.removeSection, () => { model.sections.splice(index, 1); render(); })); card.append(actions);
      for (const [itemIndex, item] of section.items.entries()) {
        const row = document.createElement('div'); row.className = 'collection-editor-item';
        const choices = candidates.map(a => [a.id, a.title]);
        if (!choices.some(([id]) => id === item.artifactId)) choices.unshift([item.artifactId, item.artifactId || labels.chooseArtifact]);
        row.append(select(labels.artifact, choices, item.artifactId, value => { item.artifactId = value; render(); }), field(labels.artifactId, item.artifactId, value => { item.artifactId = value.trim(); }), field(labels.version, item.version, value => { item.version = value === 'latest' ? value : Number(value); }), select(labels.display, [['card', labels.card], ['inline', labels.inline]], item.display, value => { item.display = value; }));
        const controls = document.createElement('div'); controls.className = 'collection-actions';
        controls.append(button(labels.up, () => move(section.items, itemIndex, -1)), button(labels.down, () => move(section.items, itemIndex, 1)), button(labels.remove, () => { section.items.splice(itemIndex, 1); render(); })); row.append(controls); card.append(row);
      }
      card.append(button(labels.addArtifact, () => { section.items.push({ artifactId: candidates[0]?.id || '', version: 'latest', display: 'card' }); render(); })); container.append(card);
    }
  }
  form.querySelector('[data-add-section]').addEventListener('click', () => { model.sections.push({ id: `section-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, title: labels.sectionTitle, items: [] }); render(); });
  form.addEventListener('submit', () => { model.description = description.value; hidden.value = JSON.stringify(model); });
  render();
}
const links = document.querySelectorAll('[data-collection-toc] a');
if (links.length) {
  const sections = [...links].map(link => document.getElementById(link.hash.slice(1))).filter(Boolean);
  let queued = false;
  const updateCurrentSection = () => {
    queued = false;
    let active = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= window.innerHeight * 0.25) active = section;
    }
    for (const link of links) {
      if (active && link.hash === `#${active.id}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };
  const schedule = () => {
    if (!queued) { queued = true; requestAnimationFrame(updateCurrentSection); }
  };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  updateCurrentSection();
}
