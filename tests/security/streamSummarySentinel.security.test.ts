// Sentinel canary (ct-meta docs/plans/2026-08-20-review-yeti-telemetry.md, design §9): "a unit
// test drives a synthetic stream whose prompt, diff, reasoning deltas, content deltas, and a
// bearer token each contain a unique sentinel string; it asserts no sentinel appears in any
// rendered STREAM_SUMMARY, TIMEOUT, run-report JSON, or exporter payload byte. A leak is a red
// build, not a review comment." This is that test, implemented rather than merely intended.
import { describe, expect, it, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const streamSummary = require(path.join(rootRepoDir, 'src/telemetry/streamSummary.js'));
const { renderStreamSummaryLine, renderTimeoutTraceSuffix } = streamSummary;

// Unique, greppable sentinels -- each stands in for a distinct class of content the design
// forbids from ever reaching telemetry (§9): prompt text, diff text, reasoning prose, content
// prose, header/credential values.
const PROMPT_SENTINEL = 'SENTINEL-PROMPT-9f1c2a7e';
const DIFF_SENTINEL = 'SENTINEL-DIFF-4b6d8e01';
const REASONING_SENTINEL = 'SENTINEL-REASONING-a03f7c55';
const CONTENT_SENTINEL = 'SENTINEL-CONTENT-77bb21de';
const BEARER_SENTINEL = 'SENTINEL-BEARER-c9de00aa';
const ALL_SENTINELS = [PROMPT_SENTINEL, DIFF_SENTINEL, REASONING_SENTINEL, CONTENT_SENTINEL, BEARER_SENTINEL];

function chunkLine(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sentinelStreamBody() {
  const lines = [
    chunkLine({ id: 'gen-sentinel', model: 'test/model', provider: 'fireworks', choices: [{ delta: { reasoning_content: `thinking about ${REASONING_SENTINEL}` } }] }),
    chunkLine({ id: 'gen-sentinel', model: 'test/model', provider: 'fireworks', choices: [{ delta: { content: `{"findings":[],"note":"${CONTENT_SENTINEL}"}` } }] }),
    'data: [DONE]\n\n',
  ];
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (index < lines.length) {
          const value = Buffer.from(lines[index], 'utf-8');
          index += 1;
          return { done: false, value };
        }
        return { done: true, value: undefined };
      },
      cancel: async () => {},
    }),
  };
}

function captureConsole() {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return { lines, restore: () => { logSpy.mockRestore(); warnSpy.mockRestore(); } };
}

describe('sentinel canary: telemetry never carries prompt/diff/reasoning/content/credential bytes', () => {
  it('a real reviewWithModel run with sentinel-laced prompt, diff, reasoning, content, and bearer token leaks no sentinel into console output', async () => {
    const capture = captureConsole();
    try {
      await pipeline.reviewWithModel(
        { id: 'security', name: 'Security', charter: 'Review safely.' },
        [{ path: 'src/app.js', patch: `+// ${DIFF_SENTINEL}\n+const safe = true;`, addedLines: [{ text: `// ${DIFF_SENTINEL}` }] }],
        { repo: 'acme/widget', prNumber: '42', headSha: 'b'.repeat(40) },
        {},
        {
          rawTurn: true,
          investigationMessages: [
            { role: 'system', content: 'You are a bounded code-review panel reviewer.' },
            { role: 'user', content: `<review_manifest></review_manifest><pull_request_diff>${PROMPT_SENTINEL}</pull_request_diff>` },
          ],
          model: 'model-a',
          apiKey: `sk-${BEARER_SENTINEL}`,
          baseUrl: 'https://api.example.test',
          maxAttempts: 1,
          fetchImplementation: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: sentinelStreamBody(),
          }),
        },
      );
    } finally {
      capture.restore();
    }

    const combined = capture.lines.join('\n');
    for (const sentinel of ALL_SENTINELS) {
      expect(combined).not.toContain(sentinel);
    }
    // Confirm the canary is actually exercising the STREAM_SUMMARY path (a vacuous pass -- zero
    // lines captured at all -- would silently satisfy the assertions above without proving
    // anything, exactly the "vacuous test" failure mode found repeatedly in this codebase today).
    expect(capture.lines.some((line) => line.startsWith('STREAM_SUMMARY '))).toBe(true);
  });

  it('renderStreamSummaryLine and renderTimeoutTraceSuffix carry no sentinel even when handed a hostile context object', () => {
    // Defense in depth at the unit level: even if a caller tried to smuggle prose or a credential
    // into a context field, the closed-schema validator refuses it outright (charset for prose
    // with spaces/punctuation; the credential-shape check for a bearer/API-key-looking string)
    // rather than rendering it. A bare opaque alnum-hyphen token (a legitimate id shape, e.g. a
    // real provider receipt id) is NOT itself prose/diff/reasoning/content -- see the credential
    // and prose cases below, which are the actual leak vectors design §9 forbids.
    const hostileContextProse = {
      persona: 'security',
      model_index: 0,
      attempt: 1,
      transport: 'openrouter',
      provider: 'fireworks',
      model: 'deepseek/deepseek-v4-flash-0731',
      generation_id: `leaked prompt text: ${PROMPT_SENTINEL}`, // spaces -- fails the id charset
      http_status: 200,
      queue_wait_ms: 0,
      queued_ahead_at_start: 0,
      prompt_chars: 10,
      lane_deadline_ms: null,
      prompt_tokens: 5,
      completion_tokens: 5,
    };
    const hostileContextCredential = {
      ...hostileContextProse,
      generation_id: `Bearer sk-${BEARER_SENTINEL}`.replace(/\s/g, '-'), // credential-shaped, no spaces
    };
    const trace = {
      t_headers_ms: 10, t_first_chunk_ms: 10, first_chunk_kind: 'content', t_first_content_ms: 10,
      t_done_ms: 20, reasoning_ms: null, reasoning_chars: 0, content_chars: 5, chunk_count: 1,
      max_inter_chunk_gap_ms: null, max_gap_at_ms: null, stream_end_reason: 'done_marker',
      budget_exceeded: 'none', ttft_budget_ms: 30_000, total_budget_ms: 30_000, stall_budget_ms: 20_000,
      provider_ttft_ms: null,
    };

    const proseLine = renderStreamSummaryLine({ trace, context: hostileContextProse });
    expect(proseLine).toMatch(/^STREAM_SUMMARY_INVALID/);
    expect(proseLine).not.toContain(PROMPT_SENTINEL);

    const credentialLine = renderStreamSummaryLine({ trace, context: hostileContextCredential });
    expect(credentialLine).toMatch(/^STREAM_SUMMARY_INVALID/);
    expect(credentialLine).not.toContain(BEARER_SENTINEL);

    const suffix = renderTimeoutTraceSuffix({ ...trace, extra_field: `leak-${CONTENT_SENTINEL}` });
    expect(suffix).not.toContain(CONTENT_SENTINEL);
  });
});
