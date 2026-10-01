import { describe, expect, it, vi } from 'vitest';
import { createDeletionEvidenceRuntime, deletionInventory } from '../../src/review/deletionEvidence';
import { runReadOnlyTool } from '../../src/panel/toolRuntime';
import { JevClient, type JevAsker } from '../../src/gateway/jevClient';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40), repository = 'owner/repo';
const file = (path: string, mode = '100644') => ({ path, patch: `deleted file mode ${mode}\n@@ -1 +0,0 @@\n-export function guardTenant() { return true; }` });
function setup(files = [file('old.ts')], overrides: Record<string, unknown> = {}) {
  const provider = { readFile: async () => null, findFiles: async () => [],
    readFileAt: vi.fn(async (_path: string, side: string) => ({ sha: side === 'head' ? HEAD : OLD,
      content: side === 'head' ? null : 'export function guardTenant() { return true; }' })) };
  const search = vi.fn(async () => ({ status: 'ok', identity: { repository, headSha: HEAD },
    queryComplete: true, exhaustive: false, indexScope: { complete: false },
    matches: [{ path: 'unchanged.ts', line: 7, text: 'guardTenant()' }], matchCount: 1 }));
  const runtime = createDeletionEvidenceRuntime({ files, provider, repository, headSha: HEAD,
    zoektConfig: { searchSession: { call: search } }, ...overrides });
  return { runtime, provider, search };
}
const outcome = (model = 'jev-test') => ({ status: 'ok', model, durationMs: 1,
  usage: { input_tokens: 100, output_tokens: 0 }, answers: {
    category: { type: 'choice', choice: 'source', confidence: 1, probabilities: { source: 1 } },
    visible_consumer: { type: 'choice', choice: 'supported', confidence: 1, probabilities: { supported: 1 } },
    contract_change: { type: 'choice', choice: 'unknown', confidence: 1, probabilities: { unknown: 1 } },
  } });

