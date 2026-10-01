import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PUBLISHING_IDLE_TIMEOUT_SECONDS, PUBLISHING_MAX_TURNS, PUBLISHING_OVERALL_TIMEOUT_SECONDS,
  resolveWorkerConfig,
} from '../../src/config/publishingWorkerConfig';
import {
  WORKER_DEADLINE_FLOOR_MARGIN_MS, WORKER_PANEL_RESERVE_MS, WORKER_RECEIPT_RESERVE_MS,
  WORKER_TERMINAL_DEADLINE_ENV, WORKER_TERMINAL_DEADLINE_RESERVE_MS, workerPanelDeadlineBudget,
} from '../../src/config/workerTerminalDeadline';
import { createPanelDeadlineSignal } from '../../src/panel/panelEngine';
import { fingerprintEffectiveReviewConfig } from '../../src/review/authoritativeReviewIdentity';
import { createOpenAIPublishingConfig } from '../../src/review/openaiTransport';
import {
  parsePreparedReviewExecution, preparePublishingPolicy, verifyPreparedPublishingConfig,
} from '../../src/review/preparedPublishingPolicy';

const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' };
const workerTransport = { ...transport, apiKey: 'synthetic-not-persisted' };
const admissionAt = Date.parse('2026-01-01T00:00:00Z');
const deadlineEnv = (windowMs: number) => ({
  [WORKER_TERMINAL_DEADLINE_ENV]: new Date(admissionAt + windowMs).toISOString(),
});
function preparedFixture() {
  const content = JSON.stringify({ schema: 'exampleorg.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 20 }, api_key_env: 'PRIVATE_KEY_NAME_ONLY',
  } });
  return preparePublishingPolicy({ content, source: {
    repositoryId: 123, repository: 'example/policy', sha: 'a'.repeat(40), path: 'policy/review-yeti.json',
    contentDigest: createHash('sha256').update(content).digest('hex'),
  } }, transport);
}

describe('bounded publishing work budget', () => {
  it('sets the shared funded ceiling to 50 minutes without changing turns or idle deadlines', () => {
    expect(PUBLISHING_OVERALL_TIMEOUT_SECONDS).toBe(3_000);
    expect(Number.isSafeInteger(PUBLISHING_OVERALL_TIMEOUT_SECONDS)).toBe(true);
    expect(PUBLISHING_MAX_TURNS).toBe(15);
    expect(PUBLISHING_IDLE_TIMEOUT_SECONDS).toBe(180);
  });

  it('projects the ceiling through the central publishing resolver with the existing roster and provider', () => {
    const config = resolveWorkerConfig({}, workerTransport);
    expect(config.reviewers.overall_timeout_s).toBe(3_000);
    expect(config.default_max_turns).toBe(15);
    expect(config.review_engine).toBe('panel');
    expect(config.personas.map((persona) => persona.id)).toEqual([
      'sec-lane', 'perf-lane', 'arch-lane', 'qual-lane', 'dep-lane', 'policy-lane',
    ]);
    expect(config.personas.every((persona) => persona.enabled && persona.providers?.join() === 'bifrost')).toBe(true);
    expect(config.reviewers).toMatchObject({ execution: 'personas', fallback: 'ordered',
      providers: [{ id: 'bifrost', enabled: true, model: transport.model, effort: 'medium',
        review_timeout_s: 180, arbiter_timeout_s: 180 }], arbiter: { order: ['bifrost'] } });
    expect(JSON.stringify(config)).not.toContain(workerTransport.apiKey);
  });

  it('projects the same ceiling through the standalone publishing constructor', () => {
    const config = createOpenAIPublishingConfig(transport.model);
    expect(config.reviewers.overall_timeout_s).toBe(3_000);
    expect(config.default_max_turns).toBe(15);
    expect(config.personas.every((persona) => persona.providers?.join() === 'bifrost')).toBe(true);
    expect(config.reviewers).toMatchObject({ fallback: 'none',
      providers: [{ id: 'bifrost', enabled: true, model: transport.model,
        review_timeout_s: 180, arbiter_timeout_s: 180 }], arbiter: { order: ['bifrost'] } });
  });

  it.each([0, -1, 1, 999_999])('does not admit a policy timeout override of %i', (override) => {
    const config = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: ['security', 'testing'], budget: { max_investigation_turns: 3, overall_timeout_s: override },
      reviewers: { overall_timeout_s: override }, review_engine: 'composed', composed: { max_tasks: 2 },
    } }) }, workerTransport);
    expect(config.reviewers.overall_timeout_s).toBe(3_000);
    expect(config.default_max_turns).toBe(3);
    expect(config.personas.map((persona) => persona.id)).toEqual(['sec-lane', 'qual-lane']);
    expect(config.review_engine).toBe('composed');
    expect(config.composed).toEqual({ max_tasks: 2 });
  });

  it('binds the new ceiling to the prepared execution identity without retaining source credentials', () => {
    const prepared = preparedFixture();
    expect(prepared.config.reviewers.overall_timeout_s).toBe(3_000);
    expect(prepared.config.default_max_turns).toBe(15);
    expect(prepared.expectedPersonaIds).toEqual(['sec-lane', 'qual-lane']);
    expect(JSON.stringify(prepared)).not.toContain('PRIVATE_KEY_NAME_ONLY');
    expect(verifyPreparedPublishingConfig(prepared.config, prepared.policy.effectiveConfigDigest, transport))
      .toEqual(prepared.config);
    const envelope = { version: 'PreparedReviewExecution.v1', config: prepared.config, transport };
    expect(parsePreparedReviewExecution(JSON.stringify(envelope), prepared.policy.effectiveConfigDigest, transport))
      .toEqual(envelope);
  });

  it('refuses the stale 30-minute effective digest rather than silently reusing an old admission', () => {
    const prepared = preparedFixture();
    const oldConfig = structuredClone(prepared.config);
    oldConfig.reviewers.overall_timeout_s = 1_800;
    const oldDigest = fingerprintEffectiveReviewConfig({ config: oldConfig, transport });
    expect(oldDigest).not.toBe(prepared.policy.effectiveConfigDigest);
    expect(() => verifyPreparedPublishingConfig(prepared.config, oldDigest, transport))
      .toThrow('Prepared publishing configuration does not match its admitted identity');
    expect(() => parsePreparedReviewExecution(JSON.stringify({
      version: 'PreparedReviewExecution.v1', config: prepared.config, transport,
    }), oldDigest, transport)).toThrow('Prepared review execution does not match its admitted identity');
    expect(() => verifyPreparedPublishingConfig(oldConfig, prepared.policy.effectiveConfigDigest, transport)).toThrow();
    // Historical configurations remain immutable and usable only with their own admitted identity.
    expect(verifyPreparedPublishingConfig(oldConfig, oldDigest, transport)).toEqual(oldConfig);
  });
});

