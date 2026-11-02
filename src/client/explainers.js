// Enhance server-rendered text. Nothing in an explainer can supply executable code.
for (const block of document.querySelectorAll('[data-explainer-block]')) {
  const type = block.dataset.explainerBlock;
  const items = [...block.querySelectorAll('[data-explainer-item]')];
  const choices = [...block.querySelectorAll('[data-explainer-select]')];
  const range = block.querySelector('[data-explainer-range]');
  const frame = block.querySelector('[data-explainer-flow]');
  const links = [...block.querySelectorAll('[data-explainer-edge]')].map(edge => ({from:Number(edge.dataset.from),to:Number(edge.dataset.to),label:edge.querySelector('small')?.textContent || ''}));
  const start = Number(block.dataset.flowStart || 0);
  let history = [start];
  let current = start;
  if (!items.length) continue;
  const show = (index, announce = true) => {
    if (frame && index !== current) {
      if (links.some(edge => edge.from === current && edge.to === index)) history.push(index);
      else history = [index];
      if (history.length > 200) history = history.slice(-200);
    }
    current = Math.max(0, Math.min(items.length - 1, index));
    items.forEach((item, itemIndex) => {
      item.hidden = type !== 'compare' && itemIndex !== current;
      item.classList.toggle('is-selected', itemIndex === current);
    });
    const related = new Set();
    block.querySelectorAll('[data-explainer-edge]').forEach(edge => {
      const from = Number(edge.dataset.from); const to = Number(edge.dataset.to);
      const incident = from === current || to === current;
      edge.classList.toggle('is-connected', incident);
      if (incident) { related.add(from); related.add(to); }
    });
    choices.forEach((choice, choiceIndex) => {
      choice.setAttribute('aria-pressed', String(choiceIndex === current));
      choice.classList.toggle('is-related', choiceIndex !== current && related.has(choiceIndex));
    });
    const title = items[current].querySelector('h4').textContent;
    const progress = block.querySelector('[data-explainer-progress]');
    if (progress) progress.textContent = `${current + 1} / ${items.length}`;
    const previous = block.querySelector('[data-explainer-prev]');
    const next = block.querySelector('[data-explainer-next]');
    if (previous) previous.disabled = current === 0;
    if (next) next.disabled = current === items.length - 1;
    if (range) {
      range.value = current;
      range.setAttribute('aria-valuetext', title);
      block.querySelector('[data-explainer-value]').textContent = title;
    }
    if (frame) {
      const path = history.slice(1).map((to,i) => links.findIndex(edge => edge.from === history[i] && edge.to === to));
      frame.contentWindow?.postMessage({artifactyFlow:'state',current,path,dark:document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)}, '*');
      const branches = block.querySelector('[data-flow-branches]'); branches.replaceChildren();
      for (const edge of links.filter(edge => edge.from === current)) {
        const button=document.createElement('button');button.type='button';button.className='btn btn-outline-secondary';button.textContent=(edge.label ? edge.label+' → ' : '')+items[edge.to].querySelector('h4').textContent;button.addEventListener('click',()=>show(edge.to));branches.append(button);
      }
      block.querySelector('[data-flow-back]').disabled=history.length<2;
      block.querySelector('[data-flow-summary]').textContent=history.map(index=>items[index].querySelector('h4').textContent).join(' → ');
    }
    if (announce) block.querySelector('[data-explainer-status]').textContent = title;
  };
  if (frame) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>show(current,false));
    new MutationObserver(()=>show(current,false)).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    window.addEventListener('message', event => {
      if(event.source!==frame.contentWindow || !event.data || typeof event.data!=='object') return;
      const message=event.data;
      if(message.artifactyFlow==='select' && Number.isInteger(message.index) && message.index>=0 && message.index<items.length) show(message.index);
      if(message.artifactyFlow==='ready') show(current,false);
      if(message.artifactyFlow==='height' && Number.isFinite(message.height)) frame.style.height=Math.min(1200,Math.max(180,message.height))+'px';
    });
    block.querySelector('[data-flow-back]').addEventListener('click',()=>{if(history.length>1){history.pop();current=history.at(-1);show(current)}});
    block.querySelector('[data-flow-reset]').addEventListener('click',()=>{history=[];current=start;history.push(start);show(start)});
  }
  choices.forEach((choice, index) => {
    choice.addEventListener('click', () => show(index));
    choice.addEventListener('keydown', event => {
      const target = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
      if (target === null) return;
      event.preventDefault();
      show(target); choices[current].focus();
    });
  });
  block.querySelector('[data-explainer-prev]')?.addEventListener('click', () => show(current - 1));
  block.querySelector('[data-explainer-next]')?.addEventListener('click', () => show(current + 1));
  range?.addEventListener('input', () => show(Number(range.value)));
  block.querySelectorAll('[data-explainer-controls]').forEach(control => { control.hidden = false; });
  block.classList.add('is-enhanced');
  show(start, false);
}

