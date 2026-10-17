import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('retired execution fallback contract', () => {
  it('keeps the parallel-dispatch fallback out of the Worker source, config and deploy workflow', () => {
    const files = [
      ...walk(path.join(root, 'cf-orchestrator/src')),
      path.join(root, 'cf-orchestrator/wrangler.toml'),
      path.join(root, '.github/workflows/cf-orchestrator-ci.yaml'),
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, path.relative(root, file)).not.toMatch(/DOKS_FALLBACK_URL|PARALLEL_MODE/u);
    }
  });

  it('does not default the operator workspace to a cloud-specific storage class', () => {
    const operatorGo = walk(path.join(root, 'k8s-operator')).filter((file) => file.endsWith('.go') && !file.endsWith('_test.go'));
    for (const file of operatorGo) {
      expect(fs.readFileSync(file, 'utf8'), path.relative(root, file)).not.toContain('do-block-storage');
    }
  });
});
