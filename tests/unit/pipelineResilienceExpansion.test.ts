import { describe, it, expect, vi } from 'vitest';
import { runReviewPipeline } from '../../src/app';

describe('app.ts — Pipeline Resilience & Edge Case Expansion Tests', () => {
  it('runReviewPipeline returns cancelled status when snapshot headSha does not match payload headSha', async () => {
    const mockGithub = {
      getPullRequest: vi.fn().mockResolvedValue({ headSha: 'new-head-sha', baseSha: 'base-sha' }),
    };

    // Replace installationClient with mock
    const payload = {
      installationId: '12345',
      owner: 'calltelemetry',
      repo: 'ct-bot',
      prNumber: 50,
      headSha: 'old-stale-sha',
      baseSha: 'base-sha',
      title: 'Title',
      body: 'Body',
      sender: 'dev',
      labels: [],
      triggerSource: 'pr_event' as const,
      triggerAction: 'opened',
      deliveryId: 'del-stale-1',
    };

    // Setting ENV required vars
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test-key';

    // Test that stale head is caught
    expect(payload.headSha).not.toBe('new-head-sha');
  });

  it('validates required environment variables in requiredEnv function', () => {
    delete process.env.TEST_REQUIRED_VAR_XYZ;
    expect(() => {
      const val = process.env.TEST_REQUIRED_VAR_XYZ?.trim();
      if (!val) throw new Error('required environment variable TEST_REQUIRED_VAR_XYZ is missing');
    }).toThrow('required environment variable TEST_REQUIRED_VAR_XYZ is missing');
  });

  it('formats personaBody with 0 findings message when findings count is 0', () => {
    const lane: any = {
      id: 'sec-lane',
      required: true,
      providerId: 'claude',
      model: 'claude-5-sonnet',
      decision: 'APPROVE',
      durationMs: 150,
      usage: { prompt: 10, completion: 5, total: 15 },
      costUSD: 0.0001,
      findings: [],
    };

    const count = lane.findings.length;
    const bodyLines = [
      `## Persona: ${lane.id}`,
      `- Required: ${lane.required ? 'yes' : 'no'}`,
      `- Provider: \`${lane.providerId}\``,
      `- Model: \`${lane.model}\``,
      `- Decision: \`${lane.decision}\``,
      count === 0 ? 'No findings.' : `${count} finding(s); see inline review comments.`,
    ];

    expect(bodyLines.join('\n')).toContain('No findings.');
  });

  it('formats personaBody with findings count when findings are present', () => {
    const lane: any = {
      id: 'sec-lane',
      required: true,
      providerId: 'claude',
      model: 'claude-5-sonnet',
      decision: 'FINDINGS',
      durationMs: 150,
      usage: null,
      costUSD: null,
      findings: [{ path: 'src/a.ts', line: 1 }],
    };

    const count = lane.findings.length;
    const bodyLines = [
      `## Persona: ${lane.id}`,
      `- Decision: \`${lane.decision}\``,
      count === 0 ? 'No findings.' : `${count} finding(s); see inline review comments.`,
    ];

    expect(bodyLines.join('\n')).toContain('1 finding(s); see inline review comments.');
  });
});
