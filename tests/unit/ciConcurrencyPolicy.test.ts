import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();

/**
 * REL-570. Releases are unattended (ADR 0513), so every merge to main is followed within seconds
 * by a release-please commit. With `cancel-in-progress: true` that cancelled main's own
 * post-merge validation mid-suite, routinely.
 *
 * A cancelled required check is neither pass nor fail. It is the shape that hides a real failure,
 * and it did: a genuine red on main sat among a run of cancellations and read as more of the same.
 */
describe('CI concurrency policy (REL-570)', () => {
  const workflowPath = path.join(root, '.github/workflows/ci-cd.yaml');
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const workflow = yaml.load(raw) as any;

  it('never cancels an in-progress run on main', () => {
    const cancel = String(workflow.concurrency['cancel-in-progress']);
    expect(cancel).not.toBe('true');
    expect(cancel).toContain("github.ref != 'refs/heads/main'");
  });

  it('still cancels superseded branch runs, so this is not a blanket opt-out', () => {
    // The expression must be conditional, not simply disabled -- branch runs are the ones worth
    // cancelling and nothing depends on their history.
    const cancel = String(workflow.concurrency['cancel-in-progress']);
    expect(cancel).not.toBe('false');
    expect(cancel).toMatch(/\$\{\{.*\}\}/u);
  });

  it('keeps the release and release-please pipelines uncancellable', () => {
    for (const file of ['release.yml', 'release-please.yml']) {
      const wf = yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')) as any;
      expect(wf.concurrency['cancel-in-progress'], `${file} must not cancel`).toBe(false);
    }
  });
});