describe('publishing ceiling inside the immutable lifecycle cutoff', () => {
  it('retains both existing reserves and the operator floor margin', () => {
    expect(WORKER_TERMINAL_DEADLINE_RESERVE_MS).toBe(60_000);
    expect(WORKER_RECEIPT_RESERVE_MS).toBe(60_000);
    expect(WORKER_PANEL_RESERVE_MS).toBe(120_000);
    expect(WORKER_DEADLINE_FLOOR_MARGIN_MS).toBe(1_000);
  });

  it.each([
    { windowMs: 3_600_000, elapsedMs: 0, timeoutMs: 3_000_000, terminalBound: false },
    { windowMs: 3_600_000, elapsedMs: 1_080_000, timeoutMs: 2_399_000, terminalBound: true },
    { windowMs: 2_100_000, elapsedMs: 0, timeoutMs: 1_979_000, terminalBound: true },
    { windowMs: 2_100_000, elapsedMs: 1_080_000, timeoutMs: 899_000, terminalBound: true },
  ])('clamps a $windowMs ms admission after $elapsedMs ms of queue/setup time', (scenario) => {
    const config = resolveWorkerConfig({}, workerTransport);
    const now = admissionAt + scenario.elapsedMs;
    const budget = workerPanelDeadlineBudget(config.reviewers.overall_timeout_s, deadlineEnv(scenario.windowMs), now);
    expect(budget).toEqual({ deadlineAtMs: now + scenario.timeoutMs,
      timeoutMs: scenario.timeoutMs, terminalBound: scenario.terminalBound });
    expect(budget.deadlineAtMs).toBeLessThanOrEqual(admissionAt + scenario.windowMs - 121_000);
  });

  it('uses the finite publishing ceiling when an older operator has no additional absolute deadline', () => {
    const config = createOpenAIPublishingConfig(transport.model);
    expect(workerPanelDeadlineBudget(config.reviewers.overall_timeout_s, {}, admissionAt)).toEqual({
      deadlineAtMs: admissionAt + 3_000_000, timeoutMs: 3_000_000, terminalBound: false,
    });
  });

  it('does not replenish the work cutoff after grounding before a nested engine starts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(admissionAt);
    const config = resolveWorkerConfig({}, workerTransport);
    const budget = workerPanelDeadlineBudget(config.reviewers.overall_timeout_s, deadlineEnv(3_600_000), Date.now());
    vi.advanceTimersByTime(40_000);
    const nested = createPanelDeadlineSignal(config.reviewers.overall_timeout_s, undefined, budget, Date.now);
    try {
      expect(nested.budget.deadlineAtMs).toBe(admissionAt + 3_000_000);
      expect(nested.timeoutMs).toBe(2_960_000);
      expect(nested.signal.aborted).toBe(false);
      vi.advanceTimersByTime(nested.timeoutMs - 1);
      expect(nested.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(nested.signal.aborted).toBe(true);
      expect(() => nested.check()).toThrow();
    } finally {
      nested.cleanup();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it.each([0, 1])('does not start paid work when the reserved cutoff is exhausted by %i ms', (pastMs) => {
    const config = resolveWorkerConfig({}, workerTransport);
    const cutoff = admissionAt + 3_600_000 - 121_000;
    const budget = workerPanelDeadlineBudget(config.reviewers.overall_timeout_s, deadlineEnv(3_600_000), cutoff + pastMs);
    expect(budget).toEqual({ deadlineAtMs: cutoff, timeoutMs: 0, terminalBound: true });
    const providerCall = vi.fn();
    const panel = createPanelDeadlineSignal(config.reviewers.overall_timeout_s, undefined, budget, () => cutoff + pastMs);
    try {
      expect(panel.signal.aborted).toBe(true);
      expect(() => { panel.check(); providerCall(); }).toThrow();
      expect(providerCall).not.toHaveBeenCalled();
    } finally { panel.cleanup(); }
  });

  it.each(['not-a-deadline', 'Infinity', '2026-99-99T00:00:00Z'])('refuses malformed explicit lifecycle deadline %s', (deadline) => {
    const config = resolveWorkerConfig({}, workerTransport);
    expect(() => workerPanelDeadlineBudget(config.reviewers.overall_timeout_s,
      { [WORKER_TERMINAL_DEADLINE_ENV]: deadline }, admissionAt)).toThrow('Worker lifecycle deadline is invalid');
  });
});
