import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';

const root = path.resolve(__dirname, '../..');

describe('GitHub and model cassette replay', () => {
  it('replays exact-head GitHub state and model JSON without credentials', async () => {
    const github = createCassetteFetch({ cassettePath: path.join(root, 'tests/fixtures/cassettes/github/fresh-pr.json') });
    const githubResponse = await github.fetchImplementation('https://api.github.fixture.test/repos/acme/review-yeti/pulls/42', {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer fixture-token' },
    });
    expect(await githubResponse.json()).toMatchObject({ number: 42, head: { sha: 'a'.repeat(40) } });
    github.assertComplete();

    const openrouter = createCassetteFetch({ cassettePath: path.join(root, 'tests/fixtures/cassettes/openrouter/reviewer-panel.json') });
    const modelResponse = await openrouter.fetchImplementation('https://openrouter.fixture.test/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'system', content: 'fixture system' }, { role: 'user', content: 'fixture user' }], temperature: 0.1, response_format: { type: 'json_object' } }),
    });
    expect(await modelResponse.json()).toMatchObject({ choices: [{ message: { content: '{"findings":[]}' } }] });
    openrouter.assertComplete();
  });

  it('replays stale-head, pagination, publication-race, and model failure boundaries', async () => {
    const cases = [
      ['github/stale-head.json', 'https://api.github.fixture.test/repos/acme/review-yeti/pulls/42', 200],
      ['github/feedback-transitions.json', 'https://api.github.fixture.test/graphql', 200],
      ['github/publication-race.json', 'https://api.github.fixture.test/repos/acme/review-yeti/pulls/42/reviews', 409],
      ['github/publication-failure.json', 'https://api.github.fixture.test/repos/acme/review-yeti/pulls/42/reviews', 500],
      ['openrouter/provider-timeout.json', 'https://openrouter.fixture.test/v1/chat/completions', 504],
    ] as const;
    for (const [relative, url, status] of cases) {
      const cassette = createCassetteFetch({ cassettePath: path.join(root, 'tests/fixtures/cassettes', relative), requireVersion: 2 });
      const method = relative.includes('stale-head') ? 'GET' : 'POST';
      const response = await cassette.fetchImplementation(url, {
        method,
        headers: { Authorization: 'Bearer fixture-token', ...(relative.startsWith('github/') ? { Accept: 'application/vnd.github+json' } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        body: relative.includes('stale-head') ? undefined : JSON.stringify(relative.includes('feedback') ? { operationName: 'ReviewThreads', variables: { number: 42 } } : relative.includes('openrouter') ? { model: 'fixture-model', messages: [{ role: 'user', content: 'fixture' }] } : { commit_id: 'a'.repeat(40), event: relative.includes('publication-race') ? 'APPROVE' : 'COMMENT', body: 'fixture' }),
      });
      expect(response.status).toBe(status);
      cassette.assertComplete();
    }

    const malformed = createCassetteFetch({ cassettePath: path.join(root, 'tests/fixtures/cassettes/openrouter/malformed-response.json'), requireVersion: 2 });
    const malformedResponse = await malformed.fetchImplementation('https://openrouter.fixture.test/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'fixture' }] }),
    });
    await expect(malformedResponse.json()).rejects.toThrow();
    malformed.assertComplete();
  });
});
