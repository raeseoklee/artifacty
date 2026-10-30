import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('CLI publish and update retain separate authoring tool and model history', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'artifacty-cli-provenance-'));
  const run = args => JSON.parse(execFileSync(process.execPath, ['src/cli.js', ...args, '--home', home], { encoding: 'utf8', env: { ...process.env, ARTIFACTY_EMBEDDINGS_PROVIDER: 'disabled' } }));
  try {
    const created = run(['publish','--title','CLI attribution','--content','First','--tool','claude-code','--provider','Anthropic','--model','example-first']);
    assert.equal(created.createdBy.tool, 'claude-code');
    const updated = run(['update',created.id,'--content','Second','--tool','codex','--provider','OpenAI','--model','example-second']);
    assert.equal(updated.createdBy.model, 'example-first');
    assert.equal(updated.version.provenance.model, 'example-second');
    assert.equal(updated.version.provenance.source, 'self-reported');
    assert.equal(updated.version.provenance.userId, null);
  } finally { await rm(home,{recursive:true,force:true}); }
});
