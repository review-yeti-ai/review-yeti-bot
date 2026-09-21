import { describe, expect, it } from 'vitest';
import { MAX_INVESTIGATION_TURNS } from '../../src/panel/panelEngine';
import { PUBLISHING_MAX_TURNS } from '../../src/config/publishingWorkerConfig';
import { composedEngineConfigSchema } from '../../src/config/schema';
import {
  COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS,
  COMPOSED_PLAN_MAX_TURNS,
  COMPOSED_TASK_MAX_TURNS,
  resolveTaskTurnCeiling,
  COMPOSED_ENGINE_MAX_TOTAL_TURNS_HARD_CAP,
  resolveComposedEngineMaxTurns,
} from '../../src/panel/composedEngine';

describe('panel turn ceilings stay in agreement', () => {
  // `MAX_INVESTIGATION_TURNS` (panelEngine.ts) bounds a single persona lane's own turn count.
  // `PUBLISHING_MAX_TURNS` (publishingWorkerConfig.ts) is the DOKS publishing worker's projection
  // of that same ceiling -- its own doc comment says it "matches the central policy's
  // max_investigation_turns so a caller policy cannot be silently clamped below its requested
  // budget." These are two independently declared constants with no shared source; nothing
  // previously asserted they stay equal, so one could drift from the other silently (e.g. someone
  // bumps MAX_INVESTIGATION_TURNS for a panel change and never notices PUBLISHING_MAX_TURNS is now
  // a stricter, silently-lower ceiling than the panel engine itself allows).
  it('MAX_INVESTIGATION_TURNS and PUBLISHING_MAX_TURNS never silently disagree', () => {
    expect(PUBLISHING_MAX_TURNS).toBe(MAX_INVESTIGATION_TURNS);
  });
});

describe('composed engine turn budget resolution (own, separate ceilings)', () => {
  // The composed engine must never reuse or be silently raised to match the panel engine's
  // ceilings -- see composedEngine.ts's module doc comment ("This engine does NOT reuse
  // MAX_INVESTIGATION_TURNS or PUBLISHING_MAX_TURNS as its cap ... and it must never quietly raise
  // either of them"). Assert the composed constants are genuinely independent values, not aliases
  // that happen to typecheck.
  it('COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS is not the panel ceiling', () => {
    expect(COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS).not.toBe(MAX_INVESTIGATION_TURNS);
    expect(COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS).not.toBe(PUBLISHING_MAX_TURNS);
  });

  it('defaults to COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS with no env override and no policy value', () => {
    expect(resolveComposedEngineMaxTurns({} as NodeJS.ProcessEnv)).toBe(COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS);
  });

  it('projects a policy-provided composed.max_turns_total when no env override is set', () => {
    expect(resolveComposedEngineMaxTurns({} as NodeJS.ProcessEnv, 20)).toBe(20);
  });

  it('clamps a policy-provided composed.max_turns_total down to the hard cap, never raises it', () => {
    expect(resolveComposedEngineMaxTurns({} as NodeJS.ProcessEnv, 9_999)).toBe(COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS);
  });

  it('lets the manual env override win over a policy-provided value', () => {
    expect(resolveComposedEngineMaxTurns({ COMPOSED_ENGINE_MAX_TURNS: '10' } as unknown as NodeJS.ProcessEnv, 30)).toBe(10);
  });

  it('ignores a malformed policy value and falls back to the default', () => {
    expect(resolveComposedEngineMaxTurns({} as NodeJS.ProcessEnv, -5)).toBe(COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS);
    expect(resolveComposedEngineMaxTurns({} as NodeJS.ProcessEnv, Number.NaN)).toBe(COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS);
  });

  it('the plan and per-task phase ceilings stay well under the total turn budget', () => {
    // Not a tautology to skip: this fails if either phase ceiling is ever raised past the total
    // budget without the total being raised alongside it.
    expect(COMPOSED_PLAN_MAX_TURNS).toBeLessThan(COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS);
    expect(COMPOSED_TASK_MAX_TURNS).toBeLessThan(COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS);
  });

  // Policy narrows only. A central policy that could RAISE an engine's own ceiling would let the
  // policy author widen a budget they do not own -- and the two panel clamps exist precisely so
  // that nobody does that by accident.
  it('ignores a per-task turn ceiling larger than the engine constant', () => {
    const resolve = (policy?: number) => resolveTaskTurnCeiling(policy, 999);
    expect(resolve(COMPOSED_TASK_MAX_TURNS + 50)).toBe(COMPOSED_TASK_MAX_TURNS);
    expect(resolve(2)).toBe(2);
    expect(resolve(undefined)).toBe(COMPOSED_TASK_MAX_TURNS);
    expect(resolve(0)).toBe(COMPOSED_TASK_MAX_TURNS);
    expect(resolve(-4)).toBe(COMPOSED_TASK_MAX_TURNS);
  });

  // The security floor is not an operator toggle. Exposing it as a boolean offers exactly one
  // meaningful value -- false -- and invites a future wiring pass to turn the defence against a
  // diff that says "skip auth review" into a config option (ADR 0639).
  it('does not expose require_security_task as a policy key', () => {
    expect(Object.keys(composedEngineConfigSchema.shape)).not.toContain('require_security_task');
    // The block is `.strict()`, so a policy carrying the key is REJECTED rather than quietly
    // parsed with the key riding along. The earlier version of this test asserted the key
    // survived on the parsed object, which read as endorsing exactly the leak it meant to forbid.
    expect(() => composedEngineConfigSchema.parse({ require_security_task: false })).toThrow();
    expect(() => composedEngineConfigSchema.parse({ max_tasks: 4 })).not.toThrow();
  });

  it('clamps the operator env override to the same ceiling policy is bound by', () => {
    // The override may exceed the DEFAULT (that is its purpose) but not the hard cap. Returned raw
    // before this, so a mistyped COMPOSED_ENGINE_MAX_TURNS=4800 was honoured verbatim.
    expect(resolveComposedEngineMaxTurns({ COMPOSED_ENGINE_MAX_TURNS: '4800' } as any))
      .toBe(COMPOSED_ENGINE_MAX_TOTAL_TURNS_HARD_CAP);
    expect(resolveComposedEngineMaxTurns({ COMPOSED_ENGINE_MAX_TURNS: '60' } as any)).toBe(60);
    expect(resolveComposedEngineMaxTurns({} as any)).toBe(COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS);
  });

});
