import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Workers Logs must stay on at full sampling for the orchestrator. Without it a webhook request that
// is cancelled or dropped (for example a merge_group delivery that never publishes its check) leaves
// no request log, status, duration or subrequest count to diagnose from.
function observabilityTable(wrangler: string): string | undefined {
  const lines = wrangler.split('\n');
  const start = lines.findIndex((line) => /^\[observability\]\s*(#.*)?$/u.test(line));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\[/u.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

describe('Workers Logs (observability) for the orchestrator', () => {
  it('enables observability with head_sampling_rate = 1 so every request, including merge_group, is logged', async () => {
    const wrangler = await readFile(resolve(process.cwd(), 'wrangler.toml'), 'utf8');
    const table = observabilityTable(wrangler);
    assert.ok(table !== undefined, 'wrangler.toml must declare an [observability] table');
    assert.match(table, /^enabled\s*=\s*true\b/mu);
    assert.match(table, /^head_sampling_rate\s*=\s*1(\.0)?\s*(#.*)?$/mu);
  });
});
