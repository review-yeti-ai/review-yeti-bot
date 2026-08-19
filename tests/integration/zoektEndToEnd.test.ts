import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// This is the actual production consumption path: review-pipeline.js's
// makeEvidenceRegistry composes a GitHub-blob-backed registry
// (createReviewNavigationToolRegistry) with the Zoekt registry
// (createZoektSearchTool) via composeEvidenceRegistries, then hands the
// composed registry to runPersonaInvestigation. Every module below except
// the zoekt child-process spawn (stubbed, same convention
// tests/unit/zoektSearchTool.test.ts already uses -- no real `zoekt` binary
// is available in CI/dev) is the real production module, unmocked.
const { runPersonaInvestigation } = require('../../src/review/reviewInvestigation.js');
const { createZoektSearchTool, ZOEKT_SEARCH_TOOL_NAME } = require('../../src/mcp/zoektSearchTool.js');
const { createReviewNavigationToolRegistry, createGitHubBlobClient } = require('../../src/mcp/reviewNavigationTools.js');
const { composeEvidenceRegistries } = require('../../src/mcp/evidenceRegistryComposer.js');
const { EVIDENCE_TOOLS } = require('../../src/review/evidenceContracts.js');

const identity = { provider: 'github', repository: 'owner/repo', prNumber: 22, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };

function jsonlLine(path: string, matches: Array<{ line: number; text: string }>) {
  return JSON.stringify({
    FileName: path,
    LineMatches: matches.map((m) => ({ LineNumber: m.line, FileName: false, Line: Buffer.from(m.text, 'utf8').toString('base64') })),
  });
}

// A real zoekt CLI child process, faked only at the spawn boundary: it emits
// one real JSONL match line (the exact wire format zoektSearchTool.js parses
// in production) for a "handle_call" query, mirroring
// tests/unit/zoektSearchTool.test.ts's own fixture convention.
function makeSpawnImpl(capturedArgs: string[][]) {
  return (_bin: string, args: string[]) => {
    capturedArgs.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', 137);
    queueMicrotask(() => {
      child.stdout.write(`${jsonlLine('lib/genserver.ex', [{ line: 42, text: 'def handle_call(:ping, _from, state) do' }])}\n`);
      child.stdout.end();
      child.emit('exit', 0);
    });
    return child;
  };
}

function extractReceiptId(messages: Array<{ content?: string }>) {
  const block = messages.map((m) => m.content || '').find((content) => content.includes('<evidence_results>'));
  expect(block, 'evidence_results block must be appended after a tool call').toBeTruthy();
  const match = /"receipt_id":"(er_[a-f0-9]+)"/.exec(block as string);
  expect(match, 'evidence_results must carry a real receipt id').toBeTruthy();
  return match![1];
}

