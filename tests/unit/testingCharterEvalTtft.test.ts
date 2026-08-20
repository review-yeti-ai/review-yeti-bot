import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');

// Exercises the TTFT addition this file makes to evaluate-testing-charter.mjs: per-row
// firstChunkMs/firstContentMs/firstChunkKind, captured by wrapping modelOptions.fetchImplementation
// with src/evaluation/streamTiming.js's tap. This only fires on a REAL fetch call, so unlike the
// offline modelClient-based tests in testingCharterEvaluationBounded.test.ts, these tests drive
// the actual reviewWithBoundedInvestigation -> callOpenRouterChat streaming path with a scripted
// SSE Response, not a scripted modelClient.
const {
  evaluateTestingCharter, reviewWithBoundedInvestigation,
} = await import('../../scripts/evaluate-testing-charter.mjs');

const matrix = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/testing-charter/evaluation-matrix.json'), 'utf8'));
const persona = pipeline.PERSONA_CHARTERS.find((entry: { id: string }) => entry.id === matrix.personaId);
const defectFixture = matrix.fixtures.find((fixture: { category: string }) => fixture.category === 'defect');
const cleanFixture = matrix.fixtures.find((fixture: { category: string }) => fixture.category === 'clean');

function sseChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ model: 'test/model', provider: 'TestProvider', choices: [{ delta }], ...extra })}\n\n`;
}

/** A real ReadableStream-backed Response -- required for streamTiming's `response.body.tee()` tap. */
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

/** A bounded-contract COMPLETE turn with no findings -- content only matters here as a valid,
 * parseable turn so the row completes without erroring; TTFT timing is what's under test. */
function boundedCompletionContent(): string {
  return JSON.stringify({ review_status: 'COMPLETE', risk_plan: [], evidence_requests: [], risk_dispositions: [], findings: [] });
}

describe('evaluate-testing-charter.mjs TTFT instrumentation (real streaming path, no modelClient)', () => {
  it('records firstChunkMs (reasoning) and a strictly-later firstContentMs on a real bounded-investigation SSE call', async () => {
    const fetchImplementation = fakeSseFetch([
      { text: sseChunk({ reasoning: 'thinking about the fixture...' }), delayMs: 5 },
      { text: sseChunk({ content: boundedCompletionContent() }), delayMs: 15 },
    ]);

    const { rows } = await evaluateTestingCharter(
      { ...matrix, fixtures: [defectFixture] },
      {
        repetitions: 1,
        concurrency: 1,
        arms: [{ id: 'offline', persona, charter: persona.charter }],
        reviewWithModel: reviewWithBoundedInvestigation,
        modelOptions: { fetchImplementation, apiKey: 'test-key', model: 'test/model', maxAttempts: 1, timeoutMs: 5_000 },
      },
    );

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.errored).toBe(false);
    expect(row.firstChunkKind).toBe('reasoning');
    expect(row.firstChunkMs).toEqual(expect.any(Number));
    expect(row.firstContentMs).toEqual(expect.any(Number));
    // The reasoning chunk arrived first; content followed strictly later -- the gap streamTiming
    // exists to surface.
    expect(row.firstContentMs).toBeGreaterThan(row.firstChunkMs);
  });

  it('leaves firstChunkMs/firstContentMs null for an offline modelClient-driven row (nothing to tap)', async () => {
    const modelClient = async () => ({ ok: true, content: boundedCompletionContent() });
    const { rows } = await evaluateTestingCharter(
      { ...matrix, fixtures: [cleanFixture] },
      {
        repetitions: 1,
        concurrency: 1,
        arms: [{ id: 'offline', persona, charter: persona.charter }],
        reviewWithModel: reviewWithBoundedInvestigation,
        modelOptions: { modelClient },
      },
    );
    expect(rows[0].firstChunkMs).toBeNull();
    expect(rows[0].firstContentMs).toBeNull();
    expect(rows[0].firstChunkKind).toBeNull();
  });
});
