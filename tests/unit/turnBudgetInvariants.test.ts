import { describe, expect, it } from 'vitest';
import { MAX_INVESTIGATION_TURNS } from '../../src/panel/panelEngine';
import { PUBLISHING_MAX_TURNS } from '../../src/config/publishingWorkerConfig';
import {
  COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS,
  COMPOSED_PLAN_MAX_TURNS,
  COMPOSED_TASK_MAX_TURNS,
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
});
