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
});
