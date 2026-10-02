import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
 *
 * REL-585 hardens the SHIP branch to also require the pipeline's own coverage/gate signals
 * (gate-decision, merge-eligible, files-omitted -- see review-pipeline.js's writeStepOutputs)
 * rather than trusting the verdict string alone, and removes the P2-blocking branch: that policy
 * belongs to arbitration (src/review/reviewCore.js's fixP2 threshold), not this workflow layer,
 * and this layer had no suppression path for a P2 false positive.
 */
describe('review verdict enforcement (REL-580, REL-585)', () => {
  const workflow = yaml.load(raw) as any;
  const steps = workflow.jobs.review.steps as Array<{ name?: string; run?: string; env?: Record<string, string> }>;
  const enforce = steps.find((s) => s.name === 'Enforce Verdict');

  it('has a step that enforces, not merely reports, the verdict', () => {
    expect(enforce, 'the Enforce Verdict step must exist').toBeDefined();
    expect(enforce!.run).toContain('exit 1');
    // It must read the verdict from the action's output, not re-derive it from comment text.
    expect(enforce!.env?.VERDICT).toContain('steps.review.outputs.verdict');
  });

  it('reads the gate-decision, merge-eligible, and files-omitted outputs', () => {
    // These are the load-bearing coverage/gate signals from review-pipeline.js's
    // writeStepOutputs; a SHIP verdict that ignores them can pass while the diff budget omitted
    // files or arbitration itself did not consider the head merge-eligible.
    expect(enforce!.env?.GATE_DECISION).toContain('steps.review.outputs.gate-decision');
    expect(enforce!.env?.MERGE_ELIGIBLE).toContain('steps.review.outputs.merge-eligible');
    expect(enforce!.env?.FILES_OMITTED).toContain('steps.review.outputs.files-omitted');
  });

  it('no longer reads or blocks on p2-count', () => {
    // REL-585: P2 is advisory everywhere else (central gate, App path, arbitration's own
    // threshold) and this workflow layer had no suppression path for a false positive. The
    // env binding and the blocking branch must both be gone.
    expect(enforce!.env?.P2_COUNT).toBeUndefined();
    expect(enforce!.run).not.toContain('P2_COUNT');
    expect(enforce!.run).not.toContain('p2-count');
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

  it('leaves the non-terminal DISPATCHED state neutral', () => {
    const run = enforce!.run!;
    // The App gate is still pending on this head; a later run decides. Neither pass nor fail.
    expect(run).toContain('DISPATCHED');
    expect(run).toMatch(/DISPATCHED[\s\S]{0,300}exit 0/u);
  });

  it('still runs when the review step failed, so a crashed review cannot skip the gate', () => {
    expect(enforce!).toMatchObject({ if: 'always()' } as any);
  });

  describe('behavioral matrix (extracted script execution)', () => {
    // Extract the exact `run:` shell text from the parsed workflow and execute it for real,
    // rather than pattern-matching the source -- a passing string-match test can still hide a
    // logic bug (e.g. an inverted comparison) that only shows up at execution time.
    const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-verdict-')), 'enforce-verdict.sh');
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\n${enforce!.run}`, { mode: 0o755 });

    type EnvCase = {
      VERDICT?: string;
      REVIEW_STATUS?: string;
      GATE_DECISION?: string;
      MERGE_ELIGIBLE?: string;
      FILES_OMITTED?: string;
    };

    function runEnforce(env: EnvCase): { status: number | null; stdout: string; stderr: string } {
      const result = spawnSync('bash', [scriptPath], {
        env: {
          ...process.env,
          VERDICT: env.VERDICT ?? '',
          REVIEW_STATUS: env.REVIEW_STATUS ?? '',
          GATE_DECISION: env.GATE_DECISION ?? '',
          MERGE_ELIGIBLE: env.MERGE_ELIGIBLE ?? '',
          FILES_OMITTED: env.FILES_OMITTED ?? '',
        },
        encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    it('exits 0 for SHIP with a fully-covered, merge-eligible gate', () => {
      const { status } = runEnforce({
        VERDICT: 'SHIP',
        REVIEW_STATUS: 'SHIP',
        GATE_DECISION: 'PASS',
        MERGE_ELIGIBLE: 'true',
        FILES_OMITTED: '0',
      });
      expect(status).toBe(0);
    });

    it('exits 1 for SHIP when files-omitted is nonzero', () => {
      const { status, stdout } = runEnforce({
        VERDICT: 'SHIP',
        REVIEW_STATUS: 'SHIP',
        GATE_DECISION: 'PASS',
        MERGE_ELIGIBLE: 'true',
        FILES_OMITTED: '3',
      });
      expect(status).toBe(1);
      expect(stdout).toContain('omitted from review');
    });

    it('exits 1 for SHIP when gate-decision is not PASS', () => {
      const { status, stdout } = runEnforce({
        VERDICT: 'SHIP',
        REVIEW_STATUS: 'SHIP',
        GATE_DECISION: 'BLOCK',
        MERGE_ELIGIBLE: 'true',
        FILES_OMITTED: '0',
      });
      expect(status).toBe(1);
      expect(stdout).toContain('gate-decision');
    });

    it('exits 1 for SHIP when merge-eligible is not true', () => {
      const { status, stdout } = runEnforce({
        VERDICT: 'SHIP',
        REVIEW_STATUS: 'SHIP',
        GATE_DECISION: 'PASS',
        MERGE_ELIGIBLE: 'false',
        FILES_OMITTED: '0',
      });
      expect(status).toBe(1);
      expect(stdout).toContain('merge-eligible');
    });

    it('exits 0 for SHIP even when a p2-count-shaped input would have blocked the old branch', () => {
      // REL-585 removed the P2 branch entirely; the script no longer reads a P2 signal at all,
      // so a SHIP with clean gate signals passes regardless of nit findings.
      const { status } = runEnforce({
        VERDICT: 'SHIP',
        REVIEW_STATUS: 'SHIP',
        GATE_DECISION: 'PASS',
        MERGE_ELIGIBLE: 'true',
        FILES_OMITTED: '0',
      });
      expect(status).toBe(0);
    });

    it.each(['FIX_FIRST', 'BLOCK', 'NO_VERDICT', '', 'SOMETHING_UNRECOGNISED'])(
      'exits 1 for verdict=%p',
      (verdict) => {
        const { status } = runEnforce({ VERDICT: verdict, REVIEW_STATUS: verdict });
        expect(status).toBe(1);
      },
    );

    it('exits 0 for DISPATCHED regardless of verdict', () => {
      const { status } = runEnforce({ VERDICT: '', REVIEW_STATUS: 'DISPATCHED', GATE_DECISION: 'PENDING' });
      expect(status).toBe(0);
    });
  });
});
