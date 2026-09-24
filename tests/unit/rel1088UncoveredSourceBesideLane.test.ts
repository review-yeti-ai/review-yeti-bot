import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { renderRoutedFiles } from '../../src/cli/publishingReview';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { resolveReviewApplicability, scopeFilesForPersona } from '../../src/review/personaApplicability';

/**
 * REL-1088 (found by #998, REL-972): when at least one configured persona
 * applied to a diff, a DIFFERENT changed source file no persona covers was
 * neither reviewed nor reported -- `computeUnmatchedPaths` only ran when no lane
 * applied. It rode along unreviewed next to the covered files.
 *
 * Policy: nothing is dropped silently. Beside a lane that applies on its own
 * paths, the uncovered file is routed to the roster's required lane (or the
 * first enabled persona), the same owner as .mdx / gitlink / data routing, and
 * disclosed. Alone, or beside only routed files, it still fails closed.
 */

const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas: string) => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const enabled = (personas: string) => roster(personas).personas.filter((persona) => persona.enabled);
const patch = '@@ -1 +1 @@\n-a\n+b\n';
const files = (...paths: string[]) => paths.map((path) => ({ path, patch }));

const UNCOVERED = 'tools/inventory.lua';
const LAB_ASSETS = 'plugins/ct-lab/skills/lab-inventory/inventory/lab-assets.json';

/** security (required) covers TypeScript/Elixir; architecture covers src/ and lib/. */
function sourceOnlyRoster() {
  return enabled('architecture,security').map((persona) => ({
    ...persona,
    paths: persona.id === 'sec-lane' ? ['**/*.ts', '**/*.ex', '**/*.exs'] : ['src/**', 'lib/**'],
  }));
}

/** Only architecture applies to a Python source file; the required lane does not. */
function narrowRequiredRoster() {
  return enabled('architecture,security').map((persona) => ({
    ...persona,
    paths: persona.id === 'sec-lane' ? ['**/*.ex'] : ['src/**'],
  }));
}

const JSON_OUTPUT = { responseFormat: { type: 'json_object' as const } };

const routedOf = (persona: object) => (persona as { routedPaths?: readonly string[] }).routedPaths;

const unreachableClient = new Proxy({}, {
  get() { throw new Error('the model client must not be consulted'); },
}) as unknown as ReviewModelClient;

