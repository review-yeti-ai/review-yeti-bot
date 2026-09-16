import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initTelemetry,
  getMetrics,
  getPrometheusMetrics,
  getRecentSpans,
  clearSpans,
} from '../../src/telemetry';
import { executePersonaPanel, extractMessageContentText } from '../../src/panel/panelEngine';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { logger } from '../../src/utils/logger';
import * as zoektModule from '../../src/services/zoektPreCheckService';
import * as analyzerModule from '../../src/sandbox/analyzerRunner';

function metricSampleValue(text: string, sample: string): number | null {
  const line = text.split('\n').find((entry) => entry.startsWith(`${sample} `));
  if (!line) return null;
  return Number(line.slice(sample.length + 1));
}

function requestNonce(request: any): string {
  const text = (request.messages || [])
    .map((m: any) => extractMessageContentText(m.content))
    .join('\n');
  const match = text.match(/CT_REVIEW_NONCE:([^\n\s]+)/u);
  return match ? match[1].trim() : 'nonce';
}

function createMockOmniRouteClient() {
  return {
    complete: vi.fn().mockImplementation(async (request: any) => {
      const role = request.metadata?.role;
      const nonce = requestNonce(request);
      let payload: any;
      if (role === 'persona') {
        payload = { decision: 'APPROVE', findings: [] };
      } else if (role === 'moderator') {
        payload = { decision: 'RECONCILED', findings: [] };
      } else if (role === 'arbiter') {
        payload = { verdict: 'SHIP', rationale: 'All clean' };
      } else {
        payload = { decision: 'APPROVE', findings: [] };
      }
      return {
        model: request.model || 'test-model',
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(payload)}\nCT_REVIEW_END:${nonce}`,
        usage: { prompt: 100, completion: 20, total: 120 },
        costUSD: 0.001,
        raw: {},
      };
    }),
  };
}

describe('Pre-Checks Production Telemetry & Structured Logging (review_yeti namespace)', () => {
  beforeEach(() => {
    initTelemetry('review-yeti-bot');
    clearSpans();
    vi.restoreAllMocks();
  });

  it('exposes all review_yeti pre-check metrics with zero baseline in Prometheus output', async () => {
    const text = await getPrometheusMetrics();

    // Zoekt pre-checks metrics
    expect(text).toContain('# HELP review_yeti_zoekt_queries_total Total Zoekt search queries dispatched.');
    expect(text).toContain('# TYPE review_yeti_zoekt_queries_total counter');
    expect(text).toContain('review_yeti_zoekt_queries_total 0');

    expect(text).toContain('# HELP review_yeti_zoekt_duration_seconds Zoekt query pool execution duration in seconds.');
    expect(text).toContain('# TYPE review_yeti_zoekt_duration_seconds histogram');

    expect(text).toContain('# HELP review_yeti_zoekt_symbols_scanned_total Candidate symbols extracted from diffs.');
    expect(text).toContain('# TYPE review_yeti_zoekt_symbols_scanned_total counter');
    expect(text).toContain('review_yeti_zoekt_symbols_scanned_total 0');

    expect(text).toContain('# HELP review_yeti_zoekt_symbols_matched_total Cross-file symbols discovered via Zoekt.');
    expect(text).toContain('# TYPE review_yeti_zoekt_symbols_matched_total counter');
    expect(text).toContain('review_yeti_zoekt_symbols_matched_total 0');

    expect(text).toContain('# HELP review_yeti_zoekt_truncated_total Zoekt pre-check executions clamped by max_symbols.');
    expect(text).toContain('# TYPE review_yeti_zoekt_truncated_total counter');
    expect(text).toContain('review_yeti_zoekt_truncated_total 0');

    // Analyzers pre-checks metrics
    expect(text).toContain('# HELP review_yeti_analyzers_executed_total Total static analyzer invocations tagged by tool.');
    expect(text).toContain('# TYPE review_yeti_analyzers_executed_total counter');
    expect(text).toContain('review_yeti_analyzers_executed_total 0');

    expect(text).toContain('# HELP review_yeti_analyzers_duration_seconds Sandbox analyzer runner latency in seconds.');
    expect(text).toContain('# TYPE review_yeti_analyzers_duration_seconds histogram');

    expect(text).toContain('# HELP review_yeti_analyzer_hypotheses_total Candidate hypotheses generated tagged by tool, category, and severity.');
    expect(text).toContain('# TYPE review_yeti_analyzer_hypotheses_total counter');
    expect(text).toContain('review_yeti_analyzer_hypotheses_total 0');

    // Combined pre-checks duration
    expect(text).toContain('# HELP review_yeti_pre_checks_duration_seconds Combined pre-checks latency in seconds.');
    expect(text).toContain('# TYPE review_yeti_pre_checks_duration_seconds histogram');

    // Ensure strictly NO ct_ prefixes for pre-check metrics
    expect(text).not.toContain('ct_zoekt');
    expect(text).not.toContain('ct_analyzer');
    expect(text).not.toContain('ct_pre_checks');
  });

  it('records Zoekt and Analyzer counters and histograms under review_yeti_ namespace', async () => {
    const metrics = getMetrics();

    metrics.zoektQueries.add(14, { repository: 'org/repo', status: 'ok' });
    metrics.zoektSymbolsScanned.add(42, { repository: 'org/repo' });
    metrics.zoektSymbolsMatched.add(35, { repository: 'org/repo' });
    metrics.zoektTruncatedTotal.add(1, { repository: 'org/repo' });
    metrics.zoektDuration.record(0.125, { repository: 'org/repo', status: 'ok' });

    metrics.analyzersExecuted.add(1, { repository: 'org/repo', tool: 'eslint', status: 'ok' });
    metrics.analyzersExecuted.add(1, { repository: 'org/repo', tool: 'semgrep', status: 'ok' });
    metrics.analyzersDuration.record(0.45, { repository: 'org/repo', status: 'ok' });
    metrics.analyzerHypotheses.add(3, {
      repository: 'org/repo',
      tool: 'semgrep',
      category: 'security',
      severity: 'warning',
    });
    metrics.preCheckTotalDuration.record(0.55, { repository: 'org/repo', enabled: 'true' });

    const text = await getPrometheusMetrics();

    expect(metricSampleValue(text, 'review_yeti_zoekt_queries_total{repository="org/repo",status="ok"}')).toBe(14);
    expect(metricSampleValue(text, 'review_yeti_zoekt_symbols_scanned_total{repository="org/repo"}')).toBe(42);
    expect(metricSampleValue(text, 'review_yeti_zoekt_symbols_matched_total{repository="org/repo"}')).toBe(35);
    expect(metricSampleValue(text, 'review_yeti_zoekt_truncated_total{repository="org/repo"}')).toBe(1);
    expect(metricSampleValue(text, 'review_yeti_zoekt_duration_seconds_count{repository="org/repo",status="ok"}')).toBe(1);

    expect(metricSampleValue(text, 'review_yeti_analyzers_executed_total{repository="org/repo",tool="eslint",status="ok"}')).toBe(1);
    expect(metricSampleValue(text, 'review_yeti_analyzers_executed_total{repository="org/repo",tool="semgrep",status="ok"}')).toBe(1);
    expect(metricSampleValue(text, 'review_yeti_analyzer_hypotheses_total{repository="org/repo",tool="semgrep",category="security",severity="warning"}')).toBe(3);
    expect(metricSampleValue(text, 'review_yeti_pre_checks_duration_seconds_count{repository="org/repo",enabled="true"}')).toBe(1);
  });

  it('records review_yeti.pre_checks.* span attributes and structured logs during executePersonaPanel', async () => {
    const loggerInfoSpy = vi.spyOn(logger, 'info');

    // Mock Zoekt pre-check execution
    vi.spyOn(zoektModule, 'executeZoektPreCheck').mockResolvedValue({
      status: 'ok',
      scannedSymbolsCount: 10,
      matchedSymbolsCount: 8,
      symbols: [
        {
          symbol: 'validateAuthToken',
          sourcePath: 'src/auth.ts',
          isModifiedDefinition: true,
          definitions: [{ path: 'src/auth.ts', line: 12, text: 'export function validateAuthToken' }],
          callSites: [{ path: 'src/middleware.ts', line: 45, text: 'validateAuthToken(req)' }],
        },
      ],
      receipt: {
        totalQueries: 5,
        durationMs: 42,
        truncated: false,
      },
    });

    // Mock Analyzer pre-check execution
    vi.spyOn(analyzerModule, 'runPreCheckAnalyzers').mockResolvedValue({
      enabled: true,
      analyzersExecuted: 2,
      hypothesesCount: 1,
      durationMs: 85,
      status: 'ok',
      receipts: [
        {
          tool: 'eslint',
          category: 'linter',
          available: true,
          exitStatus: 0,
          durationMs: 40,
          hypotheses: [],
        },
        {
          tool: 'semgrep',
          category: 'security',
          available: true,
          exitStatus: 0,
          durationMs: 45,
          hypotheses: [
            {
              id: 'hyp:semgrep:sec-1:src/auth.ts:15',
              analyzer: 'semgrep',
              category: 'security',
              ruleId: 'sec-1',
              path: 'src/auth.ts',
              line: 15,
              message: 'Potential timing attack in token comparison',
              severity: 'warning',
              confidence: 'high',
            },
          ],
        },
      ],
      hypotheses: [
        {
          id: 'hyp:semgrep:sec-1:src/auth.ts:15',
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'sec-1',
          path: 'src/auth.ts',
          line: 15,
          message: 'Potential timing attack in token comparison',
          severity: 'warning',
          confidence: 'high',
        },
      ],
    });

    const config = ctReviewConfigV3Schema.parse({
      ...createDefaultV3Config(),
      quorum: 1,
      personas: [
        {
          id: 'sec-reviewer',
          enabled: true,
          required: true,
          charter: 'builtin:security',
          paths: ['src/**'],
          providers: ['synthetic'],
          maxTurns: 1,
        },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 15,
        providers: [
          {
            id: 'synthetic',
            enabled: true,
            model: 'test-model',
            effort: 'low',
            review_timeout_s: 10,
            arbiter_timeout_s: 10,
          },
        ],
        arbiter: { order: ['synthetic'] },
      },
      pre_checks: {
        enabled: true,
        zoekt: { enabled: true, max_symbols: 200 },
        analyzers: { enabled: true, linters: true, security: true, secrets: true },
      },
    });

    const mockClient = createMockOmniRouteClient();

    const result = await executePersonaPanel({
      config,
      changedFiles: [
        {
          path: 'src/auth.ts',
          patch: '@@ -10,4 +10,6 @@\n+export function validateAuthToken() {}',
          content: 'export function validateAuthToken() {}',
        },
      ],
      repository: 'calltelemetry/review-yeti',
      headSha: 'abc1234567890',
      client: mockClient as any,
    });

    expect(result).toBeDefined();

    // Verify OpenTelemetry spans and attributes
    const spans = getRecentSpans();
    const panelSpan = spans.find((s) => s.name === 'review_yeti_panel');
    expect(panelSpan).toBeDefined();

    // Check review_yeti pre-check span attributes
    expect(panelSpan?.attributes['review_yeti.pre_checks.enabled']).toBe(true);
    expect(panelSpan?.attributes['review_yeti.pre_checks.duration_ms']).toBeGreaterThanOrEqual(0);
    expect(panelSpan?.attributes['review_yeti.pre_checks.zoekt.status']).toBe('ok');
    expect(panelSpan?.attributes['review_yeti.pre_checks.zoekt.scanned_symbols']).toBe(10);
    expect(panelSpan?.attributes['review_yeti.pre_checks.zoekt.matched_symbols']).toBe(8);
    expect(panelSpan?.attributes['review_yeti.pre_checks.zoekt.queries_count']).toBe(5);
    expect(panelSpan?.attributes['review_yeti.pre_checks.zoekt.hit_rate_pct']).toBe(80);
    expect(panelSpan?.attributes['review_yeti.pre_checks.zoekt.truncated']).toBe(false);

    expect(panelSpan?.attributes['review_yeti.pre_checks.analyzers.status']).toBe('ok');
    expect(panelSpan?.attributes['review_yeti.pre_checks.analyzers.executed_count']).toBe(2);
    expect(panelSpan?.attributes['review_yeti.pre_checks.analyzers.hypotheses_count']).toBe(1);

    // Ensure NO ct.pre_checks attributes were added
    const ctPreCheckKeys = Object.keys(panelSpan?.attributes || {}).filter((k) => k.startsWith('ct.pre_checks'));
    expect(ctPreCheckKeys).toHaveLength(0);

    // Verify structured production logs
    const zoektLogCall = loggerInfoSpy.mock.calls.find((call) =>
      call[0] === 'Pre-check Zoekt symbol discovery completed'
    );
    expect(zoektLogCall).toBeDefined();
    expect(zoektLogCall?.[1]).toMatchObject({
      repository: 'calltelemetry/review-yeti',
      headSha: 'abc1234567890',
      status: 'ok',
      scannedSymbols: 10,
      matchedSymbols: 8,
      totalQueries: 5,
      truncated: false,
      hitRate: 80,
    });

    const analyzersLogCall = loggerInfoSpy.mock.calls.find((call) =>
      call[0] === 'Pre-check sandbox static analyzers completed'
    );
    expect(analyzersLogCall).toBeDefined();
    expect(analyzersLogCall?.[1]).toMatchObject({
      repository: 'calltelemetry/review-yeti',
      headSha: 'abc1234567890',
      status: 'ok',
      executedCount: 2,
      hypothesesCount: 1,
    });
  });

  it('increments review_yeti_zoekt_truncated_total when pre-checks are truncated by max_symbols', async () => {
    vi.spyOn(zoektModule, 'executeZoektPreCheck').mockResolvedValue({
      status: 'ok',
      scannedSymbolsCount: 250,
      matchedSymbolsCount: 200,
      symbols: [],
      receipt: {
        totalQueries: 200,
        durationMs: 150,
        truncated: true,
      },
    });

    vi.spyOn(analyzerModule, 'runPreCheckAnalyzers').mockResolvedValue({
      enabled: true,
      analyzersExecuted: 0,
      hypothesesCount: 0,
      durationMs: 10,
      status: 'clean',
      receipts: [],
      hypotheses: [],
    });

    const config = ctReviewConfigV3Schema.parse({
      ...createDefaultV3Config(),
      quorum: 1,
      personas: [
        {
          id: 'perf-reviewer',
          enabled: true,
          required: true,
          charter: 'builtin:performance',
          paths: ['src/**'],
          providers: ['synthetic'],
          maxTurns: 1,
        },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 15,
        providers: [
          {
            id: 'synthetic',
            enabled: true,
            model: 'test-model',
            effort: 'low',
            review_timeout_s: 10,
            arbiter_timeout_s: 10,
          },
        ],
        arbiter: { order: ['synthetic'] },
      },
      pre_checks: {
        enabled: true,
        zoekt: { enabled: true, max_symbols: 200 },
        analyzers: { enabled: true },
      },
    });

    const mockClient = createMockOmniRouteClient();

    await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/main.ts', patch: '+test', content: 'test' }],
      repository: 'calltelemetry/review-yeti',
      headSha: 'trunc-sha',
      client: mockClient as any,
    });

    const spans = getRecentSpans();
    const panelSpan = spans.find((s) => s.name === 'review_yeti_panel');
    expect(panelSpan?.attributes['review_yeti.pre_checks.zoekt.truncated']).toBe(true);

    const text = await getPrometheusMetrics();
    expect(metricSampleValue(text, 'review_yeti_zoekt_truncated_total{repository="calltelemetry/review-yeti"}')).toBeGreaterThanOrEqual(1);
  });

  it('fails soft on Zoekt/Analyzer errors and records unavailable status without aborting panel', async () => {
    vi.spyOn(zoektModule, 'executeZoektPreCheck').mockRejectedValue(new Error('Zoekt connection refused'));
    vi.spyOn(analyzerModule, 'runPreCheckAnalyzers').mockRejectedValue(new Error('Sandbox runner failure'));

    const config = ctReviewConfigV3Schema.parse({
      ...createDefaultV3Config(),
      quorum: 1,
      personas: [
        {
          id: 'sec-reviewer',
          enabled: true,
          required: true,
          charter: 'builtin:security',
          paths: ['src/**'],
          providers: ['synthetic'],
          maxTurns: 1,
        },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 15,
        providers: [
          {
            id: 'synthetic',
            enabled: true,
            model: 'test-model',
            effort: 'low',
            review_timeout_s: 10,
            arbiter_timeout_s: 10,
          },
        ],
        arbiter: { order: ['synthetic'] },
      },
      pre_checks: {
        enabled: true,
        zoekt: { enabled: true },
        analyzers: { enabled: true },
      },
    });

    const mockClient = createMockOmniRouteClient();

    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/main.ts', patch: '+test', content: 'test' }],
      repository: 'calltelemetry/review-yeti',
      headSha: 'fail-soft-sha',
      client: mockClient as any,
    });

    expect(result).toBeDefined();
    expect(result.arbiter.verdict).toBe('SHIP');

    const spans = getRecentSpans();
    const panelSpan = spans.find((s) => s.name === 'review_yeti_panel');
    expect(panelSpan?.attributes['review_yeti.pre_checks.zoekt.status']).toBe('unavailable');
    expect(panelSpan?.attributes['review_yeti.pre_checks.analyzers.status']).toBe('unavailable');
  });
});