for (const form of document.querySelectorAll('[data-explainer-editor]')) {
  const content = form.querySelector('[name="content"]');
  let model;
  try { model = JSON.parse(content.value); } catch { continue; }
  if (!Array.isArray(model.blocks)) continue;
  const labels = JSON.parse(form.dataset.explainerLabels);
  const container = form.querySelector('[data-explainer-editor-fields]');
  const sync = () => { content.value = JSON.stringify(model); };
  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const button = (label, handler) => {
    const el = element('button', 'btn btn-outline-secondary', label);
    el.type = 'button'; el.addEventListener('click', handler); return el;
  };
  const field = (label, value, change, { multiline = false, required = false, numeric = false, maxLength = 10000 } = {}) => {
    const wrap = element('label', 'field'); wrap.append(element('span', '', label));
    const input = element(multiline ? 'textarea' : 'input', 'form-control');
    if (multiline) input.rows = 3;
    else input.type = numeric ? 'number' : 'text';
    if (numeric) input.step = 'any';
    else input.maxLength = maxLength;
    input.value = value ?? ''; input.required = required;
    input.addEventListener('input', () => { change(numeric ? Number(input.value) : input.value); sync(); });
    wrap.append(input); return wrap;
  };
  const select = (label, choices, value, change) => {
    const wrap = element('label', 'field'); wrap.append(element('span', '', label));
    const input = element('select', 'form-select');
    for (const [key, name] of choices) { const option = element('option', '', name); option.value = key; input.append(option); }
    input.value = value; input.addEventListener('change', () => { change(input.value); sync(); }); wrap.append(input); return wrap;
  };
  let nextId = 0;
  const id = prefix => `${prefix}-${Date.now().toString(36)}-${++nextId}`;
  const move = (array, index, delta) => {
    const destination = index + delta;
    if (destination < 0 || destination >= array.length) return;
    [array[index], array[destination]] = [array[destination], array[index]]; render();
  };
  const actions = (array, index, remove) => {
    const row = element('div', 'explainer-editor-actions');
    const up = button(labels.up, () => move(array, index, -1)); up.disabled = index === 0;
    const down = button(labels.down, () => move(array, index, 1)); down.disabled = index === array.length - 1;
    row.append(up, down, button(labels.remove, remove)); return row;
  };
  function render() {
    container.replaceChildren();
    container.append(field(labels.goal, model.goal, value => { model.goal = value; }, { required: true, maxLength: 500 }),
      field(labels.summary, model.summary, value => { model.summary = value; }, { multiline: true, maxLength: 5000 }),
      field(labels.limitations, model.limitations.join('\n'), value => { model.limitations = value.split('\n').map(line => line.trim()).filter(Boolean); }, { multiline: true }));
    for (const [blockIndex, block] of model.blocks.entries()) {
      const card = element('section', 'explainer-editor-block');
      card.append(element('h2', '', `${labels.block} ${blockIndex + 1}`));
      const header = element('div', 'explainer-editor-grid');
      header.append(field(labels.blockTitle, block.title, value => { block.title = value; }, { required: true, maxLength: 200 }),
        select(labels.mode, ['steps', 'compare', 'diagram', 'scenarios'].map(type => [type, labels[type]]), block.type, value => {
          block.type = value;
          if (value === 'scenarios') {
            block.parameter ||= { label: labels.parameter, unit: '' };
            if (block.items.length < 2) block.items.push({ id: id('item'), label: '', explanation: '', basis: 'assumption' });
            block.items.forEach((item, index) => { item.value = index; });
          } else { delete block.parameter; block.items.forEach(item => { delete item.value; }); }
          if (value === 'diagram') block.connections ||= [];
          else { delete block.connections; delete block.diagram; }
          render();
        }));
      card.append(header, actions(model.blocks, blockIndex, () => { model.blocks.splice(blockIndex, 1); render(); }));
      if (block.type === 'scenarios') {
        const parameter = element('div', 'explainer-editor-grid');
        parameter.append(field(labels.parameter, block.parameter.label, value => { block.parameter.label = value; }, { required: true, maxLength: 200 }), field(labels.unit, block.parameter.unit, value => { block.parameter.unit = value; }, { maxLength: 40 })); card.append(parameter);
      }
      for (const [itemIndex, item] of block.items.entries()) {
        const row = element('section', 'explainer-editor-item');
        row.append(element('h3', '', `${labels.item} ${itemIndex + 1}`));
        row.append(field(labels.label, item.label, value => { item.label = value; }, { required: true, maxLength: 200 }), field(labels.explanation, item.explanation, value => { item.explanation = value; }, { multiline: true, required: true }));
        const evidence = element('div', 'explainer-editor-grid');
        evidence.append(select(labels.basis, ['source', 'interpretation', 'assumption'].map(basis => [basis, labels[basis]]), item.basis, value => { item.basis = value; render(); }), field(labels.reference, item.citation, value => { if (value.trim()) item.citation = value; else delete item.citation; }, { maxLength: 1000, required: item.basis === 'source' }));
        if (block.type === 'scenarios') evidence.append(field(labels.value, item.value, value => { item.value = value; }, { required: true, numeric: true }));
        row.append(evidence, actions(block.items, itemIndex, () => {
          block.items.splice(itemIndex, 1);
          if (block.diagram?.start === item.id) block.diagram.start = block.items[0]?.id;
          if (block.connections) block.connections = block.connections.filter(edge => edge.from !== item.id && edge.to !== item.id);
          render();
        })); card.append(row);
      }
      card.append(button(labels.addItem, () => {
        const item = { id: id('item'), label: '', explanation: '', basis: 'interpretation' };
        if (block.type === 'scenarios') item.value = (block.items.at(-1)?.value ?? -1) + 1;
        block.items.push(item); render();
      }));
      if (block.type === 'diagram') {
        const flow = element('div', 'explainer-editor-grid');
        flow.append(select(labels.flowView, [['text',labels.flowText],['flow',labels.flowChart]], block.diagram ? 'flow':'text', value=>{if(value==='flow')block.diagram={direction:'LR',start:block.items[0]?.id};else delete block.diagram;render()}));
        if(block.diagram){flow.append(select(labels.flowDirection,[['LR',labels.flowHorizontal],['TB',labels.flowVertical]],block.diagram.direction,value=>{block.diagram.direction=value}),select(labels.flowStart,block.items.map(item=>[item.id,item.label||labels.item]),block.diagram.start,value=>{block.diagram.start=value}));}
        card.append(flow);
        const connections = element('section', 'explainer-editor-connections'); connections.append(element('h3', '', labels.connections));
        const choices = block.items.map(item => [item.id, item.label || labels.item]);
        for (const [edgeIndex, edge] of (block.connections || []).entries()) {
          const row = element('div', 'explainer-editor-grid');
          row.append(select(labels.from, choices, edge.from, value => { edge.from = value; }), select(labels.to, choices, edge.to, value => { edge.to = value; }), field(labels.label, edge.label, value => { edge.label = value; }, { maxLength: 200 }), button(labels.remove, () => { block.connections.splice(edgeIndex, 1); render(); })); connections.append(row);
        }
        const add = button(labels.addConnection, () => { block.connections.push({ from: block.items[0].id, to: block.items[1].id, label: '' }); render(); });
        add.disabled = block.items.length < 2; connections.append(add); card.append(connections);
      }
      container.append(card);
    }
    container.append(button(labels.addBlock, () => { model.blocks.push({ id: id('block'), type: 'steps', title: '', items: [{ id: id('item'), label: '', explanation: '', basis: 'interpretation' }] }); render(); }));
    sync();
  }
  // A rejected JSON submission may be malformed. Keep it editable as text
  // unless the progressive form can be initialized successfully.
  try { render(); } catch { container.replaceChildren(); continue; }
  form.querySelector('[data-explainer-json]').hidden = true;
  content.required = false;
  const error = element('p', 'conflict-banner'); error.hidden = true; error.setAttribute('role', 'alert'); error.tabIndex = -1;
  form.insertBefore(error, container);
  form.addEventListener('submit', event => {
    sync();
    let problem = '';
    if (model.blocks.length < 1 || model.blocks.length > 20 || model.blocks.some(block => block.items.length < (block.type === 'scenarios' ? 2 : 1) || block.items.length > 40) || model.blocks.reduce((total, block) => total + block.items.length, 0) > 200) problem = labels.invalidCounts;
    else if (model.limitations.length > 20 || model.limitations.some(line => line.length > 1000)) problem = labels.invalidLimitations;
    for (const block of model.blocks) {
      if (problem) break;
      if (block.items.some(item => item.basis === 'source' && !item.citation?.trim())) { problem = labels.missingCitation; break; }
      if (block.type === 'scenarios' && block.items.some((item, index) => !Number.isFinite(item.value) || (index > 0 && item.value <= block.items[index - 1].value))) { problem = labels.scenarioOrder; break; }
      const edges = new Set();
      for (const edge of block.connections || []) {
        const key = `${edge.from}:${edge.to}`;
        if (edge.from === edge.to || edges.has(key) || !block.items.some(item => item.id === edge.from) || !block.items.some(item => item.id === edge.to)) { problem = labels.invalidConnections; break; }
        edges.add(key);
      }
    }
    error.hidden = !problem;
    if (problem) { event.preventDefault(); error.textContent = problem; error.focus(); }
  });
}