describe('REL-1088: uncovered source beside an applying lane is routed, never dropped', () => {
  it('routes the uncovered file to the required lane, which then reviews it', () => {
    const result = resolveReviewApplicability(sourceOnlyRoster(), files('src/auth/login.ts', UNCOVERED));

    expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);
    expect(result.unmatchedPaths).toEqual([]);
    expect(result.noReviewableContent).toBe(false);
    const sec = result.applicable.find((persona) => persona.id === 'sec-lane')!;
    expect(scopeFilesForPersona(sec, result.effectiveFiles).map((file) => file.path))
      .toEqual(['src/auth/login.ts', UNCOVERED]);
    const arch = result.applicable.find((persona) => persona.id === 'arch-lane')!;
    expect(arch).not.toHaveProperty('routedPaths');
    expect(result.routedFiles).toEqual([{ path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' }]);
  });

  it('adds the required lane when only another lane applied on its own paths', () => {
    const result = resolveReviewApplicability(narrowRequiredRoster(), files('src/app.py', UNCOVERED));
    expect(result.applicable.map((persona) => [persona.id, routedOf(persona)])).toEqual([
      ['arch-lane', undefined],
      ['sec-lane', [UNCOVERED]],
    ]);
    expect(result.routedFiles).toEqual([{ path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' }]);
  });

  it('routes to the first enabled persona when none is required', () => {
    const personas = narrowRequiredRoster().map((persona) => ({ ...persona, required: false }));
    const result = resolveReviewApplicability(personas, files('src/app.py', UNCOVERED));
    expect(result.applicable.map((persona) => [persona.id, routedOf(persona)])).toEqual([
      ['arch-lane', [UNCOVERED]],
    ]);
  });

  it('routes to every required lane and lists each one on the routed file', () => {
    const personas = enabled('architecture,security,performance').map((persona) => ({
      ...persona,
      required: persona.id !== 'arch-lane',
      paths: persona.id === 'arch-lane' ? ['src/**'] : ['**/*.ex'],
    }));
    const result = resolveReviewApplicability(personas, files('src/app.py', UNCOVERED));
    expect(result.applicable.map((persona) => [persona.id, routedOf(persona)])).toEqual([
      ['arch-lane', undefined],
      ['sec-lane', [UNCOVERED]],
      ['perf-lane', [UNCOVERED]],
    ]);
    expect(result.routedFiles).toEqual([{ path: UNCOVERED, laneIds: ['sec-lane', 'perf-lane'], reason: 'uncovered-source' }]);
  });

  it('labels fallback-routed and uncovered-source files separately on the same lane', () => {
    const result = resolveReviewApplicability(sourceOnlyRoster(), files('src/auth/login.ts', 'config/app.toml', UNCOVERED));
    expect(result.routedFiles).toEqual([
      { path: 'config/app.toml', laneIds: ['sec-lane'], reason: 'fallback' },
      { path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' },
    ]);
    expect(result.unmatchedPaths).toEqual([]);
  });

  it('keeps uncovered source a coverage failure when no configured lane applies', () => {
    for (const changed of [files(UNCOVERED), files(LAB_ASSETS, UNCOVERED)]) {
      const result = resolveReviewApplicability(sourceOnlyRoster(), changed);
      expect(result.applicable).toEqual([]);
      expect(result.unmatchedPaths).toEqual([UNCOVERED]);
      expect(result.routedFiles).toEqual([]);
    }
  });

  it('routes nothing when every file is covered, or the rest is prose or a filtered generated file', () => {
    for (const changed of [
      files('src/auth/login.ts'),
      files('src/auth/login.ts', 'docs/guide.md'),
      files('src/auth/login.ts', 'dist/bundle.js'),
    ]) {
      const result = resolveReviewApplicability(sourceOnlyRoster(), changed);
      expect(result.applicable.map((persona) => persona.id)).toEqual(['arch-lane', 'sec-lane']);
      expect(result.applicable.some((persona) => 'routedPaths' in persona)).toBe(false);
      expect(result.routedFiles).toEqual([]);
    }
  });

  it('does not route a file the repository path_filters exclude', () => {
    const result = resolveReviewApplicability(sourceOnlyRoster(), files('src/auth/login.ts', UNCOVERED), { pathFilters: ['tools/**'] });
    expect(result.routedFiles).toEqual([]);
    expect(result.effectiveFiles.map((file) => file.path)).toEqual(['src/auth/login.ts']);
  });

  it('the panel engine runs the routed required lane', async () => {
    // Before REL-1088 only arch-lane ran here and the uncovered file was
    // dropped; the required lane now runs and fails closed on the unreachable
    // client, proving it was scheduled.
    const config = { ...roster('architecture,security'), personas: narrowRequiredRoster() };
    await expect(executePersonaPanel({
      config,
      changedFiles: files('src/app.py', UNCOVERED),
      repository: 'r/r',
      headSha: 'f'.repeat(40),
      client: unreachableClient,
      deterministicRoster: true,
    })).rejects.toThrow(/persona sec-lane failed closed/);
  }, 60_000);

  it('the panel engine returns the routed file on a completed result, and the routed lane reads it', async () => {
    const config = { ...roster('architecture,security'), personas: narrowRequiredRoster() };
    const client = approvingPanelClient();
    const result = await executePersonaPanel({
      config,
      changedFiles: files('src/app.py', UNCOVERED),
      repository: 'r/r',
      headSha: 'f'.repeat(40),
      client,
      requestPolicy: JSON_OUTPUT,
      deterministicRoster: true,
    });
    expect(result.applicablePersonaIds).toEqual(['arch-lane', 'sec-lane']);
    expect(result.personas.map((persona) => persona.id).sort()).toEqual(['arch-lane', 'sec-lane']);
    expect(result.routedFiles).toEqual([{ path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' }]);
    expect(client.laneTexts.some((text) => text.includes(UNCOVERED))).toBe(true);
  }, 60_000);

  it('the composed engine returns the routed file on its result', async () => {
    const config = { ...roster('architecture,security'), personas: narrowRequiredRoster() };
    const complete = async (payload: { messages: unknown[] }) => {
      const text = lastText(payload.messages);
      const nonce = nonceFrom(text);
      if (text.includes('PLAN TURN')) {
        return fakeResponse(JSON.stringify({ nonce, tasks: [
          { id: 'task-sec', dimension: 'security', paths: ['src/app.py', UNCOVERED], question: 'Is it safe?', rationale: 'changed source' },
        ] }));
      }
      if (text.includes('WORK TURN')) return fakeResponse(JSON.stringify({ nonce, task: 'task-sec', status: 'COMPLETE', findings: [] }));
      throw new Error(`unexpected turn: ${text.slice(0, 80)}`);
    };
    const result = await executeComposedReview({
      config,
      changedFiles: files('src/app.py', UNCOVERED),
      repository: 'r/r',
      headSha: 'f'.repeat(40),
      client: { complete } as unknown as ReviewModelClient,
    });
    expect(result.personas.map((persona) => persona.id)).toEqual(['task-sec']);
    expect(result.routedFiles).toEqual([{ path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' }]);
  }, 60_000);
});

function textOf(messages: unknown[]): string {
  return JSON.stringify(messages);
}

function lastText(messages: unknown[]): string {
  const last = messages[messages.length - 1] as { content?: unknown } | undefined;
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) return last.content.map((block: { text?: string }) => block.text || '').join('\n');
  return '';
}

function nonceFrom(text: string): string {
  const match = text.match(/CT_REVIEW_NONCE:([^\n"\\]+)/);
  return match ? match[1].trim() : 'nonce';
}

function fakeResponse(content: string) {
  return { model: 'test-model', content, usage: { prompt: 10, completion: 10, total: 20 }, costUSD: 0, raw: {} };
}

/** Every lane approves; the moderator reconciles; the arbiter ships. */
function approvingPanelClient() {
  const laneTexts: string[] = [];
  const complete = async (request: { messages: unknown[]; metadata?: { role?: string } }) => {
    const text = textOf(request.messages);
    const nonce = nonceFrom(text);
    const role = request.metadata?.role;
    if (role === 'moderator') return fakeResponse(JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }));
    if (role === 'arbiter') return fakeResponse(JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'ok' }));
    laneTexts.push(text);
    return fakeResponse(JSON.stringify({ nonce, decision: 'APPROVE', findings: [] }));
  };
  return { complete, laneTexts } as unknown as ReviewModelClient & { laneTexts: string[] };
}

describe('REL-1088: routed files are disclosed in the check summary', () => {
  it('names each routed file, its lane and whether it is uncovered source', () => {
    const text = renderRoutedFiles({ routedFiles: [
      { path: 'config/app.toml', laneIds: ['sec-lane'], reason: 'fallback' },
      { path: UNCOVERED, laneIds: ['sec-lane'], reason: 'uncovered-source' },
    ] })!;
    expect(text).toContain("Routed files (no persona's paths cover them");
    expect(text).toContain('- `config/app.toml` -> `sec-lane`\n');
    expect(text).toContain(`- \`${UNCOVERED}\` -> \`sec-lane\` (source no persona covers)`);
  });

  it('renders nothing when nothing was routed', () => {
    expect(renderRoutedFiles({})).toBeNull();
    expect(renderRoutedFiles({ routedFiles: [] })).toBeNull();
  });

  it('neutralizes markdown in untrusted paths and bounds the list', () => {
    const routed = Array.from({ length: 22 }, (_, index) => ({
      path: index === 0 ? 'a`b<c>\nd.lua' : `tools/f${index}.lua`, laneIds: ['sec-lane'], reason: 'uncovered-source' as const,
    }));
    const text = renderRoutedFiles({ routedFiles: routed })!;
    expect(text).toContain('`a b c  d.lua`');
    expect(text).toContain('tools/f19.lua');
    expect(text).not.toContain('tools/f20.lua');
    expect(text).toContain('- +2 more');
  });
});
