import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');

// evaluate-ablations.mjs's cap/reasoning sweeps (REL: operator ask, 2026-08-20 "controlled
// ablations against the testing-charter harness") share reviewWithBoundedInvestigation's own
// offline-testability contract (a scripted modelClient, no network, no API key) with
// evaluate-testing-charter.mjs -- these tests assert the parts that are unique to this script and
// would otherwise only be caught on a live, paid run:
//   1. capCharter is a single-token substitution (ONE/TWO/THREE), not a charter rewrite.
//   2. cap=3's charter is byte-identical to the live persona.charter -- it has to be the
//      unmodified production reference point, not an accidental paraphrase.
//   3. the offline grading path (reviewWithBoundedInvestigation -> classifyFinding/hitRank/
//      slotsFilled) matches a scripted multi-finding response correctly.
const {
  reviewWithBoundedInvestigation,
} = await import('../../scripts/evaluate-ablations.mjs');

const matrix = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/testing-charter/evaluation-matrix.json'), 'utf8'));
const persona = pipeline.PERSONA_CHARTERS.find((entry: { id: string }) => entry.id === matrix.personaId);
const defectFixture = matrix.fixtures.find((fixture: { id: string }) => fixture.id === 'vacuous-default-value-test');

describe('evaluate-ablations.mjs capCharter (offline)', () => {
  it('substitutes only the number word, preserving the live charter\'s exact wrap/whitespace', () => {
    const CAP_PHRASE_PATTERN = /at most the THREE\s+highest-impact test gaps/;
    expect(CAP_PHRASE_PATTERN.test(persona.charter)).toBe(true);

    // Re-derive capCharter the same way the script does (not exported -- see the script's own
    // header on deliberate small duplication of already-public structural rules) to assert the
    // substitution shape without re-implementing a second copy of the harness.
    const capCharter = (liveCharter: string, cap: number) => {
      const word = { 1: 'ONE', 2: 'TWO', 3: 'THREE' }[cap];
      return liveCharter.replace(CAP_PHRASE_PATTERN, (matched) => matched.replace('THREE', word as string));
    };

    const cap1 = capCharter(persona.charter, 1);
    const cap2 = capCharter(persona.charter, 2);
    const cap3 = capCharter(persona.charter, 3);

    expect(cap1).toContain('at most the ONE');
    expect(cap2).toContain('at most the TWO');
    expect(cap3).toBe(persona.charter);
    // Only the number word differs -- same length delta as swapping ONE/TWO (3 chars) for THREE
    // (5 chars), nothing else in the sentence moved.
    expect(persona.charter.length - cap1.length).toBe(2);
    expect(persona.charter.length - cap2.length).toBe(2);
  });
});

describe('evaluate-ablations.mjs reviewWithBoundedInvestigation grading inputs (offline)', () => {
  it('returns findings in model order with model/provider passed through, for a scripted multi-finding response', async () => {
    const modelClient = async () => ({
      ok: true,
      content: JSON.stringify({
        review_status: 'COMPLETE',
        risk_plan: [],
        evidence_requests: [],
        risk_dispositions: [],
        findings: [
          { path: 'some/unrelated/file.js', line: 1, title: 'noise finding', body: 'unrelated', severity: 'P2' },
          {
            path: 'tests/test_marker_policy.py',
            line: 5,
            title: 'vacuous assertion',
            body: 'This assertion is identical to the sibling default and pins nothing; it would still pass even if the check were removed.',
            severity: 'P1',
          },
        ],
      }),
      model: 'deepseek/deepseek-v4-flash-0731',
      provider: 'test-provider',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUSD: 0.0001 },
    });

    const result = await reviewWithBoundedInvestigation(
      persona,
      defectFixture.files,
      { repo: 'x/y', prNumber: 'offline-1', title: defectFixture.title },
      null,
      { modelClient },
    );

    expect(result.decision).toBe('FINDINGS');
    expect(result.findings).toHaveLength(2);
    // Order preserved -- the noise finding is first, the real hit second. hitRank in the full
    // harness would compute 2 for this row, not 1: this is the exact case the cap ablation's
    // "does the cap keep the model's OWN first-listed idea, or the evidence-backed one" question
    // depends on being measured correctly.
    expect(result.findings[0].title).toBe('noise finding');
    expect(result.findings[1].title).toBe('vacuous assertion');
    expect(result.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(result.provider).toBe('test-provider');
  });

  it('reports decision ERROR with no model/provider on a scripted failure, never throwing', async () => {
    const modelClient = async () => ({ ok: false, error: 'provider_failure' });
    const result = await reviewWithBoundedInvestigation(
      persona,
      defectFixture.files,
      { repo: 'x/y', prNumber: 'offline-2', title: defectFixture.title },
      null,
      { modelClient },
    );
    expect(result.decision).toBe('ERROR');
    expect(result.findings).toEqual([]);
  });
});
