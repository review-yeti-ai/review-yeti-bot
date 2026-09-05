import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const workflowPath = path.join(root, '.github/workflows/review-bot.yaml');
const raw = fs.readFileSync(workflowPath, 'utf8');

/**
 * REL-580. The required `Execute AI Review Pipeline` check used to go green whenever the pipeline
 * ran, regardless of its conclusion — the workflow only echoed the verdict. PR #490 carried a
 * FIX_FIRST verdict with a P1, passed the check, was merged on that green, and shipped a
 * types/live <-> liveStreamBus import cycle to main.
 *
 * A required check that cannot go red on its own conclusion is not a gate. These assertions keep
 * it one.
 */
describe('review verdict enforcement (REL-580)', () => {
  const workflow = yaml.load(raw) as any;
  const steps = workflow.jobs.review.steps as Array<{ name?: string; run?: string; env?: Record<string, string> }>;
  const enforce = steps.find((s) => s.name === 'Enforce Verdict');

  it('has a step that enforces, not merely reports, the verdict', () => {
    expect(enforce, 'the Enforce Verdict step must exist').toBeDefined();
    expect(enforce!.run).toContain('exit 1');
    // It must read the verdict from the action's output, not re-derive it from comment text.
    expect(enforce!.env?.VERDICT).toContain('steps.review.outputs.verdict');
  });

  it('fails the check on every terminal non-approving verdict', () => {
    const run = enforce!.run!;
    for (const verdict of ['FIX_FIRST', 'BLOCK', 'NO_VERDICT']) {
      expect(run, `${verdict} must be handled`).toContain(verdict);
    }
    // FIX_FIRST and BLOCK share a failing branch.
    expect(run).toMatch(/FIX_FIRST\|BLOCK\)/u);
  });

  it('fails closed on an empty or unrecognized verdict rather than passing', () => {
    const run = enforce!.run!;
    // An empty verdict is an explicit case, not a fall-through.
    expect(run).toMatch(/NO_VERDICT\|""\)/u);
    // And anything unmodelled hits a default that fails.
    expect(run).toMatch(/\*\)[\s\S]*exit 1/u);
  });

  it('blocks on outstanding P2 nits even when the verdict is SHIP', () => {
    const run = enforce!.run!;
    // A P2-only review arbitrates to SHIP ("passed or contained only minor nits"), so SHIP alone
    // does not mean "nothing to fix". Nits that merge are nits that never get fixed.
    expect(enforce!.env?.P2_COUNT).toContain('steps.review.outputs.p2-count');
    expect(run).toMatch(/P2_COUNT[\s\S]{0,120}-gt 0/u);
    // The P2 branch must live inside the SHIP case, not replace it.
    const shipCase = run.slice(run.indexOf('SHIP)'), run.indexOf('FIX_FIRST|BLOCK)'));
    expect(shipCase).toContain('P2_COUNT');
    expect(shipCase).toContain('exit 1');
  });

  it('leaves the non-terminal DISPATCHED state neutral', () => {
    const run = enforce!.run!;
    // The App gate is still pending on this head; a later run decides. Neither pass nor fail.
    expect(run).toContain('DISPATCHED');
    expect(run).toMatch(/DISPATCHED[\s\S]{0,300}exit 0/u);
  });

  it('still runs when the review step failed, so a crashed review cannot skip the gate', () => {
    expect(enforce!).toMatchObject({ if: 'always()' } as any);
  });
});
