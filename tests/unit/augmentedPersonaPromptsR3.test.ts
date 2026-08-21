import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { RED_TEAM_CHARTER_DEFAULT } from '../../src/personas/redTeamPersona';

describe('R3: Augmented Default Persona Prompts & Domain Best Practices', () => {
  const testFile = '/tmp/test-augmented-prompts-r3.json';

  beforeEach(() => {
    if (fs.existsSync(testFile)) {
      try { fs.unlinkSync(testFile); } catch {}
    }
    dashboardStore.filePath = testFile;
  });

  it('seeds all 12 personas with augmented domain best practices in defaultData()', () => {
    const settings = dashboardStore.getSettings();
    const personas = settings.personaSettings || {};

    const standardIds = [
      'security', 'architecture', 'performance', 'quality', 'database',
      'api_contract', 'docs_compliance', 'reliability', 'devops', 'finops', 'red_team', 'review_flowchart'
    ];

    for (const id of standardIds) {
      expect(personas[id]).toBeDefined();
      expect(personas[id].id).toBe(id);
    }
  });

  it('Security Persona contains OWASP Top 10, Zod input sanitization, regex secrets scanning, and orgId/tenantId bounds', () => {
    const p = dashboardStore.getPersonaSetting('security')!;
    expect(p.customPrompt).toContain('OWASP Top 10');
    expect(p.customPrompt).toContain('Zod');
    expect(p.customPrompt).toContain('regex');
    expect(p.customPrompt).toContain('API keys, JWT, RSA keys, AWS tokens');
    expect(p.customPrompt).toContain('orgId/tenantId');
  });

  it('Architecture Persona contains coupling boundaries, DRY compliance, ADR alignment, circular dependency prevention', () => {
    const p = dashboardStore.getPersonaSetting('architecture')!;
    expect(p.customPrompt).toContain('Presentation -> Application -> Domain -> Infrastructure');
    expect(p.customPrompt).toContain('DRY');
    expect(p.customPrompt).toContain('ADR');
    expect(p.customPrompt).toContain('circular dependencies');
  });

  it('Performance Persona contains CPU/memory bottleneck, O(N^2) nested loop prevention, connection pool sizing, N+1 query detection', () => {
    const p = dashboardStore.getPersonaSetting('performance')!;
    expect(p.customPrompt).toContain('CPU and memory bottlenecks');
    expect(p.customPrompt).toContain('O(N^2)');
    expect(p.customPrompt).toContain('connection pool sizing');
    expect(p.customPrompt).toContain('N+1');
    expect(p.customPrompt).toContain('memory leak');
  });

  it('API Contract Persona contains non-breaking REST/GraphQL schema, backwards compatibility, deprecation headers, schema alignment', () => {
    const p = dashboardStore.getPersonaSetting('api_contract')!;
    expect(p.customPrompt).toContain('REST and GraphQL');
    expect(p.customPrompt).toContain('backwards compatibility');
    expect(p.customPrompt).toContain('deprecation headers');
    expect(p.customPrompt).toContain('Zod');
  });

  it('DevOps Persona contains K8s YAML standards (securityContext, probes, resource limits), Dockerfile multi-stage builds, non-root user', () => {
    const p = dashboardStore.getPersonaSetting('devops')!;
    expect(p.customPrompt).toContain('securityContext');
    expect(p.customPrompt).toContain('readinessProbe/livenessProbe');
    expect(p.customPrompt).toContain('CPU/RAM');
    expect(p.customPrompt).toContain('multi-stage builds');
    expect(p.customPrompt).toContain('non-root user');
  });

  it('Database Persona contains transaction isolation, index utilization, migration rollback safety, deadlock avoidance', () => {
    const p = dashboardStore.getPersonaSetting('database')!;
    expect(p.customPrompt).toContain('transaction isolation');
    expect(p.customPrompt).toContain('index utilization');
    expect(p.customPrompt).toContain('rollback safety');
    expect(p.customPrompt).toContain('deadlock avoidance');
  });

  it('Code Quality Persona contains code smells, complexity thresholds, exception handling, function length, naming conventions', () => {
    const p = dashboardStore.getPersonaSetting('quality')!;
    expect(p.customPrompt).toContain('code smells');
    expect(p.customPrompt).toContain('cyclomatic complexity');
    expect(p.customPrompt).toContain('exception handling');
    expect(p.customPrompt).toContain('function length');
    expect(p.customPrompt).toContain('naming conventions');
  });

  it('Docs Compliance Persona contains API doc completeness, inline JSDoc/TSDoc, README updates, changelog tracking', () => {
    const p = dashboardStore.getPersonaSetting('docs_compliance')!;
    expect(p.customPrompt).toContain('API doc completeness');
    expect(p.customPrompt).toContain('JSDoc/TSDoc');
    expect(p.customPrompt).toContain('README updates');
    expect(p.customPrompt).toContain('CHANGELOG.md');
  });

  it('Reliability (SRE) Persona contains circuit breakers, exponential backoff with jitter, graceful degradation, health check coverage', () => {
    const p = dashboardStore.getPersonaSetting('reliability')!;
    expect(p.customPrompt).toContain('circuit breaker');
    expect(p.customPrompt).toContain('exponential backoff');
    expect(p.customPrompt).toContain('jitter');
    expect(p.customPrompt).toContain('graceful degradation');
    expect(p.customPrompt).toContain('health check coverage');
  });

  it('FinOps Persona contains LLM token consumption optimization, AST diff scope filtering, prompt caching enablement, payload truncation', () => {
    const p = dashboardStore.getPersonaSetting('finops')!;
    expect(p.customPrompt).toContain('LLM token consumption');
    expect(p.customPrompt).toContain('AST diff scope filtering');
    expect(p.customPrompt).toContain('prompt caching enablement');
    expect(p.customPrompt).toContain('payload truncation');
  });

  it('Red Team Persona contains dual-model adversarial cross-examination, edge-case exploitation, security bypass detection', () => {
    const p = dashboardStore.getPersonaSetting('red_team')!;
    expect(p.customPrompt).toContain('dual-model adversarial cross-examination');
    expect(p.customPrompt).toContain('edge-case exploitation');
    expect(p.customPrompt).toContain('security bypass detection');
    expect(RED_TEAM_CHARTER_DEFAULT).toContain('dual-model adversarial cross-examination');
    expect(RED_TEAM_CHARTER_DEFAULT).toContain('edge-case exploitation');
    expect(RED_TEAM_CHARTER_DEFAULT).toContain('security bypass detection');
  });

  it('Review Flowchart Persona contains architecture diagram generation, valid Mermaid flowchart syntax, control flow visualization', () => {
    const p = dashboardStore.getPersonaSetting('review_flowchart')!;
    expect(p.customPrompt).toContain('architecture diagram generation');
    expect(p.customPrompt).toContain('valid Mermaid flowchart syntax');
    expect(p.customPrompt).toContain('control flow visualization');
  });
});
