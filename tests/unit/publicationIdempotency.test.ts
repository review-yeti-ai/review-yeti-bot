import { describe, expect, it } from 'vitest';
import { CommentPublisher, PersonaFinding } from '../../src/github/commentPublisher';

const finding: PersonaFinding = { persona: 'security', severity: 'P1', filePath: 'src/a.ts', lineNumber: 2, comment: 'issue' };
const request = { owner: 'calltelemetry', repo: 'ct-review-bot', prNumber: 42, commitSha: 'a'.repeat(40), event: 'COMMENT' as const, body: 'review', inlineComments: [{ path: 'src/a.ts', line: 2, finding }], idempotencyKey: 'run-1' };

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('idempotent GitHub publication', () => {
  it('revalidates the exact head before a write', async () => {
    const requests: string[] = [];
    const publisher = new CommentPublisher({ githubToken: 'ghs_test', currentHeadSha: async () => 'b'.repeat(40), fetchImplementation: async (url) => { requests.push(String(url)); return response(200, []); } });
    const result = await publisher.publishReview(request);
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/head changed/i);
    expect(requests).toHaveLength(2); // marker lookups happen before the guarded write
  });
});
