import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel, RepoFileProvider } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

// REL: the defect this covers — a diff that *imports* a sibling file it does not itself modify
// (`import { checkEvidence } from './dark-factory-evidence-gate.mjs'`) caused the persona's
// find_files tool to search only the PR's changedFiles array, miss the sibling file that in fact
// exists at the reviewed head, and report "the file could not be located to confirm it exists" —
// which a human reads as a real, blocking finding. It re-raised identically every review round
// because nothing about the diff-scoped miss ever changed between rounds.

function buildConfig(): CtReviewConfigV3 {
  return {
    ...createDefaultV3Config(),
    version: 3,
    profile: 'balanced',
    quorum: 1,
    personas: [
      {
        id: 'sec-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/**'],
        providers: ['claude'],
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 60,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'medium', review_timeout_s: 10, arbiter_timeout_s: 10 },
      ],
      arbiter: { order: ['claude'] },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'medium',
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
  };
}

/** A diff that imports a sibling module that is NOT itself part of the changed files. */
const changedFiles = [
  {
    path: 'src/ledger/writer.ts',
    patch: '+ import { checkEvidence } from "./dark-factory-evidence-gate.mjs";\n+ checkEvidence();',
  },
];

/**
 * Drives one persona turn that emits a `find_files` tool call for the sibling module, then
 * captures the exact tool-result text the harness fed back to the model on the following turn,
 * and lets the persona finish cleanly with an APPROVE so the panel run completes.
 */
async function runFindFilesScenario(repoFileProvider: RepoFileProvider | undefined): Promise<string> {
  const config = buildConfig();
  let personaTurn = 0;
  let capturedToolResult = '';

  const mockClient: any = {
    complete: vi.fn(async (opts: any) => {
      const prompt = (opts.messages[1]?.content as string) || '';
      const isPersonaCall = prompt.includes('Role: PERSONA');
      const isArbiterCall = prompt.includes('Role: ARBITER');
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(\S+)/);
      const nonce = nonceMatch ? nonceMatch[1] : 'nonce';

      if (isArbiterCall) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Clean diff, no findings.' })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 5, completion: 5, total: 10 },
        };
      }

      if (!isPersonaCall) {
        // e.g. moderator reconciliation, if ever invoked for this single-persona config.
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 5, completion: 5, total: 10 },
        };
      }

      personaTurn++;
      if (personaTurn === 1) {
        return {
          model: opts.model,
          content: '```json\n{"tool": "find_files", "args": {"query": "dark-factory-evidence-gate"}}\n```',
          usage: { prompt: 5, completion: 5, total: 10 },
        };
      }

      // Second persona turn: the last message is the [PI_TOOL_RESULT] the harness generated from
      // the find_files handler. Capture it, then finish with a clean APPROVE.
      const lastMessage = opts.messages[opts.messages.length - 1];
      capturedToolResult = String(lastMessage?.content || '');
      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: { prompt: 5, completion: 5, total: 10 },
      };
    }),
  };

  const result = await executePersonaPanel({
    config,
    changedFiles,
    repository: 'review-yeti-ai/review-yeti-bot',
    headSha: 'deadbeef',
    client: mockClient as unknown as OmniRouteClient,
    ...(repoFileProvider ? { repoFileProvider } : {}),
  });

  expect(result.personas[0].decision).toBe('APPROVE');
  expect(capturedToolResult).not.toBe('');
  return capturedToolResult;
}

describe('panelEngine find_files — full-repository scope for sibling (non-diff) files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds a sibling file that exists at the reviewed head but was not changed in the diff, when a repoFileProvider is wired', async () => {
    const repoFileProvider: RepoFileProvider = {
      findFiles: async (query: string) =>
        query.toLowerCase().includes('dark-factory-evidence-gate') ? ['tools/dark-factory-evidence-gate.mjs'] : [],
      readFile: async () => null,
    };

    const toolResult = await runFindFilesScenario(repoFileProvider);

    // The real fix: full-repository search must surface the file, not just claim it is missing
    // from the diff.
    expect(toolResult).toContain('tools/dark-factory-evidence-gate.mjs');
    expect(toolResult.toLowerCase()).not.toMatch(/does not exist anywhere|no files? (found|matching).*(?!full)/);
  });

  it('never claims a file "does not exist" from a diff-only miss when no repoFileProvider is wired', async () => {
    const toolResult = await runFindFilesScenario(undefined);

    // Without a full-repository provider, the tool must not let the persona conclude the file is
    // absent — it must say the search was scoped to the diff and the file may exist elsewhere.
    expect(toolResult.toLowerCase()).not.toContain('does not exist');
    expect(toolResult.toLowerCase()).toMatch(/changed files only/);
    expect(toolResult.toLowerCase()).toMatch(/may still exist elsewhere/);
  });
});
