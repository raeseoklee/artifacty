const fail = () => { throw Object.assign(new Error('This Mermaid source uses unsupported flowchart syntax. Use simple named nodes and --> connections, or author the explanation manually.'), { code: 'UNSUPPORTED_FLOWCHART_SOURCE', statusCode: 400 }); };

// Deliberately a small import grammar, not a Mermaid interpreter. Unsupported
// syntax is rejected rather than silently dropping relationships or directives.
export function importMermaidFlowchart(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 50000) fail();
  const statements = [];
  let statement = '', line = 1, startLine = 1, quote = false;
  const stack = [];
  for (const char of source) {
    if (char === '"') quote = !quote;
    if (!quote) {
      if ('[{('.includes(char)) stack.push(char);
      if (']})'.includes(char)) {
        const expected = { ']': '[', '}': '{', ')': '(' }[char];
        if (stack.pop() !== expected) fail();
      }
    }
    if (!quote && !stack.length && (char === ';' || char === '\n')) {
      if (statement.trim()) statements.push({ text: statement.trim(), line: startLine });
      statement = ''; startLine = line + (char === '\n' ? 1 : 0);
    } else statement += char;
    if (char === '\n') line++;
  }
  if (quote || stack.length) fail();
  if (statement.trim()) statements.push({ text: statement.trim(), line: startLine });
  const header = statements.shift();
  const direction = /^(?:flowchart|graph)\s+(TB|TD|LR)$/.exec(header?.text || '');
  if (!direction) fail();
  const nodes = new Map(), edges = [], edgeKeys = new Set();
  const node = (text, sourceLine) => {
    const match = /^([A-Za-z][A-Za-z0-9_]*)(?:\[([^\]\n]*)\]|\{([^}\n]*)\}|\(\(([^)\n]*)\)\))?\s*/.exec(text);
    if (!match) fail();
    const originalId = match[1];
    let label = match[2] ?? match[3] ?? match[4];
    if (label !== undefined) {
      if (label.startsWith('"') || label.endsWith('"')) {
        if (!(label.startsWith('"') && label.endsWith('"'))) fail();
        label = label.slice(1, -1);
      }
      if (!label.trim() || label.length > 200 || label.includes('"')) fail();
    }
    const existing = nodes.get(originalId);
    if (existing && label !== undefined && existing.explicit && existing.label !== label) fail();
    if (!existing) {
      if (nodes.size >= 40) fail();
      nodes.set(originalId, { id: `node-${nodes.size + 1}`, label: label ?? originalId, explicit: label !== undefined, line: sourceLine });
    } else if (label !== undefined) Object.assign(existing, { label, explicit: true, line: sourceLine });
    return { originalId, consumed: match[0].length };
  };
  for (const entry of statements) {
    if (entry.text.startsWith('%%')) continue;
    let remaining = entry.text;
    const first = node(remaining, entry.line);
    let previous = first.originalId;
    remaining = remaining.slice(first.consumed);
    while (remaining.trim()) {
      const arrow = /^\s*-->(?:\|([^|\n]{1,200})\|)?\s*/.exec(remaining);
      if (!arrow) fail();
      remaining = remaining.slice(arrow[0].length);
      const target = node(remaining, entry.line);
      const key = `${previous}:${target.originalId}`;
      if (previous === target.originalId || edgeKeys.has(key) || edges.length >= 100) fail();
      edgeKeys.add(key);
      edges.push({ from: previous, to: target.originalId, label: arrow[1] || '' });
      previous = target.originalId;
      remaining = remaining.slice(target.consumed);
    }
  }
  if (!nodes.size) fail();
  const items = [...nodes.values()].map(item => ({ id: item.id, label: item.label, explanation: item.label, basis: 'source', citation: `Mermaid source line ${item.line}` }));
  return { schemaVersion: 1, goal: 'Explore the connections in this flowchart', summary: 'Select a node and follow an authored connection to inspect the flowchart.', limitations: ['This draft imports diagram labels and connections only. Add explanations before sharing.', 'Connections describe the source diagram. They do not establish an execution order or verified behavior.'], blocks: [{ id: 'flowchart', title: 'Explore the flowchart', type: 'diagram', diagram: { direction: direction[1] === 'LR' ? 'LR' : 'TB', start: items[0].id }, items, connections: edges.map(edge => ({ from: nodes.get(edge.from).id, to: nodes.get(edge.to).id, label: edge.label })) }] };
}
