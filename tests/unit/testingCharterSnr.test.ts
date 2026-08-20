import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');

// Exercises SNR ((hits + valid suggestions) / noise) and precision, added to summarizeArm on top
// of a new per-finding structural classification (classifyFindings) in evaluate-testing-charter.mjs.
const {
  evaluateTestingCharter, reviewWithBoundedInvestigation, summarizeArm,
} = await import('../../scripts/evaluate-testing-charter.mjs');

const matrix = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/testing-charter/evaluation-matrix.json'), 'utf8'));
const persona = pipeline.PERSONA_CHARTERS.find((entry: { id: string }) => entry.id === matrix.personaId);
const defectFixture = matrix.fixtures.find((fixture: { category: string }) => fixture.category === 'defect');

function sseChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ model: 'test/model', provider: 'TestProvider', choices: [{ delta }], ...extra })}\n\n`;
}

function fakeSseFetch(parts: Array<{ text: string; delayMs?: number }>) {
  return async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const part of parts) {
          if (part.delayMs) await new Promise((resolve) => setTimeout(resolve, part.delayMs));
          controller.enqueue(encoder.encode(part.text));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

/** A bounded-contract COMPLETE turn naming the seeded defect exactly (a "hit"), plus one
 * off-target finding (anchored to nothing -- "noise") so hits/validSuggestions/noise all exercise. */
function boundedCompletionContent(fixtureId: string): string {
  if (fixtureId !== defectFixture.id) {
    return JSON.stringify({ review_status: 'COMPLETE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [] });
  }
  return JSON.stringify({
    review_status: 'COMPLETE',
    risk_plan: [{ id: 'risk-1', unit_ids: [], statement: 'seeded defect', evidence_needed: [], allowed_tools: [] }],
    evidence_requests: [],
    risk_dispositions: [{ risk_id: 'risk-1', status: 'confirmed', reason: 'matches fixture' }],
    findings: [
      {
        severity: 'P1',
        path: defectFixture.expectedPaths[0],
        line: 1,
        side: 'RIGHT',
        title: 'seeded defect',
        body: defectFixture.mustMatch.map((group: string[]) => group[0]).join(' '),
        risk_id: 'risk-1',
        evidence_receipt_ids: [],
      },
      {
        severity: 'P2',
        path: 'unrelated/file.py',
        line: 1,
        side: 'RIGHT',
        title: 'unrelated nit',
        body: 'this finding does not anchor to any expected path',
        risk_id: 'risk-1',
        evidence_receipt_ids: [],
      },
    ],
  });
}

describe('evaluate-testing-charter.mjs SNR/precision (summarizeArm)', () => {
  it('classifies findings as hit/valid_suggestion/noise and computes SNR = (hits+validSuggestions)/noise', async () => {
    const fetchImplementation = fakeSseFetch([
      { text: sseChunk({ content: boundedCompletionContent(defectFixture.id) }) },
    ]);
    const { rows } = await evaluateTestingCharter(
      { ...matrix, fixtures: [defectFixture] },
      {
        repetitions: 1,
        concurrency: 1,
        arms: [{ id: 'candidate', persona, charter: persona.charter }],
        reviewWithModel: reviewWithBoundedInvestigation,
        modelOptions: { fetchImplementation, apiKey: 'test-key', model: 'test/model', maxAttempts: 1, timeoutMs: 5_000 },
      },
    );

    const [row] = rows;
    // One finding matches the fixture exactly (hit), one anchors nowhere (noise).
    expect(row).toMatchObject({ hits: 1, validSuggestions: 0, noise: 1, detected: true });

    const summary = summarizeArm(rows, 'candidate');
    expect(summary.hits).toBe(1);
    expect(summary.noise).toBe(1);
    expect(summary.snr).toBe(1); // (1 hit + 0 valid) / 1 noise
    expect(summary.precision).toBe(0.5); // 1 hit / (1 hit + 1 noise)
  });

  it('reports every finding on a clean control as noise, never a hit or valid suggestion', () => {
    const rows = [
      { arm: 'candidate', category: 'clean', errored: false, falsePositive: true, findings: 2, hits: 0, validSuggestions: 0, noise: 2, latencyMs: 100 },
    ];
    const summary = summarizeArm(rows, 'candidate');
    expect(summary).toMatchObject({ hits: 0, validSuggestions: 0, noise: 2, snr: 0, precision: 0 });
  });

  it('reports snr as unbounded (not Infinity, not a fabricated number) when noise is zero and signal is nonzero', () => {
    const rows = [
      { arm: 'candidate', category: 'defect', errored: false, detected: true, anchored: true, findings: 1, hits: 1, validSuggestions: 0, noise: 0, latencyMs: 100 },
    ];
    const summary = summarizeArm(rows, 'candidate');
    expect(summary.snr).toBeNull();
    expect(summary.snrUnbounded).toBe(true);
  });

  it('reports snr as null and not unbounded when there is no signal and no noise at all (nothing measured)', () => {
    const summary = summarizeArm([], 'candidate');
    expect(summary.snr).toBeNull();
    expect(summary.snrUnbounded).toBe(false);
  });
});
