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
    model: 'openrouter/auto',
    charter: 'Check only for unvalidated request input crossing a security boundary.',
  },
  testing: {
    id: 'testing',
    name: 'Testing Replay Reviewer',
    model: 'openrouter/auto',
    charter: 'Check only whether changed behavior has tests.',
  },
  documentation: {
    id: 'documentation',
    name: 'Documentation Replay Reviewer',
    model: 'openrouter/auto',
    charter: 'Check only whether public behavior changes are documented.',
  },
};

export const openRouterReplaySystemPrompts = {
  security: expectedSystemPrompt(openRouterReplayPersonas.security),
  testing: expectedSystemPrompt(openRouterReplayPersonas.testing),
  documentation: expectedSystemPrompt(openRouterReplayPersonas.documentation),
};

export const openRouterReplayUserPrompt = [
  'Repository: calltelemetry/ct-review-bot',
  'Pull request: #42',
  'Title: OpenRouter fleet replay',
  'Unified diff under review:',
  '',
  '--- FILE: src/api/user.ts ---',
  'diff --git a/src/api/user.ts b/src/api/user.ts',
  '@@ -1,1 +1,2 @@',
  '+const id = req.query.id;',
  '+return users[id];',
  '',
].join('\n');

function expectedSystemPrompt(persona: { name: string; charter: string }): string {
  return [
    `You are ${persona.name}, one reviewer on a code review panel.`,
    '',
    'Your charter:',
    persona.charter,
    '',
    '',
    'Review the unified diff supplied by the user against your charter and nothing else.',
    'Another reviewer covers every other concern; staying in your lane is what makes the panel work.',
    '',
    'Rules:',
    '- Report only defects you can point to in the diff. Do not speculate about unseen code.',
    '- Use the exact file path from the diff headers and calculate the line number from the hunk headers (@@ -oldStart,oldCount +newStart,newCount @@).',
    '- Every finding must name what breaks and under what conditions. If you cannot, do not report it.',
    '- Severity: P0 = exploitable, data-losing or outage-causing. P1 = a defect that must be fixed before merge. P2 = worth doing, safe to merge without.',
    '- P1 and P0 are rare. When unsure between two levels, choose the lower one.',
    '- If the diff is clean by your charter, return an empty findings array. Finding nothing is the expected result on most changes, and is more useful than a speculative finding.',
    '',
    'Tool Guidance (Optional on-demand):',
    '- Workspace file reading (read_file, code_search, symbol_lookup) is available when you need to inspect un-modified callers or callee definitions.',
    '- Context7 documentation search (context7_search, fetch_docs) is available when you need official external library/framework API specs.',
    '- If the diff is clear and self-contained, render your findings immediately without unnecessary tool calls.',
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"findings":[{"severity":"P0|P1|P2","path":"<file path>","line":<int>,"title":"<short>","body":"<why it matters>","suggestion":"<concrete fix>"}]}',
  ].join('\n');
}

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
