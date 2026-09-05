import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentPublisher } from '../../src/github/commentPublisher';

describe('GitHub App installation-token-only publisher', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('refuses construction without an explicit ghs installation token', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_personal_token');
    vi.stubEnv('GITHUB_APP_INSTALLATION_TOKEN', 'ghs_env_token');
    expect(() => new CommentPublisher()).toThrow(/explicit GitHub App installation token/i);
  });

  it('publishes final-phase inline findings in one review request (publisher primitive)', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(
      JSON.stringify({ id: 123 }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const publisher = new CommentPublisher({
      githubToken: 'ghs_installation_token',
      baseUrl: 'https://api.github.test',
    });

    const result = await publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'ct-meta',
      prNumber: 99,
      commitSha: 'head123',
      event: 'COMMENT',
      body: 'persona evidence',
      inlineComments: [{
        path: 'tools/example.sh',
        line: 4,
        finding: {
          persona: 'policy-compliance',
          severity: 'major',
          filePath: 'tools/example.sh',
          lineNumber: 4,
          comment: 'Bash 3.2 violation',
        },
      }],
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ghs_installation_token');
    const body = JSON.parse(String(init.body));
    expect(body.event).toBe('COMMENT');
    expect(body.comments).toEqual([expect.objectContaining({
      path: 'tools/example.sh',
      line: 4,
      side: 'RIGHT',
    })]);
  });
});
