import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel, RepoFileProvider, REPO_FIND_FILES_MAX_HITS, REPO_READ_FILE_MAX_CHARS } from '../../src/panel/panelEngine';
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
async function runFindFilesScenario(repoFileProvider: RepoFileProvider | undefined, toolCall: { tool: string; args: Record<string, string> } = { tool: 'find_files', args: { query: 'dark-factory-evidence-gate' } }): Promise<string> {
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
          content: '```json\n' + JSON.stringify(toolCall) + '\n```',
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

describe('panelEngine read_file — full-repository fallback paths', () => {
  const provider = (impl: Partial<RepoFileProvider>): RepoFileProvider => ({
    findFiles: async () => [],
    readFile: async () => null,
    ...impl,
  });
  const readGate = { tool: 'read_file', args: { path: 'tools/dark-factory-evidence-gate.mjs' } };

  it('returns the content of a non-diff file that exists at the reviewed head', async () => {
    const out = await runFindFilesScenario(provider({ readFile: async () => 'export const X = 1;' }), readGate);
    expect(out).toContain('exists in the repository at the reviewed head');
    expect(out).toContain('export const X = 1;');
  });

  it('says a file does not exist only when the full-tree read returned null', async () => {
    const out = await runFindFilesScenario(provider({ readFile: async () => null }), readGate);
    expect(out).toContain('does not exist in the repository at the reviewed head');
    expect(out).toContain('full repository tree');
  });

  it('reports a provider error as a lookup failure, never as absence', async () => {
    const out = await runFindFilesScenario(provider({ readFile: async () => { throw new Error('boom 503'); } }), readGate);
    expect(out).toContain('lookup failure');
    expect(out).toContain('boom 503');
    expect(out.toLowerCase()).not.toContain('does not exist');
  });

  it('never claims a non-diff file is missing when no repoFileProvider is wired', async () => {
    // The symmetric find_files no-provider case is tested; this branch was not.
    // Regressing it to the old "outside the reviewed PR scope" text would let a
    // persona report the file as absent for every CLI/dry-run caller.
    const out = await runFindFilesScenario(undefined, readGate);
    expect(out.toLowerCase()).not.toContain('does not exist');
    expect(out.toLowerCase()).toMatch(/changed files only/);
    expect(out.toLowerCase()).toMatch(/may still exist elsewhere/);
  });

  it('truncates a large file and says so, instead of inlining megabytes into the prompt', async () => {
    const big = 'x'.repeat(REPO_READ_FILE_MAX_CHARS + 1000);
    const out = await runFindFilesScenario(provider({ readFile: async () => big }), readGate);
    expect(out).toContain('content truncated');
    expect(out).toContain(`${REPO_READ_FILE_MAX_CHARS} of ${big.length}`);
    // The tool result must be bounded: the injected body cannot exceed the cap by more than the framing text.
    expect(out.length).toBeLessThan(REPO_READ_FILE_MAX_CHARS + 2000);
  });
});

describe('panelEngine find_files — bounded full-repository hit list', () => {
  it('caps an unbounded hit list and reports the total, so a broad query cannot flood the prompt', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `src/generated/file-${i}.ts`);
    const out = await runFindFilesScenario({ findFiles: async () => many, readFile: async () => null }, { tool: 'find_files', args: { query: 'generated' } });
    expect(out).toContain('5000 paths match');
    expect(out).toContain(`first ${REPO_FIND_FILES_MAX_HITS}`);
    expect(out).toContain('src/generated/file-0.ts');
    expect(out).not.toContain('src/generated/file-4999.ts');
  });

  it('does not claim absence when the repository tree was truncated', async () => {
    // GitHub truncates recursive trees past ~100k entries. A zero-hit search over
    // a truncated tree used to produce "found nowhere in the repository" -- a
    // definitive absence claim that is false exactly when the repository is large.
    const out = await runFindFilesScenario(
      { findFiles: async () => [], readFile: async () => null, treeTruncated: async () => true },
      { tool: 'find_files', args: { query: 'generated' } },
    );
    expect(out).toContain('truncated');
    expect(out.toLowerCase()).toContain('may still exist');
    expect(out.toLowerCase()).not.toContain('found anywhere in the repository');
  });

  it('treats a provider without treeTruncated as a complete tree', async () => {
    // `treeTruncated` is optional so simple stubs stay valid; the `?.` / `?? false`
    // fallback on the zero-hit path was never exercised with the member absent.
    const out = await runFindFilesScenario(
      { findFiles: async () => [], readFile: async () => null },
      { tool: 'find_files', args: { query: 'generated' } },
    );
    expect(out).toContain('found anywhere in the repository at the reviewed head');
    expect(out).not.toContain('truncated');
  });

  it('still reports a genuine absence when the tree was complete', async () => {
    const out = await runFindFilesScenario(
      { findFiles: async () => [], readFile: async () => null, treeTruncated: async () => false },
      { tool: 'find_files', args: { query: 'generated' } },
    );
    expect(out).toContain('found anywhere in the repository at the reviewed head');
  });

  it('reports a provider error as a lookup failure, never as absence', async () => {
    const out = await runFindFilesScenario({ findFiles: async () => { throw new Error('tree fetch 502'); }, readFile: async () => null });
    expect(out).toContain('lookup failure');
    expect(out).toContain('tree fetch 502');
    expect(out.toLowerCase()).not.toMatch(/no files matching .* found anywhere/);
  });
});

describe('panelEngine symbol_search — scope-qualified miss', () => {
  it('never lets a diff-only symbol miss read as "the symbol does not exist"', async () => {
    const out = await runFindFilesScenario(undefined, { tool: 'symbol_search', args: { query: 'checkEvidence' } });
    expect(out.toLowerCase()).toMatch(/changed files|diff/);
    expect(out.toLowerCase()).toMatch(/may (still )?(be defined|exist) elsewhere/);
    expect(out).not.toMatch(/^Tool 'symbol_search' execution result:\nNo symbols found matching '[^']*'\.$/mu);
  });
});
