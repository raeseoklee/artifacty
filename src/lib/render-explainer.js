import { parseExplainer } from './explainers.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// Content is text, never executable markup. Interactivity belongs to our local client.
export function renderExplainer(content, view) {
  const model = parseExplainer(content);
  const text = key => view.text(`explainer.${key}`);
  const itemContent = item => `<p class="explainer-evidence"><span class="explainer-basis" data-basis="${escape(item.basis)}">${text(item.basis)}</span>${item.citation ? `<span>${text('reference')}: ${escape(item.citation)}</span>` : ''}</p><p class="explainer-prose">${escape(item.explanation)}</p>`;
  return `<article class="explainer" data-explainer>
    <header class="explainer-intro"><span class="explainer-eyebrow">${text('title')}</span><h2>${escape(model.goal)}</h2>${model.summary ? `<p class="explainer-prose">${escape(model.summary)}</p>` : ''}</header>
    ${model.blocks.map(block => {
      const type = block.type;
      const controls = type === 'scenarios'
        ? `<label class="explainer-slider-label">${escape(block.parameter.label)}${block.parameter.unit ? ` (${escape(block.parameter.unit)})` : ''}<input type="range" min="0" max="${block.items.length - 1}" step="1" value="0" data-explainer-range><output data-explainer-value></output></label><p class="muted">${text('sampleHelp')}</p>`
        : `<div class="explainer-choices" role="group" aria-label="${escape(block.title)}">${block.items.map((item, index) => `<button type="button" class="explainer-choice" data-explainer-select="${index}" aria-pressed="false">${type === 'steps' ? `<span class="explainer-number">${index + 1}</span>` : ''}${escape(item.label)}</button>`).join('')}</div>`;
      const edges = type === 'diagram' && block.connections?.length
        ? `<div class="explainer-connections"><span class="explainer-eyebrow">${text('connections')}</span><ul>${block.connections.map(edge => `<li data-explainer-edge data-from="${block.items.findIndex(item => item.id === edge.from)}" data-to="${block.items.findIndex(item => item.id === edge.to)}"><span>${escape(block.items.find(item => item.id === edge.from)?.label)}</span><span aria-hidden="true"> → </span><span>${escape(block.items.find(item => item.id === edge.to)?.label)}</span>${edge.label ? `<small>${escape(edge.label)}</small>` : ''}</li>`).join('')}</ul></div>` : '';
      return `<section class="explainer-block" data-explainer-block="${type}"${block.diagram ? ` data-flow-start="${block.items.findIndex(item => item.id === block.diagram.start)}"` : ''}><header class="explainer-block-heading"><span class="explainer-mode">${text(type)}</span><h3>${escape(block.title)}</h3></header>
        <div data-explainer-controls hidden>${controls}</div>
        ${block.diagram ? `<iframe class="explainer-flow-frame" title="${escape(block.title)}" sandbox="allow-scripts" data-explainer-flow srcdoc="${escape(flowFrame(block))}"></iframe><div class="explainer-flow-navigation" data-explainer-controls hidden><button type="button" class="btn btn-outline-secondary" data-flow-back>${text('previous')}</button><button type="button" class="btn btn-outline-secondary" data-flow-reset>${text('flowReset')}</button><span>${text('flowNext')}</span><div data-flow-branches></div><p data-flow-summary aria-live="polite"></p></div>` : ''}
        ${edges}
        <div class="explainer-items">${block.items.map((item, index) => `<section class="explainer-item" data-explainer-item="${index}"${item.value !== undefined ? ` data-value="${escape(item.value)}"` : ''}><h4>${escape(item.label)}${type === 'scenarios' ? ` <span class="muted">${escape(item.value)} ${escape(block.parameter.unit || '')}</span>` : ''}</h4>${itemContent(item)}</section>`).join('')}</div>
        ${type === 'steps' ? `<div class="explainer-step-nav" data-explainer-controls hidden><button type="button" class="btn btn-outline-secondary" data-explainer-prev>${text('previous')}</button><span data-explainer-progress aria-live="polite" aria-atomic="true"></span><button type="button" class="btn btn-outline-secondary" data-explainer-next>${text('next')}</button></div>` : ''}
        <p class="explainer-status dashboard-sr-only" data-explainer-status aria-live="polite" aria-atomic="true"></p>
      </section>`;
    }).join('')}
    <footer class="explainer-notes"><h3>${text('readingNote')}</h3><p>${text('evidenceHelp')}</p>${model.limitations.length ? `<h4>${text('limitationsHeading')}</h4><ul>${model.limitations.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}</footer>
  </article>`;
}

function flowFrame(block) {
  const data = JSON.stringify({ nodes: block.items.map(item => item.label), edges: block.connections.map(edge => ({ from: block.items.findIndex(item => item.id === edge.from), to: block.items.findIndex(item => item.id === edge.to), label: edge.label || '' })), direction: block.diagram.direction }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:system-ui;background:#fff;color:#172b3a}svg{max-width:100%;height:auto;display:block;margin:auto}.node{cursor:pointer}.node:focus{outline:3px solid #2563eb}.node.current rect,.node.current polygon{stroke:#2563eb!important;stroke-width:4px!important;fill:#dbeafe!important}.edgePath.visited path,.flowchart-link.visited{stroke:#2563eb!important;stroke-width:4px!important}body.dark{background:#1d2127;color:#e2e8f0}body.dark .node rect,body.dark .node polygon{fill:#293345!important;stroke:#94a3b8!important}body.dark svg text{fill:#e2e8f0!important}body.dark .edgeLabel rect{fill:#293345!important}body.dark .node.current rect,body.dark .node.current polygon{fill:#253f68!important;stroke:#93b4f4!important}@keyframes flow-travel{to{stroke-dashoffset:-28}}.flowchart-link.visited{stroke-dasharray:9 5;animation:flow-travel 1s linear infinite}@media(prefers-reduced-motion:reduce){.flowchart-link.visited{animation:none;stroke-dasharray:none}}#error{white-space:pre-wrap}</style></head><body><div id="graph"></div><p id="error" role="status"></p><script type="module">
import mermaid from '/vendor/npm/mermaid/dist/mermaid.esm.min.mjs';
const data=${data};
const encode=text=>Array.from(text).map(char=>'#'+char.codePointAt(0)+';').join('');
const encodeEdge=text=>Array.from(text).map(char=>/^[\\p{L}\\p{N} .,?!:_-]$/u.test(char)?char:'#'+char.codePointAt(0)+';').join('');
const source='flowchart '+data.direction+'\\n'+data.nodes.map((label,i)=>'n'+i+'["'+encode(label)+'"]').join('\\n')+'\\n'+data.edges.map(edge=>'n'+edge.from+(edge.label?' -->|"'+encodeEdge(edge.label)+'"| n':' --> n')+edge.to).join('\\n');
let nodes=[];let edges=[];
function select(index){parent.postMessage({artifactyFlow:'select',index},'*')}
try{
mermaid.initialize({startOnLoad:false,securityLevel:'strict',flowchart:{htmlLabels:false},theme:'default'});
const result=await mermaid.render('explainer-flow',source);document.getElementById('graph').innerHTML=result.svg;
// Mermaid decodes node entities but can retain numeric entities in edge text.
// Decode text nodes only: never reinterpret authored labels as markup.

const walker=document.createTreeWalker(document.getElementById('graph'),NodeFilter.SHOW_TEXT);let textNode;while((textNode=walker.nextNode()))textNode.textContent=textNode.textContent.replace(/&#([0-9]+);/g,(_,code)=>{const point=Number(code);return point>0&&point<=1114111?String.fromCodePoint(point):''});
nodes=[...document.querySelectorAll('g.node')];edges=[...document.querySelectorAll('.flowchart-link')];
nodes.forEach(node=>{const match=/flowchart-n([0-9]+)-/.exec(node.id);if(!match)return;const index=Number(match[1]);node.dataset.index=index;node.setAttribute('tabindex','0');node.setAttribute('role','button');node.setAttribute('aria-label',data.nodes[index]);node.addEventListener('click',()=>select(index));node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(index)}})});
parent.postMessage({artifactyFlow:'ready'},'*');
}catch{document.querySelectorAll('body > div:not(#graph)').forEach(node=>node.remove());document.getElementById('graph').replaceChildren();document.getElementById('error').textContent='Diagram unavailable. Use the accessible node and path controls below.';parent.postMessage({artifactyFlow:'error'},'*')}
window.addEventListener('message',event=>{if(event.source!==parent||event.data?.artifactyFlow!=='state'||!Number.isInteger(event.data.current)||!Array.isArray(event.data.path)||event.data.path.length>200)return;document.body.classList.toggle('dark',event.data.dark===true);document.querySelectorAll('svg text,svg tspan,.nodeLabel,.edgeLabel').forEach(label=>{label.style.setProperty('fill',event.data.dark?'#f1f5f9':'#172b3a','important');label.style.setProperty('color',event.data.dark?'#f1f5f9':'#172b3a','important')});document.querySelectorAll('marker path').forEach(marker=>{marker.style.setProperty('fill',event.data.dark?'#cbd5e1':'#475569','important');marker.style.setProperty('stroke',event.data.dark?'#cbd5e1':'#475569','important')});nodes.forEach(node=>{const active=Number(node.dataset.index)===event.data.current;node.classList.toggle('current',active);node.querySelectorAll('rect,polygon,circle,ellipse,path').forEach(shape=>{shape.style.setProperty('stroke',active?'#2563eb':'#94a3b8','important');shape.style.setProperty('stroke-width',active?'4px':'1px','important');if(active)shape.style.setProperty('fill',event.data.dark?'#253f68':'#dbeafe','important');else shape.style.removeProperty('fill')});node.setAttribute('aria-pressed',String(active))});edges.forEach((edge,index)=>{const active=event.data.path.includes(index);edge.classList.toggle('visited',active);edge.style.setProperty('stroke-dasharray',active?'9 5':'none','important');edge.style.setProperty('animation',active&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'flow-travel 1s linear infinite':'none','important');edge.style.setProperty('stroke',active?'#2563eb':'#94a3b8','important');edge.style.setProperty('stroke-width',active?'4px':'2px','important')})});
new ResizeObserver(()=>parent.postMessage({artifactyFlow:'height',height:Math.min(1200,Math.max(180,document.documentElement.scrollHeight))},'*')).observe(document.body);
</script></body></html>`;
}