describe('deletion evidence replay', () => {
  it.each(['----', '--- comment', '--- a/content'])('counts dash-prefixed removed content inside a hunk: %s', (removed) => {
    const changed = { path: 'settings.yaml', patch: `--- a/settings.yaml\n+++ b/settings.yaml\n@@ -1,2 +1 @@\n key: value\n${removed}` };
    expect(deletionInventory([changed])[0].removedLines).toBe(1);
    expect(setup([changed]).runtime.manifest().totalFiles).toBe(1);
    expect(deletionInventory([{ path: 'headers-only', patch: '--- a/x\n+++ b/x' }])).toEqual([]);
  });

  it('excludes additions and context-only changes from the deletion inventory', () => {
    const addition = { path: 'added.ts', patch: '--- /dev/null\n+++ b/added.ts\n@@ -0,0 +1 @@\n+export const x = 1;' };
    const context = { path: 'same.ts', patch: '@@ -1 +1 @@\n unchanged' };
    expect(deletionInventory([addition, context])).toEqual([]);
    expect(setup([file('old.ts'), addition, context]).runtime.manifest().totalFiles).toBe(1);
  });

  it('keeps a thrown classifier call advisory and exposes its unavailable reason', async () => {
    const ask = vi.fn(async () => { throw new Error('classifier failed'); });
    const { runtime } = setup(undefined, { asker: { ask } as unknown as JevAsker, modelPin: 'jev-test' });
    expect(await runtime.evidence('old.ts')).toMatchObject({
      classification: { status: 'unavailable', reason: 'question_failed', authority: 'none' },
      resolution: 'review_required', authority: 'evidence_only',
    });
  });

  it('keeps binary deletions and failed source reads unavailable', async () => {
    const binary = { path: 'x.bin', patch: 'deleted file mode 100644\nBinary files a/x.bin and b/x.bin differ' };
    expect(deletionInventory([binary])[0].available).toBe(false);
    const blocked = setup([binary]);
    expect(await blocked.runtime.evidence('x.bin')).toMatchObject({ status: 'unavailable', reason: 'original_evidence_unavailable' });
    expect(blocked.provider.readFileAt).not.toHaveBeenCalled();
    const failed = setup();
    failed.provider.readFileAt.mockRejectedValue(new Error('source read failed'));
    expect(await failed.runtime.evidence('old.ts')).toMatchObject({ status: 'unavailable', reason: 'source_lookup_failed' });
  });

  it('activates the real client seam through aliases and exact repository allowlists', async () => {
    const ask = vi.spyOn(JevClient.prototype, 'ask').mockResolvedValue(outcome() as any);
    try {
      for (const flag of ['true', '1', 'on', 'all', '*', repository, 'owner/other,owner/repo', ' OWNER/REPO ']) {
        const { runtime } = setup(undefined, { env: { NODE_ENV: 'test', REVIEW_YETI_JEV_EVIDENCE: flag,
          TYPESAFE_BASE_URL: 'https://jev.example.invalid', TYPESAFE_MODEL: 'jev-test',
          TYPESAFE_API_KEY: 'test-key', TYPESAFE_MODEL_PIN: 'jev-test' } });
        expect((await runtime.evidence('old.ts') as any).classification.status).toBe('ok');
      }
      expect(ask).toHaveBeenCalledTimes(8);
      for (const flag of ['', ' ', 'off', 'owner/repository', 'owner/other']) {
        const { runtime } = setup(undefined, { env: { NODE_ENV: 'test', REVIEW_YETI_JEV_EVIDENCE: flag,
          TYPESAFE_BASE_URL: 'https://jev.example.invalid', TYPESAFE_MODEL: 'jev-test',
          TYPESAFE_API_KEY: 'test-key', TYPESAFE_MODEL_PIN: 'jev-test' } });
        expect((await runtime.evidence('old.ts') as any).classification.reason).toBe('disabled');
      }
      expect(ask).toHaveBeenCalledTimes(8);
    } finally { ask.mockRestore(); }
  });

  it('accounts for every file beyond the former 40-file cap, with distinct path obligations', () => {
    const { runtime } = setup(Array.from({ length: 64 }, (_, i) => file(`retired/${i}.ts`)));
    let offset: number | null = 0, digest: string | undefined;
    const paths: string[] = [], ids: string[] = [];
    do {
      const page = runtime.manifest(offset!, 24, digest);
      expect(page.status).toBe('ok');
      if (page.status !== 'ok') throw new Error('unexpected invalid manifest');
      digest = page.digest;
      for (const group of page.groups) for (const member of group.members) {
        paths.push(member.path); ids.push(...member.obligations.map((o) => o.id));
        expect(member.obligations.every((o) => o.status === 'review_required')).toBe(true);
      }
      offset = page.nextOffset;
    } while (offset !== null);
    expect(new Set(paths).size).toBe(64); expect(new Set(ids).size).toBe(64 * 5);
  });

  it('groups only verified equal old sources and modes; a mode divergence stays separate', async () => {
    const { runtime } = setup([file('one.ts'), file('two.ts'), file('three.ts', '100755')]);
    const before = runtime.manifest(0, 1);
    expect(before.totalGroups).toBe(3);
    for (const path of ['one.ts', 'two.ts', 'three.ts']) await runtime.evidence(path);
    expect(runtime.manifest(1, 1, before.digest)).toMatchObject({ status: 'invalid', reason: 'manifest_changed_restart_pagination' });
    const after = runtime.manifest();
    expect(after.totalFiles).toBe(3); expect(after.totalGroups).toBe(2);
    expect(after.groups?.[0].proof).toBe('pinned_old_source_digest_and_mode');
    expect(after.groups?.[0].members.map((m) => m.path)).toEqual(['one.ts', 'two.ts']);
    expect(after.groups?.flatMap((g) => g.members).every((m) => m.obligations.every((o) => o.status === 'review_required'))).toBe(true);
  });

  it('preserves quoted rename paths and sensitivity from both sides', () => {
    const inventory = deletionInventory([{ path: 'plain.md', patch: 'rename from "scripts/old name.sh"\nrename to plain.md' }]);
    expect(inventory[0]).toMatchObject({ oldPath: 'scripts/old name.sh', sensitive: true });
  });

  it('keeps symlinks and gitlinks separate even if a contents provider could return equal referents', async () => {
    const { runtime, provider } = setup([file('one.ts', '120000'), file('two.ts', '120000'), file('module', '160000')]);
    for (const path of ['one.ts', 'two.ts', 'module']) {
      expect(await runtime.evidence(path)).toMatchObject({ status: 'unavailable', reason: 'unsupported_old_file_mode' });
    }
    expect(provider.readFileAt).not.toHaveBeenCalled();
    expect(runtime.manifest().totalGroups).toBe(3);
  });

  it('extracts removed definitions from complete old source and retains unchanged caller candidates', async () => {
    const { runtime, provider, search } = setup();
    const result: any = await runtime.evidence('old.ts');
    expect(provider.readFileAt).toHaveBeenCalledWith('old.ts', 'merge-base');
    expect(result.packet.oldSha).toBe(OLD);
    expect(result.packet.source.ast.symbols.some((s: any) => s.name === 'guardTenant')).toBe(true);
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.packet.consumers[0]).toMatchObject({ exhaustive: false,
      matches: [{ path: 'unchanged.ts', line: 7, text: 'guardTenant()', snippetTruncated: false }] });
    expect(result).toMatchObject({ authority: 'evidence_only', resolution: 'review_required' });
  });

  it('does not claim shell AST coverage and bounds a >100KB old-source peek', async () => {
    const { runtime, provider } = setup([file('old.sh')]);
    provider.readFileAt.mockImplementation(async (_p, side) => ({ sha: side === 'head' ? HEAD : OLD,
      content: side === 'head' ? null : 'x'.repeat(160_000) + 'guard_tenant_id' }));
    const result: any = await runtime.evidence('old.sh');
    expect(result.packet.source.ast.available).toBe(false);
    expect(result.packet.source.peek).toMatchObject({ truncated: true });
    expect(result.packet.source.peek.end.endsWith('guard_tenant_id')).toBe(true);
    expect(result.packet.source.peek.start.length + result.packet.source.peek.end.length).toBe(4000);
  });

  it('rejects stale search identity and fails soft on search outage without certifying absence', async () => {
    const { runtime, search } = setup();
    search.mockResolvedValueOnce({ status: 'ok', identity: { repository, headSha: OLD }, queryComplete: true,
      exhaustive: true, indexScope: { complete: true }, matches: [], matchCount: 0 });
    search.mockRejectedValueOnce(new Error('outage'));
    const result: any = await runtime.evidence('old.ts');
    expect(result.packet.consumers.map((c: any) => c.reason)).toEqual(['search_identity_mismatch', 'search_failed']);
    expect(result.packet.consumers.every((c: any) => !c.exhaustive && c.matches.length === 0)).toBe(true);
    expect(result.resolution).toBe('review_required');
  });

  it('keeps missing, shortened and wrong-head source unresolved', async () => {
    const { runtime, provider } = setup();
    provider.readFileAt.mockResolvedValueOnce({ sha: OLD, content: null });
    expect(await runtime.evidence('old.ts')).toMatchObject({ status: 'unavailable', reason: 'old_source_unavailable' });
    provider.readFileAt.mockResolvedValueOnce({ sha: OLD, content: 'old' }).mockResolvedValueOnce({ sha: OLD, content: null });
    expect(await runtime.evidence('old.ts')).toMatchObject({ status: 'unavailable', reason: 'head_source_identity_mismatch' });
    const shortened = setup([{ ...file('old.ts'), originalPatchLength: 999_999 } as any]);
    expect(await shortened.runtime.evidence('old.ts')).toMatchObject({ status: 'unavailable' });
    expect(shortened.provider.readFileAt).not.toHaveBeenCalled();
  });

  it('caches closed answers by evidence and pin without discharging a single obligation', async () => {
    const ask = vi.fn(async () => outcome());
    const { runtime } = setup(undefined, { asker: { ask } as unknown as JevAsker, modelPin: 'jev-test' });
    const first: any = await runtime.evidence('old.ts'), second: any = await runtime.evidence('old.ts');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(first.classification).toMatchObject({ status: 'ok', authority: 'evidence_only', evidenceDigest: first.evidenceDigest });
    expect(second.evidenceDigest).toBe(first.evidenceDigest);
    expect(first.packet.obligations.every((o: any) => o.status === 'review_required')).toBe(true);
    expect((ask.mock.calls[0] as any)[0]).toMatchObject({ seam: 'deletion_evidence' });
  });

  it.each(['wrong-pin', 'malformed', 'timeout'])('abstains on %s and retains ordinary review', async (failure) => {
    const ask = vi.fn(async () => failure === 'timeout' ? { status: 'unavailable', reason: 'timeout', durationMs: 1 }
      : failure === 'wrong-pin' ? outcome('different-pin') : { ...outcome(), answers: {} });
    const { runtime } = setup(undefined, { asker: { ask } as unknown as JevAsker, modelPin: 'jev-test' });
    expect(await runtime.evidence('old.ts')).toMatchObject({ classification: { status: 'unavailable', authority: 'none' }, resolution: 'review_required' });
  });

  it('abstains on a choice outside the closed vocabulary, including inherited property names', async () => {
    const answer = outcome(); answer.answers.category.choice = '__proto__';
    const { runtime } = setup(undefined, { asker: { ask: async () => answer } as unknown as JevAsker, modelPin: 'jev-test' });
    expect(await runtime.evidence('old.ts')).toMatchObject({ classification: { status: 'unavailable', reason: 'malformed' }, resolution: 'review_required' });
  });

  it('discloses the question budget cap without dropping later files or their obligations', async () => {
    const ask = vi.fn(async () => outcome());
    const { runtime } = setup(Array.from({ length: 33 }, (_, i) => file(`old-${i}.ts`)),
      { asker: { ask } as unknown as JevAsker, modelPin: 'jev-test' });
    let last: any;
    for (let i = 0; i < 33; i++) last = await runtime.evidence(`old-${i}.ts`);
    expect(ask).toHaveBeenCalledTimes(32);
    expect(last).toMatchObject({ classification: { reason: 'question_budget_exhausted', authority: 'none' }, resolution: 'review_required' });
    expect(runtime.manifest().totalFiles).toBe(33);
  });

  it('cancellation stops before retrieval and never returns a completed classification', async () => {
    const controller = new AbortController(); controller.abort();
    const { runtime, provider } = setup(undefined, { signal: controller.signal });
    await expect(runtime.evidence('old.ts')).rejects.toThrow();
    expect(provider.readFileAt).not.toHaveBeenCalled();
  });

  it('validates tool cursors and paths; the tool envelope never grants exhaustive coverage', async () => {
    const { runtime, provider } = setup();
    const context = { changedFiles: [], repoFileProvider: { ...provider, deletionManifest: runtime.manifest, deletionEvidence: runtime.evidence } };
    const result = await runReadOnlyTool('deletion_evidence', { path: 'old.ts' }, context);
    expect(result.isExhaustive).toBe(false);
    for (const args of [{ offset: 1 }, { limit: 25 }, { digest: 'bad' }, { ref: HEAD }]) {
      expect(JSON.parse((await runReadOnlyTool('deletion_manifest', args, context)).toolOutput).status).toBe('invalid');
    }
    expect(JSON.parse((await runReadOnlyTool('deletion_evidence', { path: '../secret' }, context)).toolOutput).status).toBe('invalid');
  });
});
