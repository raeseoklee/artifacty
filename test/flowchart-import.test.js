import test from 'node:test';
import assert from 'node:assert/strict';
import { importMermaidFlowchart } from '../src/lib/flowchart-import.js';

test('imports explicit branches, chained edges and cycles with source references', () => {
  const result = importMermaidFlowchart('flowchart LR\nA[Request] --> B{Ready?}\nB -->|yes| C((Done))\nB -->|no| A');
  assert.equal(result.blocks[0].diagram.start, 'node-1');
  assert.equal(result.blocks[0].connections.length, 3);
  assert.deepEqual(result.blocks[0].items.map(x => x.label), ['Request', 'Ready?', 'Done']);
  assert.equal(result.blocks[0].items[2].citation, 'Mermaid source line 3');
  assert.equal(importMermaidFlowchart('graph TD;A[One; part] --> B[Two] --> C[Three]').blocks[0].diagram.direction, 'TB');
});

test('retains literal labels without executing or interpreting markup', () => {
  const result = importMermaidFlowchart('graph TB\nA["<img src=x onerror=alert(1)>"] --> B[Plain]');
  assert.equal(result.blocks[0].items[0].explanation, '<img src=x onerror=alert(1)>');
});

test('rejects unsupported or ambiguous Mermaid instead of guessing', () => {
  for (const source of ['sequenceDiagram\nA->>B:Hello', 'flowchart LR\nsubgraph Group\nA --> B\nend', 'flowchart LR\nA --> B\nclick A "https://example.test"', 'flowchart LR\nA --> B\nA --> B', 'flowchart LR\nA --> A', 'flowchart LR\nA[One] --> B\nA[Changed]', 'flowchart LR\nA --- B', 'flowchart LR\nA[Unclosed', 'flowchart LR\nA -->', 'flowchart LR\nA & B --> C', 'flowchart LR\nA["broken]', 'flowchart LR\n' + 'x'.repeat(50001)]) assert.throws(() => importMermaidFlowchart(source), { code: 'UNSUPPORTED_FLOWCHART_SOURCE' });
});

test('bounds imported graph size and keeps forward node declarations', () => {
  const result = importMermaidFlowchart('graph TB\nA --> B\nB[Final label]');
  assert.equal(result.blocks[0].items[1].label, 'Final label');
  assert.equal(result.blocks[0].items[1].citation, 'Mermaid source line 3');
  assert.throws(() => importMermaidFlowchart('graph TB\n' + Array.from({ length: 41 }, (_, i) => `N${i}[Node ${i}]`).join('\n')), { code: 'UNSUPPORTED_FLOWCHART_SOURCE' });
});
