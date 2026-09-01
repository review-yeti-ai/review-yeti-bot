import path from 'node:path';
import { createCassetteFetch } from './cassetteFetch';

const rootRepoDir = path.resolve(__dirname, '../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const policyModule = require(path.join(rootRepoDir, '.github/workflows/pipelines/openrouter-policy.js'));

export const openRouterReplayPolicy = policyModule.resolveOpenRouterReviewPolicy({});

export const openRouterReplayDiffFiles = [{
  path: 'src/api/user.ts',
  patch: 'diff --git a/src/api/user.ts b/src/api/user.ts\n@@ -1,1 +1,2 @@\n+const id = req.query.id;\n+return users[id];\n',
  addedLines: [{ text: 'const id = req.query.id;' }, { text: 'return users[id];' }],
  deletedLines: [],
}];

export const openRouterReplayPrContext = {
  repo: 'calltelemetry/ct-review-bot',
  prNumber: '42',
  title: 'OpenRouter fleet replay',
  headSha: '0123456789abcdef0123456789abcdef01234567',
};

export const openRouterReplayPersonas = {
  security: {
    id: 'security',
    name: 'Security Replay Reviewer',
    model: 'deepseek/deepseek-v4-flash-0731',
    charter: 'Check only for unvalidated request input crossing a security boundary.',
  },
  testing: {
    id: 'testing',
    name: 'Testing Replay Reviewer',
    model: 'deepseek/deepseek-v4-flash-0731',
    charter: 'Check only whether changed behavior has tests.',
  },
  documentation: {
    id: 'documentation',
    name: 'Documentation Replay Reviewer',
    model: 'deepseek/deepseek-v4-flash-0731',
    charter: 'Check only whether public behavior changes are documented.',
  },
};

export const openRouterReplayUserPrompt = [
  'Repository: calltelemetry/ct-review-bot',
  'Pull request: #42',
  'Title: OpenRouter fleet replay',
  'Unified diff under review:',
  '',
  '--- FILE: src/api/user.ts ---',
  'diff --git a/src/api/user.ts b/src/api/user.ts',
  '@@ -1,1 +1,3 @@',
  '+const id = req.query.id;',
  '+return users[id];',
  '',
  '',
].join('\n');

export const openRouterReplayMessages = Object.fromEntries(
  Object.entries(openRouterReplayPersonas).map(([id, persona]) => [
    id,
    pipeline.buildOpenRouterReviewMessages(persona, openRouterReplayUserPrompt),
  ]),
);

export const openRouterReplayCacheIdentity = pipeline.openRouterPromptCacheIdentity(
  openRouterReplayMessages.security,
);

export function openRouterCassettePath(name: string): string {
  return path.join(rootRepoDir, 'tests/fixtures/cassettes/openrouter', name);
}

export async function runOpenRouterReplay(
  cassetteName: string,
  personas = [
    openRouterReplayPersonas.security,
    openRouterReplayPersonas.testing,
    openRouterReplayPersonas.documentation,
  ],
) {
  const cassette = createCassetteFetch({ cassettePath: openRouterCassettePath(cassetteName) });
  // Keep replay scenarios independent from the action's process-wide breaker.
  // A prior provider-failure test must not suppress a cassette lane in a later
  // test file; cassette matching remains strict and fail-closed.
  const circuitBreaker = new pipeline.RunTransportCircuitBreaker();
  const results = await Promise.all(personas.map((persona) => pipeline.reviewWithModel(
    persona,
    openRouterReplayDiffFiles,
    openRouterReplayPrContext,
    null,
    {
      apiKey: 'synthetic-key',
      openRouterPolicy: openRouterReplayPolicy,
      fetchImplementation: cassette.fetchImplementation,
      timeoutMs: 1_000,
      circuitBreaker,
    },
  )));
  cassette.assertComplete();
  const arbitration = pipeline.computeArbitrationQuorum(results, personas.length, {
    changedFiles: openRouterReplayDiffFiles,
  });
  const comment = pipeline.formatPRComment(
    arbitration,
    results,
    openRouterReplayPrContext,
    { mcpStatusSummary: 'Replay fixture MCP disabled' },
    {
      enabled: true,
      model: openRouterReplayPolicy.model,
      maxDiffChars: 24_000,
    },
  );

  return {
    cassette,
    results,
    arbitration,
    comment,
    policyFingerprint: openRouterReplayPolicy.policy_fingerprint,
    requestFingerprints: [...cassette.observedFingerprints],
  };
}
