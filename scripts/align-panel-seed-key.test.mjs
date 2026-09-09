import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { alignPanelSeedKey } from './align-panel-seed-key.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'align-panel-seed-key.mjs');

test('aligns the seed key to the resolved env name with no secret fallback', () => {
  const aligned = alignPanelSeedKey({
    RESOLVED_API_KEY_ENV: 'OPENROUTER_REVIEW_FLEET_KEY',
    OPENROUTER_REVIEW_FLEET_KEY: 'fleet-secret',
    OPENROUTER_PR_REVIEW_API_KEY: 'must-not-be-used',
    REVIEW_YETI_BIFROST_API_KEY: 'bifrost-secret',
  });
  assert.deepEqual(aligned, { envName: 'OPENROUTER_REVIEW_FLEET_KEY', value: 'fleet-secret' });
});

test('fails closed when the resolved secret is missing', () => {
  assert.throws(
    () => alignPanelSeedKey({ RESOLVED_API_KEY_ENV: 'OPENROUTER_REVIEW_FLEET_KEY' }),
    /missing secret for OPENROUTER_REVIEW_FLEET_KEY/,
  );
});

test('rejects an invalid resolved env name', () => {
  assert.throws(
    () => alignPanelSeedKey({ RESOLVED_API_KEY_ENV: 'OPENROUTER_PR_REVIEW_API_KEY || OPENROUTER_REVIEW_FLEET_KEY' }),
    /canonical secret env name/,
  );
});

test('entrypoint writes a masked GitHub output without choosing a fallback secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'align-panel-seed-key-'));
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const result = spawnSync(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      RESOLVED_API_KEY_ENV: 'REVIEW_YETI_BIFROST_API_KEY',
      REVIEW_YETI_BIFROST_API_KEY: 'bifrost-only',
      BIFROST_PR_REVIEW_API_KEY: 'must-not-be-used',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::add-mask::bifrost-only/);
  const written = readFileSync(output, 'utf8');
  assert.match(written, /llm_api_key<<CT_REVIEW_SEED_KEY\nbifrost-only\nCT_REVIEW_SEED_KEY/);
  assert.match(written, /resolved_api_key_env=REVIEW_YETI_BIFROST_API_KEY/);
  assert.equal(written.includes('must-not-be-used'), false);
});