describe('code_search_zoekt end-to-end reachability (the real registry composition path)', () => {
  it('is allowlisted in EVIDENCE_TOOLS', () => {
    expect(EVIDENCE_TOOLS.has('code_search_zoekt')).toBe(true);
  });

  it('a persona requests code_search_zoekt through the composed production registry and gets real matches back', async () => {
    const capturedSpawnArgs: string[][] = [];
    const zoektTool = createZoektSearchTool({
      identity,
      indexDir: '/fake/index',
      config: { enabled: true },
      fsImpl: { existsSync: () => true, readdirSync: () => ['shard.zoekt'] },
      spawnImpl: makeSpawnImpl(capturedSpawnArgs),
    });
    const navTool = createReviewNavigationToolRegistry({
      identity,
      snapshot: { repository: identity.repository, headSha: identity.headSha, baseSha: identity.baseSha, files: [] },
      blobClient: createGitHubBlobClient({ token: 'test-token', fetchImplementation: async () => { throw new Error('blobClient must not be called by this test'); } }),
      config: { enabled: true, maxCalls: 12, maxResultBytes: 8_000, maxFindResults: 50, maxScanFiles: 60 },
    });
    // The exact composition shape review-pipeline.js's makeEvidenceRegistry builds:
    // composeEvidenceRegistries([navRegistry, zoektRegistry]).
    const evidenceRegistry = composeEvidenceRegistries([navTool, zoektTool]);

    // Production wiring proof, independent of the investigation loop below: the
    // composed registry's own capabilities already advertise code_search_zoekt
    // alongside the pre-existing tools -- this is what was missing before this
    // change (an allowlist entry the live registry never actually served).
    expect(evidenceRegistry.capabilities.tools).toContain(ZOEKT_SEARCH_TOOL_NAME);
    expect(evidenceRegistry.capabilities.tools).toEqual(expect.arrayContaining(['file_read', 'file_find', 'code_search', 'file_read_diff']));

    let secondTurnMessages: Array<{ content?: string }> = [];
    const modelTurn = async ({ messages, turn }: { messages: Array<{ content?: string }>; turn: number }) => {
      if (turn === 1) {
        return {
          ok: true,
          model: 'test/model',
          provider: 'test',
          usage: { promptTokens: 10, completionTokens: 5 },
          content: JSON.stringify({
            review_status: 'NEEDS_EVIDENCE',
            risk_plan: [{
              id: 'risk-1',
              unit_ids: ['ru_genserver'],
              statement: 'GenServer handle_call may not guard against an unexpected message shape',
              evidence_needed: ['every handle_call clause in this module'],
              allowed_tools: ['code_search_zoekt'],
            }],
            evidence_requests: [{
              risk_id: 'risk-1',
              tool: 'code_search_zoekt',
              args: { query: 'handle_call' },
              reason: 'find every handle_call callback across the repository, not just the diff-visible one',
            }],
            risk_dispositions: [],
            findings: [],
          }),
        };
      }
      secondTurnMessages = messages;
      const receiptId = extractReceiptId(messages);
      return {
        ok: true,
        model: 'test/model',
        provider: 'test',
        usage: { promptTokens: 10, completionTokens: 5 },
        content: JSON.stringify({
          review_status: 'COMPLETE',
          risk_plan: [{
            id: 'risk-1',
            unit_ids: ['ru_genserver'],
            statement: 'GenServer handle_call may not guard against an unexpected message shape',
            evidence_needed: ['every handle_call clause in this module'],
            allowed_tools: ['code_search_zoekt'],
          }],
          evidence_requests: [],
          risk_dispositions: [{ risk_id: 'risk-1', status: 'confirmed', reason: 'code_search_zoekt located a second unguarded handle_call clause' }],
          findings: [{
            severity: 'P1',
            path: 'lib/genserver.ex',
            line: 42,
            side: 'RIGHT',
            title: 'Unguarded handle_call clause found repo-wide via code_search_zoekt',
            body: 'code_search_zoekt located lib/genserver.ex:42 outside the diff-visible snapshot; it has no guard clause.',
            risk_id: 'risk-1',
            evidence_receipt_ids: [receiptId],
          }],
        }),
      };
    };

    const result = await runPersonaInvestigation({
      identity,
      persona: { id: 'security', name: 'Security reviewer', charter: 'Review cross-file blast radius.' },
      manifest: 'ru_genserver lib/genserver.ex',
      diffText: '@@ -1 +1 @@\n+def handle_call(:ping, _from, state), do: {:reply, :pong, state}',
      evidenceRegistry,
      modelTurn,
      clock: () => 100,
    });

    // Proof #1: the real zoekt CLI spawn boundary was actually invoked, with the
    // model's query, through the `--` end-of-options guard -- not skipped, not
    // short-circuited by a mock at a higher layer.
    expect(capturedSpawnArgs.length).toBe(1);
    expect(capturedSpawnArgs[0]).toContain('--');
    expect(capturedSpawnArgs[0].at(-1)).toBe('handle_call');

    // Proof #2: the real match zoektSearchTool.js parsed from the (faked) zoekt
    // process output reached the persona's next-turn prompt inside
    // <evidence_results>, tagged with tool "code_search_zoekt".
    const evidenceBlock = secondTurnMessages.map((m) => m.content || '').find((c) => c.includes('<evidence_results>'));
    expect(evidenceBlock).toContain('code_search_zoekt');
    expect(evidenceBlock).toContain('handle_call');
    expect(evidenceBlock).toContain('lib/genserver.ex');

    // Proof #3: the lane completed by citing that real receipt -- this is what
    // "reachable by a live persona" means end-to-end, not just an allowlist entry.
    expect(result.personaResult.decision).toBe('FINDINGS');
    expect(result.executionReceipt.termination).toBe('completed');
    expect(result.personaResult.findings).toHaveLength(1);
    expect(result.personaResult.findings[0].evidence_receipt_ids).toHaveLength(1);
  });
});
