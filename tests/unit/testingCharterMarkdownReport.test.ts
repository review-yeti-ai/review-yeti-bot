import { describe, expect, it } from 'vitest';

const { summarizeArm, summarizePerFixture, renderMarkdownReport, renderMarkdownReports } = await import('../../scripts/evaluate-testing-charter.mjs');

const fixtures = [
  { id: 'seeded-defect', category: 'defect' },
  { id: 'clean-control', category: 'clean' },
];

function baseRows() {
  return [
    { arm: 'baseline', fixtureId: 'seeded-defect', category: 'defect', errored: false, detected: true, anchored: true, findings: 1, hits: 1, validSuggestions: 0, noise: 0, latencyMs: 5000, firstChunkMs: 800, firstChunkKind: 'reasoning', firstContentMs: 4200, usage: { promptTokens: 1000, completionTokens: 200, costUSD: 0.01 } },
    { arm: 'baseline', fixtureId: 'clean-control', category: 'clean', errored: false, falsePositive: false, findings: 0, hits: 0, validSuggestions: 0, noise: 0, latencyMs: 3000, firstChunkMs: 600, firstChunkKind: 'content', firstContentMs: 600, usage: { promptTokens: 900, completionTokens: 50, costUSD: 0.004 } },
    { arm: 'candidate', fixtureId: 'seeded-defect', category: 'defect', errored: false, detected: true, anchored: true, findings: 2, hits: 1, validSuggestions: 1, noise: 0, latencyMs: 6200, firstChunkMs: 700, firstChunkKind: 'reasoning', firstContentMs: 5300, usage: { promptTokens: 1100, completionTokens: 260, costUSD: 0.012 } },
    { arm: 'candidate', fixtureId: 'clean-control', category: 'clean', errored: true, error: 'malformed_response', falsePositive: false, findings: 0, hits: 0, validSuggestions: 0, noise: 0, latencyMs: 9000, firstChunkMs: null, firstChunkKind: null, firstContentMs: null, usage: {} },
  ];
}

function buildReport() {
  const rows = baseRows();
  return {
    schemaVersion: 'testing-charter-eval-report-v1',
    fixture: 'tests/fixtures/testing-charter/evaluation-matrix.json',
    model: 'test/model',
    path: 'bounded',
    maxTokens: null,
    repetitions: 1,
    arms: [summarizeArm(rows, 'baseline'), summarizeArm(rows, 'candidate')],
    perFixture: summarizePerFixture(rows, fixtures),
  };
}

describe('renderMarkdownReport', () => {
  it('renders a GitHub-flavored markdown table with detection rate+CI, FP rate, SNR, errored/N with failure class, and the TTFT columns', () => {
    const markdown = renderMarkdownReport(buildReport());

    expect(markdown).toContain('## Testing-charter evaluation');
    expect(markdown).toContain('Detection rate (recall)');
    expect(markdown).toContain('95% CI');
    expect(markdown).toContain('False-positive rate');
    expect(markdown).toContain('SNR ((hits+valid)/noise)');
    expect(markdown).toContain('Precision');
    // Errored/N with failure-class breakdown: candidate has one malformed_response error.
    expect(markdown).toContain('1/2 (malformed_response: 1)');
    // TTFB and first-content columns, both present and distinct from total latency.
    expect(markdown).toContain('TTFB ms, median / P95');
    expect(markdown).toContain('First-content ms, median / P95');
    expect(markdown).toContain('Total latency ms, median / P95');
    expect(markdown).toContain('First-chunk kind (reasoning/content/other)');
    // Per-fixture section present for both arms.
    expect(markdown).toContain('### Per-fixture detection');
    expect(markdown).toContain('seeded-defect');
    expect(markdown).toContain('clean-control');
  });

  it('never renders undefined/NaN — an unmeasured cell prints an explicit placeholder instead of fabricating a number', () => {
    // Every row in this arm is offline (no fetchImplementation call), so firstChunkMs/
    // firstContentMs are null for every row -- summarizeArm's median/p95 for those series must
    // come back null too, and the renderer must show that honestly, not print "NaN" or "undefined".
    const rows = [
      { arm: 'offline', fixtureId: 'seeded-defect', category: 'defect', errored: false, detected: true, anchored: true, findings: 1, hits: 1, validSuggestions: 0, noise: 0, latencyMs: 100, firstChunkMs: null, firstChunkKind: null, firstContentMs: null, usage: {} },
    ];
    const report = {
      fixture: 'x', model: 'm', path: 'bounded', maxTokens: null, repetitions: 1,
      arms: [summarizeArm(rows, 'offline')],
      perFixture: summarizePerFixture(rows, [{ id: 'seeded-defect', category: 'defect' }]),
    };
    const markdown = renderMarkdownReport(report);
    expect(markdown).not.toContain('undefined');
    expect(markdown).not.toContain('NaN');
    expect(markdown).toContain('— / — (N=0)'); // TTFB row: no measurements at all
  });

  it('renders "∞" (not Infinity, not a fabricated finite number) when SNR has zero noise and nonzero signal', () => {
    const markdown = renderMarkdownReport(buildReport());
    // baseline's seeded-defect run has 1 hit and 0 noise across the whole arm.
    expect(markdown).toMatch(/∞ \(0 noise, \d+ signal\)/);
    expect(markdown).not.toContain('Infinity');
  });

  it('renderMarkdownReports concatenates one section per corpus with a separator', () => {
    const reportA = buildReport();
    const reportB = { ...buildReport(), fixture: 'tests/fixtures/security-charter/evaluation-matrix.json' };
    const combined = renderMarkdownReports([reportA, reportB]);
    expect(combined).toContain('evaluation-matrix.json`');
    expect(combined).toContain('security-charter');
    expect(combined.split('---').length).toBeGreaterThan(1);
  });
});
