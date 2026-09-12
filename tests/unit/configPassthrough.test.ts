import { describe, expect, it } from 'vitest';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { actionDispatchRequestSchema } from '../../src/review/actionDispatch';
import { buildDispatchRequest } from '../../scripts/dispatch-doks-action.mjs';

// Unit test suite verifying hierarchical passthrough of skills, knowledge, metrics,
// and retry analysis configurations across .ct-review.yaml, Action inputs, and DOKS dispatch.
describe('configuration passthrough for skills, knowledge, metrics, and retry analysis', () => {
  it('preserves top-level skills, knowledge, metrics, and retry_analysis from YAML', () => {
    const yaml = `
version: 3
profile: balanced
quorum: 1
skills:
  - name: cisco-cdr-triage
    level: expert
  - name: security-boundary-audit
knowledge:
  sources:
    - knowledge/adr/0564-review-completion-events-admit-ci-without-runner-polling.md
    - docs/telecom-cdr-spec.md
metrics:
  prometheus_scrape_port: 3000
  otel_endpoint: "http://otel-collector.observability:4318/v1/metrics"
retry_analysis:
  track_failure_classes: true
  max_retries: 2
knowledge_base:
  learnings: true
  custom_sources: ["knowledge/review-learnings/"]
dials:
  memory_engine: true
  retro_triage_enabled: true
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [synthetic]
    skills: ["owasp-top-10", "k8s-rbac-audit"]
    knowledge: ["knowledge/security/"]
    tools: ["ct-impact", "context7"]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: synthetic
      enabled: true
      model: deepseek/deepseek-v4-flash-0731:low
      effort: low
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [synthetic]
`;
    const config = parseAndValidateConfig(yaml) as any;
    expect(config.version).toBe(3);
    expect(config.skills).toEqual([
      { name: 'cisco-cdr-triage', level: 'expert' },
      { name: 'security-boundary-audit' },
    ]);
    expect(config.knowledge.sources).toHaveLength(2);
    expect(config.metrics.prometheus_scrape_port).toBe(3000);
    expect(config.retry_analysis.max_retries).toBe(2);
    expect(config.knowledge_base.custom_sources).toEqual(['knowledge/review-learnings/']);
    expect(config.dials.retro_triage_enabled).toBe(true);

    const sec = config.personas.find((p: any) => p.id === 'sec-lane');
    expect(sec.skills).toEqual(['owasp-top-10', 'k8s-rbac-audit']);
    expect(sec.knowledge).toEqual(['knowledge/security/']);
    expect(sec.tools).toEqual(['ct-impact', 'context7']);
  });

  it('validates actionDispatchRequestSchema with passthrough policy options', () => {
    const request = {
      version: 'ActionDispatch.v1',
      deliveryId: 'actions:12345:1:4385771:100:e'.padEnd(48, '0'),
      repositoryId: 4385771,
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      prNumber: 100,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      actionSha: 'c'.repeat(40),
      publishMode: 'app-gate',
      requestedAt: new Date().toISOString(),
      caller: {
        runId: '12345',
        runAttempt: 1,
        eventName: 'pull_request_target',
      },
      policy: {
        personas: 'architecture,security',
        maxInvestigationTurns: 10,
        laneCallBudget: 25,
        skills: ['ast-parser', 'db-migration-verifier'],
        knowledge: { adr: ['0564', '0541'] },
        metrics: { telemetryEnabled: true },
        retryAnalysis: { enableQuarantine: true },
      },
    };

    const parsed = actionDispatchRequestSchema.safeParse(request);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.policy?.skills).toEqual(['ast-parser', 'db-migration-verifier']);
      expect((parsed.data.policy as any)?.knowledge).toEqual({ adr: ['0564', '0541'] });
      expect((parsed.data.policy as any)?.metrics).toEqual({ telemetryEnabled: true });
    }
  });

  it('buildDispatchRequest passes through skills, knowledge, metrics, and retryAnalysis from environment', () => {
    const env = {
      REPOSITORY: 'calltelemetry/cisco-cdr',
      REPOSITORY_ID: '12345',
      PR_NUMBER: '5006',
      HEAD_SHA: 'a'.repeat(40),
      BASE_SHA: 'b'.repeat(40),
      ACTION_SHA: 'c'.repeat(40),
      GITHUB_RUN_ID: '987654',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'pull_request_target',
      DOKS_PUBLISH_MODE: 'app-gate',
      PERSONAS: 'security,performance',
      SKILLS: '["cisco-xcc", "jtapi-expert"]',
      KNOWLEDGE: 'knowledge/review-learnings/',
      METRICS: '{"promPort": 3000}',
      RETRY_ANALYSIS: '{"maxRetries": 1}',
    };

    const request = buildDispatchRequest(env);
    expect(request.policy).toBeDefined();
    expect(request.policy?.personas).toBe('security,performance');
    expect(request.policy?.skills).toBe('["cisco-xcc", "jtapi-expert"]');
    expect(request.policy?.knowledge).toBe('knowledge/review-learnings/');
    expect(request.policy?.metrics).toBe('{"promPort": 3000}');
    expect(request.policy?.retryAnalysis).toBe('{"maxRetries": 1}');
  });

  it('buildDispatchRequest resolves fallback POLICY_* environment variables', () => {
    const env = {
      REPOSITORY: 'calltelemetry/cisco-cdr',
      REPOSITORY_ID: '12345',
      PR_NUMBER: '5006',
      HEAD_SHA: 'a'.repeat(40),
      BASE_SHA: 'b'.repeat(40),
      ACTION_SHA: 'c'.repeat(40),
      GITHUB_RUN_ID: '987654',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'pull_request_target',
      DOKS_PUBLISH_MODE: 'app-gate',
      POLICY_SKILLS: 'fallback-skill',
      POLICY_KNOWLEDGE: 'fallback-knowledge',
      POLICY_METRICS: 'fallback-metrics',
      POLICY_RETRY_ANALYSIS: 'fallback-retry',
    };

    const request = buildDispatchRequest(env);
    expect(request.policy).toBeDefined();
    expect(request.policy?.skills).toBe('fallback-skill');
    expect(request.policy?.knowledge).toBe('fallback-knowledge');
    expect(request.policy?.metrics).toBe('fallback-metrics');
    expect(request.policy?.retryAnalysis).toBe('fallback-retry');
  });

  it('buildDispatchRequest ensures primary inputs override fallback POLICY_* variables', () => {
    const env = {
      REPOSITORY: 'calltelemetry/cisco-cdr',
      REPOSITORY_ID: '12345',
      PR_NUMBER: '5006',
      HEAD_SHA: 'a'.repeat(40),
      BASE_SHA: 'b'.repeat(40),
      ACTION_SHA: 'c'.repeat(40),
      GITHUB_RUN_ID: '987654',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'pull_request_target',
      DOKS_PUBLISH_MODE: 'app-gate',
      SKILLS: 'primary-skill',
      POLICY_SKILLS: 'fallback-skill',
      KNOWLEDGE: 'primary-knowledge',
      POLICY_KNOWLEDGE: 'fallback-knowledge',
    };

    const request = buildDispatchRequest(env);
    expect(request.policy?.skills).toBe('primary-skill');
    expect(request.policy?.knowledge).toBe('primary-knowledge');
  });

  it('buildDispatchRequest handles POLICY_JSON parsing, merging, and precedence', () => {
    const baseEnv = {
      REPOSITORY: 'calltelemetry/cisco-cdr',
      REPOSITORY_ID: '12345',
      PR_NUMBER: '5006',
      HEAD_SHA: 'a'.repeat(40),
      BASE_SHA: 'b'.repeat(40),
      ACTION_SHA: 'c'.repeat(40),
      GITHUB_RUN_ID: '987654',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'pull_request_target',
      DOKS_PUBLISH_MODE: 'app-gate',
    };

    // 1. Valid object parsed and explicit input overrides POLICY_JSON key
    const valid = buildDispatchRequest({
      ...baseEnv,
      POLICY_JSON: JSON.stringify({ customKey: 'customVal', personas: 'overridden-persona' }),
      PERSONAS: 'authoritative-persona',
    });
    expect(valid.policy).toBeDefined();
    expect(valid.policy?.customKey).toBe('customVal');
    expect(valid.policy?.personas).toBe('authoritative-persona');

    // 2. Throws on malformed JSON
    expect(() => buildDispatchRequest({ ...baseEnv, POLICY_JSON: '{invalid-json' })).toThrow(/Invalid policy-json/);

    // 3. Throws on JSON array
    expect(() => buildDispatchRequest({ ...baseEnv, POLICY_JSON: '[1, 2, 3]' })).toThrow(/must be a valid JSON object/);
  });

  it('buildDispatchRequest sets policy to undefined when no policy inputs are supplied', () => {
    const env = {
      REPOSITORY: 'calltelemetry/cisco-cdr',
      REPOSITORY_ID: '12345',
      PR_NUMBER: '5006',
      HEAD_SHA: 'a'.repeat(40),
      BASE_SHA: 'b'.repeat(40),
      ACTION_SHA: 'c'.repeat(40),
      GITHUB_RUN_ID: '987654',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'pull_request_target',
      DOKS_PUBLISH_MODE: 'app-gate',
    };

    const request = buildDispatchRequest(env);
    expect(request.policy).toBeUndefined();
  });
});
