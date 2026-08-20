import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');

// evaluate-testing-charter.mjs's own detection eval (test:testing-charter-eval) needs a working
// OPENROUTER_API_KEY and, until reviewWithBoundedInvestigation existed, only ever exercised
// reviewWithModel -- the legacy single-shot path, not runPersonaInvestigation +
// buildInvestigationMessages (review-pipeline.js's boundedMode branch, which is what actually
// ships on every real PR review). These tests run fully offline (a scripted modelClient, no
// network, no API key) and assert two things a live run alone cannot cheaply prove every commit:
// (1) the harness is actually wired to the bounded engine, not silently still hitting the legacy
// one, and (2) the grading plumbing (evaluateTestingCharter -> gradeRun -> findingMatchesFixture)
// correctly detects a real bounded-contract finding and stays quiet on a clean control.
const { evaluateTestingCharter, reviewWithBoundedInvestigation, resolveEvalMaxTokens } = await import('../../scripts/evaluate-testing-charter.mjs');

const matrix = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/testing-charter/evaluation-matrix.json'), 'utf8'));
const persona = pipeline.PERSONA_CHARTERS.find((entry: { id: string }) => entry.id === matrix.personaId);

function fixtureIdFromPrNumber(prNumber: string): string {
  // evaluateTestingCharter sets prNumber to `testing-charter-${arm.id}-${repetition}-${fixture.id}`.
  const match = String(prNumber).match(/^testing-charter-[^-]+-\d+-(.+)$/);
  if (!match) throw new Error(`could not recover fixture id from prNumber: ${prNumber}`);
  return match[1];
}

describe('evaluate-testing-charter.mjs bounded-path harness (offline)', () => {
  it('drives runPersonaInvestigation/buildInvestigationMessages, not the legacy reviewWithModel prompt', async () => {
    expect(persona).toBeTruthy();
    const capturedSystemPrompts: string[] = [];
    const modelClient = async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      const system = messages.find((message) => message.role === 'system');
      if (system) capturedSystemPrompts.push(system.content);
      return {
        ok: true,
        content: JSON.stringify({
          review_status: 'COMPLETE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [],
        }),
      };
    };

    await evaluateTestingCharter(matrix, {
      repetitions: 1,
      concurrency: 2,
      arms: [{ id: 'offline', persona, charter: persona.charter }],
      reviewWithModel: reviewWithBoundedInvestigation,
      modelOptions: { modelClient },
    });

    expect(capturedSystemPrompts.length).toBeGreaterThan(0);
    // "bounded code-review panel" is unique to reviewInvestigationPrompt.js's buildInvestigationMessages;
    // the legacy reviewWithModel prompt says "one reviewer on a code review panel" instead.
    expect(capturedSystemPrompts.every((prompt) => prompt.includes('bounded code-review panel'))).toBe(true);
    expect(capturedSystemPrompts.some((prompt) => prompt.includes('one reviewer on a code review panel'))).toBe(false);
  });

  it('detects a seeded defect through the real bounded contract and stays quiet on a clean control', async () => {
    const modelClient = async ({ prContext }: { prContext: { prNumber: string } }) => {
      const fixtureId = fixtureIdFromPrNumber(prContext.prNumber);
      if (fixtureId === 'vacuous-default-value-test') {
        return {
          ok: true,
          content: JSON.stringify({
            review_status: 'COMPLETE',
            risk_plan: [{ id: 'risk-1', unit_ids: [], statement: 'New test may duplicate an existing assertion', evidence_needed: [], allowed_tools: [] }],
            evidence_requests: [],
            risk_dispositions: [{
              risk_id: 'risk-1',
              status: 'confirmed',
              reason: 'The new test passes the same default marker value as the existing test, so it is identical and pins nothing.',
            }],
            findings: [{
              severity: 'P1',
              path: 'tests/test_marker_policy.py',
              line: 9,
              side: 'RIGHT',
              title: 'New test duplicates the default marker, asserting nothing new',
              body: 'test_review_yeti_bot_marker_is_also_recognized passes marker="review-yeti-bot:v1", which is identical to marker_payload()\'s own default value. The assertion duplicates test_default_marker_is_recognized and pins nothing additional -- it would still pass even if login recognition were entirely broken.',
              risk_id: 'risk-1',
              evidence_receipt_ids: [],
            }],
          }),
        };
      }
      return {
        ok: true,
        content: JSON.stringify({
          review_status: 'COMPLETE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [],
        }),
      };
    };

    const { rows, fixtures } = await evaluateTestingCharter(matrix, {
      repetitions: 1,
      concurrency: 3,
      arms: [{ id: 'offline', persona, charter: persona.charter }],
      reviewWithModel: reviewWithBoundedInvestigation,
      modelOptions: { modelClient },
    });

    expect(rows.every((row: { errored: boolean }) => !row.errored)).toBe(true);
    const defectRow = rows.find((row: { fixtureId: string }) => row.fixtureId === 'vacuous-default-value-test');
    expect(defectRow).toMatchObject({ detected: true, anchored: true });
    for (const row of rows.filter((entry: { category: string }) => entry.category === 'clean')) {
      expect(row).toMatchObject({ falsePositive: false });
    }
    expect(fixtures.length).toBe(matrix.fixtures.length);
  });

  it('reports an errored row instead of throwing when the scripted turn returns an unparseable contract', async () => {
    const modelClient = async () => ({ ok: true, content: 'not json' });

    const { rows } = await evaluateTestingCharter(matrix, {
      repetitions: 1,
      concurrency: 1,
      arms: [{ id: 'offline', persona, charter: persona.charter }],
      reviewWithModel: reviewWithBoundedInvestigation,
      modelOptions: { modelClient },
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row: { errored: boolean }) => row.errored === true)).toBe(true);
  });
});

