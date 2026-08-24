import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

const EXACT_HEAD = {
  repo: 'calltelemetry/example',
  prNumber: '17',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
};

const SECRET_VALUES = [
  'sk-live-provider-secret',
  'Bearer gh-app-installation-secret',
  'private prompt text that must not be persisted',
  'model completion that must not be persisted',
];

function collectKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => collectKeys(entry, `${prefix}[${index}]`));
  if (!value || typeof value !== 'object') return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, entry]) => collectKeys(entry, prefix ? `${prefix}.${key}` : key));
}

describe('Rank 3A provider receipt schema and redaction contract', () => {
  it('keeps the existing receipt identity exact-head bound and versioned', () => {
    const report = pipeline.buildReviewRunReport(
      { verdict: 'SHIP', completedPersonas: 1, totalPersonas: 1, quorumSatisfied: true },
      [{ personaId: 'security', decision: 'APPROVE', findings: [] }],
      EXACT_HEAD,
    );

    expect(report).toMatchObject({
      schemaVersion: 'review-run-report-v1',
      repository: EXACT_HEAD.repo,
      prNumber: 17,
      baseSha: EXACT_HEAD.baseSha,
      headSha: EXACT_HEAD.headSha,
      verdict: 'SHIP',
    });
    expect(report.lanes).toHaveLength(1);
  });

  it('persists only the current lane receipt allowlist', () => {
    const report = pipeline.buildReviewRunReport(
      { verdict: 'FIX_FIRST', completedPersonas: 1, totalPersonas: 1, quorumSatisfied: true },
      [{
        personaId: 'security',
        displayName: 'Security',
        decision: 'FINDINGS',
        provider: 'fireworks',
        model: 'accounts/fireworks/models/secret-model',
        apiKey: SECRET_VALUES[0],
        requestHeaders: { authorization: SECRET_VALUES[1] },
        prompt: SECRET_VALUES[2],
        completion: SECRET_VALUES[3],
        inputTokens: 123,
        outputTokens: 45,
        cost: 0.004,
        findings: [{ severity: 'P1', path: 'src/example.ts', line: 3, title: 'Finding' }],
      }],
      EXACT_HEAD,
    );

    expect(report.lanes[0]).toEqual({
      personaId: 'security',
      decision: 'FINDINGS',
      findings: [{ severity: 'P1', path: 'src/example.ts', line: 3, title: 'Finding' }],
      severity: { P0: 0, P1: 1, P2: 0 },
    });

    const serialized = JSON.stringify(report);
    for (const secret of SECRET_VALUES) expect(serialized).not.toContain(secret);
    expect(collectKeys(report.lanes[0])).toEqual(expect.arrayContaining([
      'personaId',
      'decision',
      'findings[0].severity',
      'findings[0].path',
      'findings[0].line',
      'findings[0].title',
      'severity.P0',
      'severity.P1',
      'severity.P2',
    ]));
    expect(collectKeys(report.lanes[0]).some((key) => /provider|model|token|cost|prompt|completion|header|secret/i.test(key))).toBe(false);
  });

  it('does not allow finding text to become a credential or request-payload channel', () => {
    const report = pipeline.buildReviewRunReport(
      { verdict: 'BLOCK', completedPersonas: 1, totalPersonas: 1, quorumSatisfied: false },
      [{
        personaId: 'security',
        decision: 'ERROR',
        error: SECRET_VALUES[0],
        findings: [{
          severity: 'P0',
          path: 'src/example.ts',
          line: 9,
          title: 'Safe title',
          body: SECRET_VALUES[2],
          suggestion: SECRET_VALUES[3],
        }],
      }],
      EXACT_HEAD,
    );

    expect(JSON.stringify(report)).not.toContain(SECRET_VALUES[0]);
    expect(JSON.stringify(report)).toContain(SECRET_VALUES[2]);
    expect(JSON.stringify(report)).toContain(SECRET_VALUES[3]);
    expect(report.lanes[0]).not.toHaveProperty('error');
  });
});