// Found live by eval-expand's PR #132 baseline: on the same fixtures/model/modelOptions, the
// --bounded arm detected less than a third as often as the legacy arm, with over double the
// malformed_response error rate. Root cause: this script's --max-tokens defaults to 4,096 and
// applied that ceiling identically to both arms -- but production's bounded engine
// (review-pipeline.js's resolveModelConfig) never sets an explicit max_tokens at all, letting the
// provider's own (much larger) default apply. The bounded contract's response
// (risk_plan + evidence_requests + risk_dispositions + findings, each with its own text fields)
// is unavoidably larger than the legacy contract's, so a shared 4,096-token ceiling starves the
// bounded arm specifically -- an eval-harness artifact, not evidence about the engine it measures.
describe('resolveEvalMaxTokens (the bounded-vs-legacy token-ceiling parity fix)', () => {
  it('omits maxTokens entirely for a bounded run when the caller did not explicitly ask for one, matching production\'s own uncapped behaviour', () => {
    expect(resolveEvalMaxTokens({ argv: ['node', 'script.mjs', '--bounded'], bounded: true, fallback: 4_096 })).toBeUndefined();
  });

  it('still applies the flat default for a legacy run -- only the bounded path is production-uncapped', () => {
    expect(resolveEvalMaxTokens({ argv: ['node', 'script.mjs'], bounded: false, fallback: 4_096 })).toBe(4_096);
  });

  it('honors an explicit --max-tokens on a bounded run -- a deliberate operator choice is never silently discarded', () => {
    expect(resolveEvalMaxTokens({ argv: ['node', 'script.mjs', '--bounded', '--max-tokens', '2048'], bounded: true, fallback: 4_096 })).toBe(2_048);
  });

  it('honors an explicit --max-tokens on a legacy run too', () => {
    expect(resolveEvalMaxTokens({ argv: ['node', 'script.mjs', '--max-tokens', '8192'], bounded: false, fallback: 4_096 })).toBe(8_192);
  });

  it('falls back to the flat default on a non-numeric or missing explicit value, on either path', () => {
    expect(resolveEvalMaxTokens({ argv: ['node', 'script.mjs', '--max-tokens', 'not-a-number'], bounded: false, fallback: 4_096 })).toBe(4_096);
    expect(resolveEvalMaxTokens({ argv: ['node', 'script.mjs', '--bounded', '--max-tokens', 'not-a-number'], bounded: true, fallback: 4_096 })).toBe(4_096);
  });
});
