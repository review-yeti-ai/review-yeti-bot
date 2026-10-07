import { describe, expect, it, vi } from 'vitest';
import {
  applyGroundedVerificationToPersonas,
  buildDeterministicCoverageManifest,
  runIndependentGroundedVerification,
  GROUNDED_VERIFICATION_VERSION,
} from '../../src/review/groundedReviewEngine';
import { GROUNDED_VERIFICATION_V2_VERSION, groundedCitationManifestDigest, sha256Bytes } from '../../src/review/groundedEvidenceV2';
import { findingFingerprint } from '../../src/review/findingConvergence';
import { REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { groundedRelativeImportCandidates } from '../../src/review/groundedContractResolver';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import type { RepoFileProvider } from '../../src/panel/panelEngine';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const repository = 'example-org/sample-project';

function patch(path: string, oldLine: string, newLine: string): string {
  return `@@ -1 +1 @@\n-${oldLine}\n+${newLine}`;
}

describe('grounded review engine', () => {
  it('verifies a 444,656-byte changed source from bounded source windows and a compact alias response', async () => {
    const path = 'src/large.ts';
    const candidateLine = 3_000;
    const oldLine = `export const claim = '${'old'.padEnd(32, 'x')}';\n`;
    const newLine = `export const claim = '${'new'.padEnd(32, 'x')}';\n`;
    const makeSource = (target: string) => {
      const lines = Array.from({ length: candidateLine + 100 }, (_, index) => `const row${index} = '${'x'.repeat(40)}';\n`);
      lines[candidateLine - 1] = target;
      let source = lines.join('');
      const padding = 444_656 - Buffer.byteLength(source, 'utf8');
      lines[lines.length - 1] = `${lines.at(-1)!.slice(0, -1)}${'x'.repeat(padding)}\n`;
      source = lines.join('');
      return source;
    };
    const current = makeSource(newLine), previous = makeSource(oldLine);
    expect(Buffer.byteLength(current, 'utf8')).toBe(444_656);
    const diff = `@@ -${candidateLine} +${candidateLine} @@\n-${oldLine.slice(0, -1)}\n+${newLine.slice(0, -1)}\n`;
    const changedFiles = [{ path, patch: diff }];
    let visibleEvidence: any;
    const complete = vi.fn(async (request: any) => {
      const content = request.messages[1].content;
      visibleEvidence = JSON.parse(content.match(/<retrieved_repository_evidence>(.*?)<\/retrieved_repository_evidence>/su)[1]);
      const row = visibleEvidence[0];
      const headId = row.head.windows[0].id;
      const baseId = row.base.windows[0].id;
      const diffId = row.diffs[0].id;
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The changed exported value must preserve its validated contract.',
        failurePath: 'A caller reaches the new unsafe value without the required guard.',
        benignCheck: 'The selected changed source contains no guard before the value is returned.',
        changeConnection: 'The admitted added line supplies the unsafe value.',
        rootCause: { componentId: 'large-source.claim', behaviorId: 'unsafe-return',
          contractId: 'validated-export', failureModeId: 'unguarded-value' },
        causeAnchor: { componentPath: path, side: 'head', startLine: candidateLine, endLine: candidateLine,
          citationIds: [headId] },
        causalPath: { relation: 'same-component', candidatePath: path, componentPath: path,
          citationIds: [headId, baseId, diffId] },
        baseState: { trigger: 'absent', contract: 'not-violated', citationIds: [baseId] },
        headState: { trigger: 'present', contract: 'violated', citationIds: [headId] },
        causalDelta: { kind: 'introduced', materiality: 'reachability', citationIds: [diffId] },
        citations: [headId, baseId, diffId] }), usage: null, costUSD: null };
    });
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? current : previous,
        sha: side === 'head' ? head : base, presence: 'present', source: { repository, path, side } }),
      readDiff: () => ({ patch: diff, identity: { repository, headSha: head, baseSha: base } }),
    };

    const verification = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path, line: candidateLine,
      title: 'Unsafe value returned from changed export' }], changedFiles, provider, repository,
      headSha: head, baseSha: base, model: 'test-model', severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      verificationVersion: GROUNDED_VERIFICATION_VERSION,
      client: { complete } as unknown as ReviewModelClient });

    expect(verification.version).toBe(GROUNDED_VERIFICATION_V2_VERSION);
    expect(GROUNDED_VERIFICATION_VERSION).toBe(GROUNDED_VERIFICATION_V2_VERSION);
    expect(verification.outcomes[0]).toMatchObject({ status: 'confirmed', candidateSide: 'head' });
    expect(verification.outcomes[0]?.scopeDecision, JSON.stringify(verification.outcomes[0]?.scopeDecision)).toMatchObject({ causalScope: 'introduced',
      rootCauseEvidenceKey: expect.stringMatching(/^cause-evidence-v1:[a-f0-9]{64}$/u) });
    expect(verification.outcomes[0]?.evidence).toMatchObject({
      rootCause: { componentId: 'large-source.claim' },
      causeAnchor: { componentPath: path, side: 'head', startLine: candidateLine, endLine: candidateLine },
      sourceWindowManifestDigest: expect.any(String),
    });
    const evidence = verification.outcomes[0]?.evidence as any;
    expect(evidence.citations.map((citation: any) => citation.side).sort()).toEqual(['base', 'diff', 'head']);
    expect(evidence.sourceWindowManifestDigest).toBe(groundedCitationManifestDigest(evidence.citations));
    expect(Buffer.byteLength(visibleEvidence[0].head.windows[0].source, 'utf8')).toBeLessThanOrEqual(24_000);
    expect(visibleEvidence[0].head.windows[0].source).not.toContain(current.slice(0, 5_000));
    expect(complete).toHaveBeenCalledOnce();
  });

  it('proves a deleted export still reaches an unchanged pinned caller through bounded reverse-reference evidence', async () => {
    const path = 'src/security.ts';
    const callerPath = 'src/handler.ts';
    const oldDefinition = 'export function authorize(request: Request) {\n  return request.session !== null;\n}\n';
    const caller = "import { authorize } from './security';\nexport function handle(request: Request) { return authorize(request); }\n";
    const diff = `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-export function authorize(request: Request) {\n-  return request.session !== null;\n-}\n`;
    const changedFile = parseChangedFiles(diff, { repository, headSha: head, baseSha: base }).files[0]!;
    const resolutionCandidates = groundedRelativeImportCandidates(callerPath, './security');
    let visibleEvidence: any;
    const findReferences = vi.fn(async (symbol: string, sourcePath: string, side: 'head' | 'base') => ({
      version: 'PinnedSourceReferenceSearch.v1' as const, repository, sourcePath, symbol, side,
      revisionSha: side === 'head' ? head : base, candidatePaths: [callerPath], searchComplete: false,
      scannedFileCount: 12, scannedBytes: 20_000, reason: 'scan_file_limit' as const,
    }));
    const complete = vi.fn(async (request: any) => {
      const content = request.messages[1].content;
      visibleEvidence = JSON.parse(content.match(/<retrieved_repository_evidence>(.*?)<\/retrieved_repository_evidence>/su)[1]);
      const target = visibleEvidence.find((item: any) => item.path === path);
      const callerEvidence = visibleEvidence.find((item: any) => item.path === callerPath);
      const candidateId = target.base.windows.find((window: any) => window.role === 'candidate').id;
      const contractId = target.base.windows.find((window: any) => window.role === 'dependency-contract').id;
      const absenceId = target.head.absence.id;
      const diffId = target.diffs[0].id;
      const baseCallerId = callerEvidence.base.windows.find((window: any) => window.role === 'dependency-caller').id;
      const headCallerId = callerEvidence.head.windows.find((window: any) => window.role === 'dependency-caller').id;
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'Every public authorization contract must remain resolvable by active callers.',
        failurePath: 'The unchanged handler imports the removed export and calls it for every request.',
        benignCheck: 'The deleted definition was the only exact named export satisfying this import.',
        changeConnection: 'The admitted deletion removes the export while the current handler still imports it.',
        rootCause: { componentId: 'security.authorize', behaviorId: 'preserve-auth-export',
          contractId: 'named-import-resolves', failureModeId: 'reachable-missing-export' },
        causeAnchor: { componentPath: path, side: 'base', startLine: 1, endLine: 3, citationIds: [candidateId] },
        causalPath: { relation: 'same-component', candidatePath: path, componentPath: path,
          citationIds: [candidateId, contractId, absenceId, baseCallerId, headCallerId, diffId] },
        baseState: { trigger: 'present', contract: 'not-violated', citationIds: [candidateId, contractId, baseCallerId] },
        headState: { trigger: 'present', contract: 'violated', citationIds: [absenceId, headCallerId] },
        causalDelta: { kind: 'introduced', materiality: 'reachability', citationIds: [diffId] },
        citations: [candidateId, contractId, absenceId, baseCallerId, headCallerId, diffId] }), usage: null, costUSD: null };
    });
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null, findReferences,
      readFileAt: async (requestedPath, side) => {
        const revisionSha = side === 'head' ? head : base;
        const content = requestedPath === path ? (side === 'head' ? null : oldDefinition)
          : requestedPath === callerPath ? caller : null;
        if (requestedPath === path || requestedPath === callerPath) {
          return { content, sha: revisionSha, presence: requestedPath === path && side === 'head' ? 'absent' as const : 'present' as const,
            source: { repository, path: requestedPath, side } };
        }
        if (resolutionCandidates.includes(requestedPath)) return { content: null, sha: revisionSha, presence: 'absent' as const,
          source: { repository, path: requestedPath, side } };
        return { content: null, sha: revisionSha, presence: 'unavailable' as const,
          source: { repository, path: requestedPath, side } };
      },
      readDiff: (requestedPath) => requestedPath === path ? { patch: changedFile.patch!,
        identity: { repository, headSha: head, baseSha: base } } : null,
    };

    const verification = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path, line: 1,
      title: 'Deleted authorization export remains reachable from the handler' }], changedFiles: [changedFile], provider,
      repository, headSha: head, baseSha: base, model: 'test-model', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      client: { complete } as unknown as ReviewModelClient });

    expect(findReferences).toHaveBeenCalledExactlyOnceWith('authorize', path, 'head');
    expect(verification.sourceResolutionProbes).toBe(resolutionCandidates.length + 2);
    expect(verification.sourceResolutionProbes).toBe(verification.sourceResolutionProbeManifest.length);
    expect(verification.calls).toBe(1);
    expect(complete).toHaveBeenCalledOnce();
    expect(visibleEvidence).toHaveLength(2);
    expect(visibleEvidence.find((item: any) => item.path === callerPath)).toMatchObject({
      head: { windows: [expect.objectContaining({ role: 'dependency-caller' })] },
      base: { windows: [expect.objectContaining({ role: 'dependency-caller' })] },
    });
    const callerEvidence = visibleEvidence.find((item: any) => item.path === callerPath);
    expect(callerEvidence.base.windows[0].mapping.edge.resolution).toMatchObject({
      version: 'BoundedRelativeImportResolution.v1', revisionSha: base, state: 'resolved', resolvedPath: path,
      probes: expect.arrayContaining([expect.objectContaining({ path, presence: 'present' })]),
    });
    expect(callerEvidence.head.windows[0].mapping.edge.resolution).toMatchObject({
      version: 'BoundedRelativeImportResolution.v1', revisionSha: head, state: 'unresolved', resolvedPath: null,
      probes: expect.arrayContaining([expect.objectContaining({ path, presence: 'absent', sourceDigest: null })]),
    });
    expect(verification.outcomes[0], JSON.stringify(verification.outcomes[0])).toMatchObject({
      status: 'confirmed', candidateSide: 'base', scopeDecision: { causalScope: 'introduced' },
    });
    expect(verification.outcomes[0]?.evidence?.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path, side: 'head', presence: 'absent' }),
      expect.objectContaining({ path: callerPath, side: 'head', window: expect.objectContaining({ role: 'dependency-caller' }) }),
      expect.objectContaining({ path, side: 'base', window: expect.objectContaining({ role: 'dependency-contract' }) }),
    ]));
  });

  it('does not treat an extensionless deleted-path candidate as the unique active import when an index fallback exists', async () => {
    const path = 'src/security.ts';
    const callerPath = 'src/handler.ts';
    const fallbackPath = 'src/security/index.ts';
    const oldDefinition = 'export function authorize(request: Request) { return request.session !== null; }\n';
    const caller = "import { authorize } from './security';\nexport function handle(request: Request) { return authorize(request); }\n";
    const fallback = 'export function authorize(request: Request) { return true; }\n';
    const resolutionCandidates = groundedRelativeImportCandidates(callerPath, './security');
    const diff = `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-${oldDefinition}`;
    const changedFile = parseChangedFiles(diff, { repository, headSha: head, baseSha: base }).files[0]!;
    const findReferences = vi.fn(async (symbol: string, sourcePath: string, side: 'head' | 'base') => ({
      version: 'PinnedSourceReferenceSearch.v1' as const, repository, sourcePath, symbol, side,
      revisionSha: side === 'head' ? head : base, candidatePaths: [callerPath], searchComplete: false,
      scannedFileCount: 12, scannedBytes: 20_000, reason: 'scan_file_limit' as const,
    }));
    const complete = vi.fn(async () => ({ model: 'must-not-run', content: '', usage: null, costUSD: null }));
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null, findReferences,
      readFileAt: async (requestedPath, side) => {
        const revisionSha = side === 'head' ? head : base;
        if (requestedPath === path) return { content: side === 'head' ? null : oldDefinition,
          sha: revisionSha, presence: side === 'head' ? 'absent' as const : 'present' as const,
          source: { repository, path: requestedPath, side } };
        if (requestedPath === callerPath) return { content: caller, sha: revisionSha, presence: 'present' as const,
          source: { repository, path: requestedPath, side } };
        if (requestedPath === fallbackPath && side === 'head') return { content: fallback, sha: revisionSha,
          presence: 'present' as const, source: { repository, path: requestedPath, side } };
        if (resolutionCandidates.includes(requestedPath)) return { content: null, sha: revisionSha, presence: 'absent' as const,
          source: { repository, path: requestedPath, side } };
        return { content: null, sha: revisionSha, presence: 'unavailable' as const,
          source: { repository, path: requestedPath, side } };
      },
      readDiff: (requestedPath) => requestedPath === path ? { patch: changedFile.patch!,
        identity: { repository, headSha: head, baseSha: base } } : null,
    };
    const verification = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path, line: 1,
      title: 'Deleted authorization export remains reachable from the handler' }], changedFiles: [changedFile], provider,
      repository, headSha: head, baseSha: base, model: 'test-model', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      client: { complete } as unknown as ReviewModelClient });

    expect(findReferences).toHaveBeenCalledExactlyOnceWith('authorize', path, 'head');
    expect(verification.outcomes[0]).toMatchObject({ status: 'insufficient' });
    expect(verification.coverageComplete).toBe(false);
    expect(verification.sourceResolutionProbes).toBeGreaterThan(0);
    expect(verification.sourceResolutionProbes).toBe(verification.sourceResolutionProbeManifest.length);
    expect(verification.calls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('verifies a changed caller against a complete small contract window inside a large helper file', async () => {
    const callerPath = 'src/caller.ts';
    const helperPath = 'src/helper.ts';
    const importLine = "import { safeHelper } from './helper';\n";
    const oldCall = 'export function run(value: string) { return value; }\n';
    const newCall = 'export function run(value: string) { return safeHelper(value); }\n';
    const callerBase = `${importLine}${oldCall}`;
    const callerHead = `${importLine}${newCall}`;
    const definition = 'export function safeHelper(value: string) { return value.trim(); }\n';
    const makeHelper = (targetLine: number) => {
      const lines = Array.from({ length: 1_000 }, (_, index) => `const row${index} = '${'x'.repeat(40)}';\n`);
      lines[targetLine - 1] = definition;
      return lines.join('');
    };
    const helperBase = makeHelper(501);
    const helperHead = makeHelper(501);
    expect(Buffer.byteLength(helperHead, 'utf8')).toBeGreaterThan(24_000);
    const diff = '@@ -2 +2 @@\n-export function run(value: string) { return value; }\n+export function run(value: string) { return safeHelper(value); }\n';
    let responseBuilderError: string | undefined;
    let visibleCrossFileEvidence: any;
    const complete = vi.fn(async (request: any) => {
      try {
        const body = request.messages[1].content;
        const files = JSON.parse(body.match(/<retrieved_repository_evidence>(.*?)<\/retrieved_repository_evidence>/su)[1]);
        visibleCrossFileEvidence = files;
        const caller = files.find((file: any) => file.path === callerPath);
        const helper = files.find((file: any) => file.path === helperPath);
        const candidateHead = caller.head.windows.find((window: any) => window.role === 'candidate').id;
        const mappedBase = caller.base.windows.find((window: any) => window.role === 'mapped-base').id;
        const callerHead = caller.head.windows.find((window: any) => window.role === 'dependency-caller').id;
        const callerBase = caller.base.windows.find((window: any) => window.role === 'dependency-caller').id;
        const contractHead = helper.head.windows.find((window: any) => window.role === 'dependency-contract').id;
        const contractBase = helper.base.windows.find((window: any) => window.role === 'dependency-contract').id;
        const diffId = caller.diffs[0].id;
        const citations = [candidateHead, mappedBase, callerHead, callerBase, contractHead, contractBase, diffId];
        return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The helper contract requires validated data.',
        failurePath: 'The new changed caller sends unvalidated input to the helper.',
        benignCheck: 'The helper is only safe when its caller performs validation.',
        changeConnection: 'The admitted callsite newly reaches the helper without validation.',
        rootCause: { componentId: 'helper.safehelper', behaviorId: 'consume-unvalidated-value',
          contractId: 'caller-validates-input', failureModeId: 'validation-bypassed' },
        causeAnchor: { componentPath: helperPath, side: 'head', startLine: 501, endLine: 501,
          citationIds: [contractHead] },
        causalPath: { relation: 'dependency-edge', candidatePath: callerPath, componentPath: helperPath,
          citationIds: [candidateHead, mappedBase, callerHead, callerBase, contractHead, contractBase, diffId] },
        baseState: { trigger: 'absent', contract: 'not-violated', citationIds: [mappedBase, callerBase, contractBase] },
        headState: { trigger: 'present', contract: 'violated', citationIds: [candidateHead, callerHead, contractHead] },
          causalDelta: { kind: 'introduced', materiality: 'reachability', citationIds: [diffId] }, citations }),
          usage: null, costUSD: null };
      } catch (error) {
        responseBuilderError = `${error instanceof Error ? error.message : String(error)}; evidence=${JSON.stringify(visibleCrossFileEvidence)}`;
        throw error;
      }
    });
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (requestedPath, side) => {
        const content = requestedPath === callerPath ? (side === 'head' ? callerHead : callerBase)
          : requestedPath === helperPath ? (side === 'head' ? helperHead : helperBase) : null;
        return { content, sha: side === 'head' ? head : base, presence: content === null ? 'absent' : 'present',
          source: { repository, path: requestedPath, side } };
      },
      readDiff: (requestedPath) => requestedPath === callerPath ? { patch: diff,
        identity: { repository, headSha: head, baseSha: base } } : null,
    };
    const verification = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path: callerPath,
      line: 2, title: 'Changed caller violates the imported validation contract' }],
      changedFiles: [{ path: callerPath, patch: diff }], provider, repository, headSha: head, baseSha: base,
      model: 'test-model', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2, client: { complete } as unknown as ReviewModelClient });

    expect(complete).toHaveBeenCalledOnce();
    expect(responseBuilderError).toBeUndefined();
    expect(verification.outcomes[0], JSON.stringify(verification.outcomes[0])).toMatchObject({ status: 'confirmed',
      scopeDecision: { causalScope: 'introduced' },
      evidence: { causalPath: { relation: 'dependency-edge', componentPath: helperPath } } });
    const evidence = verification.outcomes[0]?.evidence as any;
    expect(evidence.citations.find((citation: any) => citation.path === helperPath
      && citation.window?.role === 'dependency-contract')?.window.fullContentSha256).toBe(sha256Bytes(Buffer.from(helperHead)));
    expect(evidence.citations.filter((citation: any) => citation.window?.role === 'dependency-contract')
      .every((citation: any) => citation.window.byteLength <= 24_000)).toBe(true);
  });

  it('enforces the existing per-file-side cap across multiple contract windows in one evidence packet', async () => {
    const callerPath = 'src/caller.ts';
    const helperPath = 'src/contracts.ts';
    const symbols = Array.from({ length: 12 }, (_, index) => `helper${index}`);
    const imports = `import { ${symbols.join(', ')} } from './contracts';\n`;
    const oldCall = 'export function run(value: string) { return value; }\n';
    let expression = 'value';
    for (const symbol of symbols) expression = `${symbol}(${expression})`;
    const newCall = `export function run(value: string) { return ${expression}; }\n`;
    const callerBase = `${imports}${oldCall}`;
    const callerHead = `${imports}${newCall}`;
    const largeLine = (index: number) => `const row${index} = '${'x'.repeat(500)}';\n`;
    const helperLines = Array.from({ length: 1_200 }, (_, index) => largeLine(index));
    symbols.forEach((symbol, index) => {
      helperLines[50 + index * 80] = `export function ${symbol}(value: string) { return value.trim(); }\n`;
    });
    const helper = helperLines.join('');
    const diff = `@@ -2 +2 @@\n-${oldCall.slice(0, -1)}\n+${newCall.slice(0, -1)}\n`;
    const complete = vi.fn();
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (requestedPath, side) => {
        const content = requestedPath === callerPath ? (side === 'head' ? callerHead : callerBase)
          : requestedPath === helperPath ? helper : null;
        return { content, sha: side === 'head' ? head : base, presence: content === null ? 'absent' : 'present',
          source: { repository, path: requestedPath, side } };
      },
      readDiff: (requestedPath) => requestedPath === callerPath ? { patch: diff,
        identity: { repository, headSha: head, baseSha: base } } : null,
    };
    const verification = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path: callerPath,
      line: 2, title: 'Changed caller crosses multiple imported contract windows' }],
      changedFiles: [{ path: callerPath, patch: diff }], provider, repository, headSha: head, baseSha: base,
      model: 'test-model', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2, client: { complete } as unknown as ReviewModelClient });

    expect(verification.outcomes[0]).toMatchObject({ status: 'insufficient' });
    expect(verification.outcomes[0]?.reason).toContain('per-file-side verifier bound');
    expect(verification.calls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps a proven preexisting P1 in baseline evidence and removes it from new-PR findings', async () => {
    const path = 'src/parser.ts';
    const previous = 'function parse(value) { return eval(value); }\n// old note\n';
    const current = 'function parse(value) { return eval(value); }\n// new note\n';
    const patch = '@@ -2 +2 @@\n-// old note\n+// new note\n';
    const changedFiles = [{ path, patch }];
    const finding = { severity: 'P1', path, line: 2, title: 'Unsafe evaluation of untrusted input' };
    const client = { complete: async (request: any) => {
      const body = request.messages[1].content;
      const file = JSON.parse(body.match(/<retrieved_repository_evidence>(.*?)<\/retrieved_repository_evidence>/su)[1])[0];
      const headId = file.head.windows[0].id;
      const baseId = file.base.windows[0].id;
      const diffId = file.diffs[0].id;
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'Untrusted input must not be executed.', failurePath: 'The parsed input reaches eval.',
        benignCheck: 'The source contains no validation before eval.',
        changeConnection: 'The unsafe evaluation is identical on both source sides and the patch only edits a comment.',
        rootCause: { componentId: 'parser.evaluate', behaviorId: 'execute-user-input',
          contractId: 'input-must-be-data', failureModeId: 'unsafe-evaluation' },
        causeAnchor: { componentPath: path, side: 'head', startLine: 1, endLine: 1, citationIds: [headId] },
        causalPath: { relation: 'same-component', candidatePath: path, componentPath: path,
          citationIds: [headId, baseId, diffId] },
        baseState: { trigger: 'present', contract: 'violated', citationIds: [baseId] },
        headState: { trigger: 'present', contract: 'violated', citationIds: [headId] },
        causalDelta: { kind: 'unaffected', citationIds: [diffId] }, citations: [headId, baseId, diffId] }),
        usage: null, costUSD: null };
    } } as unknown as ReviewModelClient;
    const provider: RepoFileProvider = { findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? current : previous,
        sha: side === 'head' ? head : base, presence: 'present', source: { repository, path, side } }),
      readDiff: () => ({ patch, identity: { repository, headSha: head, baseSha: base } }) };
    const verification = await runIndependentGroundedVerification({ findings: [finding], changedFiles, provider, repository,
      headSha: head, baseSha: base, verificationVersion: GROUNDED_VERIFICATION_VERSION,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2, model: 'test-model', client });
    expect(verification.outcomes[0]).toMatchObject({ status: 'confirmed', severity: 'P1',
      scopeDecision: { causalScope: 'preexisting' } });

    const filtered = applyGroundedVerificationToPersonas([{ id: 'security', findings: [finding] }], verification,
      changedFiles, REVIEW_SEVERITY_POLICY_V2, { repository, baseSha: base, headSha: head });
    expect(filtered.personas[0].findings).toEqual([]);
    expect(filtered.baselineContextFindings).toEqual([finding]);
    expect(filtered.unverifiedBlockerCount).toBe(0);
    expect(filtered.coverageComplete).toBe(true);
  });

  it('fails before a verifier call when bounded imported contract windows exceed the aggregate cap', async () => {
    const path = 'src/consumer.ts';
    const importLines = Array.from({ length: 12 }, (_, index) => `import { Contract${index} } from './contracts/c${index}';\n`);
    const oldCall = 'export function use() { return Contract0("old"); }\n';
    const newCall = 'export function use() { return Contract0("new"); }\n';
    const previous = `${importLines.join('')}${oldCall}`;
    const current = `${importLines.join('')}${newCall}`;
    const line = importLines.length + 1;
    const patch = `@@ -${line} +${line} @@\n-${oldCall.slice(0, -1)}\n+${newCall.slice(0, -1)}\n`;
    const contractSource = (symbol: string) => `export function ${symbol}(value: string) { const data = "${'x'.repeat(8_000)}"; return value; }\n`;
    const changedFiles = [{ path, patch }];
    const complete = vi.fn();
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (requestedPath, side) => {
        const content = requestedPath === path ? (side === 'head' ? current : previous)
          : /^src\/contracts\/c\d+\.ts$/u.test(requestedPath)
            ? contractSource(`Contract${Number(requestedPath.match(/c(\d+)\.ts$/u)?.[1])}`) : null;
        return { content, sha: side === 'head' ? head : base,
          presence: content === null ? 'absent' : 'present', source: { repository, path: requestedPath, side } };
      },
      readDiff: (requestedPath) => requestedPath === path
        ? { patch, identity: { repository, headSha: head, baseSha: base } } : null,
    };

    const result = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path, line,
      title: 'Changed caller violates an imported contract' }], changedFiles, provider, repository,
      headSha: head, baseSha: base, model: 'test-model', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      client: { complete } as unknown as ReviewModelClient });

    expect(result.outcomes[0]).toMatchObject({ status: 'insufficient' });
    expect(result.outcomes[0]?.reason).toContain('aggregate verifier bound');
    expect(result.calls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'forged compact citation alias', response: JSON.stringify({ status: 'confirmed', citations: ['e999'] }) },
    { label: 'oversized truncated response', response: `${JSON.stringify({ status: 'insufficient', citations: [] })}${' '.repeat(6_001)}` },
  ])('keeps a v2 $label insufficient without proof', async ({ response }) => {
    const path = 'src/alias.ts';
    const previous = 'oldOperation();\n';
    const current = 'newOperation();\n';
    const patch = '@@ -1 +1 @@\n-oldOperation();\n+newOperation();\n';
    const changedFiles = [{ path, patch }];
    const complete = vi.fn(async () => ({ model: 'test-verifier', content: response, usage: null, costUSD: null }));
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? current : previous,
        sha: side === 'head' ? head : base, presence: 'present', source: { repository, path, side } }),
      readDiff: () => ({ patch, identity: { repository, headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path, line: 1,
      title: 'Unsafe changed call' }], changedFiles, provider, repository, headSha: head, baseSha: base,
      verificationVersion: GROUNDED_VERIFICATION_VERSION, model: 'test-model', client: { complete } as unknown as ReviewModelClient });
    expect(result.outcomes[0]).toMatchObject({ status: 'insufficient' });
    expect(result.outcomes[0]?.evidence).toBeUndefined();
    expect(result.unverifiedBlockerCount).toBe(1);
    expect(result.coverageComplete).toBe(false);
    expect(result.calls).toBe(1);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('rejects a stale provider content digest without burning a v2 verifier call', async () => {
    const path = 'src/stale.ts';
    const previous = 'oldOperation();\n';
    const current = 'newOperation();\n';
    const patch = '@@ -1 +1 @@\n-oldOperation();\n+newOperation();\n';
    const complete = vi.fn();
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? current : previous,
        contentSha256: 'f'.repeat(64), sha: side === 'head' ? head : base, presence: 'present',
        source: { repository, path, side } }),
      readDiff: () => ({ patch, identity: { repository, headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path, line: 1,
      title: 'Unsafe changed call' }], changedFiles: [{ path, patch }], provider, repository,
      headSha: head, baseSha: base, verificationVersion: GROUNDED_VERIFICATION_VERSION, model: 'test-model',
      client: { complete } as unknown as ReviewModelClient });
    expect(result.outcomes[0]).toMatchObject({ status: 'insufficient' });
    expect(result.calls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses the configured alternate only for a trusted matching disputed P1 and does not fall back on failure', async () => {
    const path = 'src/disputed.ts';
    const title = 'Previously confirmed authorization defect';
    const finding = { severity: 'P1', path, line: 1, title };
    const previous = 'oldOperation();\n';
    const current = 'newOperation();\n';
    const patch = '@@ -1 +1 @@\n-oldOperation();\n+newOperation();\n';
    const primary = vi.fn();
    const adjudicator = vi.fn(async (_request: any, _context?: any) => ({ model: 'reported-upstream-model',
      content: JSON.stringify({ status: 'insufficient', citations: [] }), usage: null, costUSD: null }));
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? current : previous,
        sha: side === 'head' ? head : base, presence: 'present', source: { repository, path, side } }),
      readDiff: () => ({ patch, identity: { repository, headSha: head, baseSha: base } }),
    };
    const dispute = { findingFingerprint: findingFingerprint({ path, title }), priorFindingEventId: 'event-auth-1',
      priorEvidenceDigest: 'f'.repeat(64) };
    const result = await runIndependentGroundedVerification({ findings: [finding], changedFiles: [{ path, patch }], provider,
      repository, headSha: head, baseSha: base, model: 'primary-alias', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      authenticatedDisputes: [dispute], disputedBlockerAdjudicator: { model: 'adjudicator-alias',
        client: { complete: adjudicator } as unknown as ReviewModelClient },
      client: { complete: primary } as unknown as ReviewModelClient });
    expect(adjudicator).toHaveBeenCalledOnce();
    expect(primary).not.toHaveBeenCalled();
    expect(adjudicator.mock.calls[0]?.[1]).toEqual({ version: 'GroundedVerifierRequestContext.v1',
      findingFingerprint: dispute.findingFingerprint, severity: 'P1', purpose: 'disputed-blocker-recheck',
      requestedRole: 'disputed-blocker-adjudicator', appliedRole: 'disputed-blocker-adjudicator',
      configuredAlternateModel: 'adjudicator-alias', selectedModel: 'adjudicator-alias' });
    expect(adjudicator.mock.calls[0]?.[0]).not.toHaveProperty('groundedVerifierContext');
    expect(JSON.stringify(adjudicator.mock.calls[0]?.[0])).not.toContain('GroundedVerifierRequestContext.v1');
    expect(result.outcomes[0]).toMatchObject({ status: 'insufficient', verifierRoute: {
      purpose: 'disputed-blocker-recheck', requestedRole: 'disputed-blocker-adjudicator',
      appliedRole: 'disputed-blocker-adjudicator', configuredAlternateModel: 'adjudicator-alias',
      selectedModel: 'adjudicator-alias', responseReportedModel: 'reported-upstream-model',
      upstreamIdentity: { providerId: null, model: null },
    } });

    const primaryFallback = vi.fn(async (_request: any, _context?: any) => ({ model: 'primary-reported-model',
      content: JSON.stringify({ status: 'insufficient', citations: [] }), usage: null, costUSD: null }));
    const fallback = await runIndependentGroundedVerification({ findings: [finding], changedFiles: [{ path, patch }], provider,
      repository, headSha: head, baseSha: base, model: 'primary-alias', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      authenticatedDisputes: [dispute], client: { complete: primaryFallback } as unknown as ReviewModelClient });
    expect(primaryFallback).toHaveBeenCalledOnce();
    expect(primaryFallback.mock.calls[0]?.[1]).toEqual({ version: 'GroundedVerifierRequestContext.v1',
      findingFingerprint: dispute.findingFingerprint, severity: 'P1', purpose: 'disputed-blocker-recheck',
      requestedRole: 'disputed-blocker-adjudicator', appliedRole: 'primary',
      configuredAlternateModel: null, selectedModel: 'primary-alias' });
    expect(fallback.outcomes[0]?.verifierRoute).toMatchObject({ purpose: 'disputed-blocker-recheck',
      requestedRole: 'disputed-blocker-adjudicator', appliedRole: 'primary', configuredAlternateModel: null,
      selectedModel: 'primary-alias', responseReportedModel: 'primary-reported-model' });

    const ordinaryPrimary = vi.fn(async (_request: any, _context?: any) => ({ model: 'ordinary-reported-model',
      content: JSON.stringify({ status: 'insufficient', citations: [] }), usage: null, costUSD: null }));
    await runIndependentGroundedVerification({ findings: [finding], changedFiles: [{ path, patch }], provider,
      repository, headSha: head, baseSha: base, model: 'primary-alias', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      client: { complete: ordinaryPrimary } as unknown as ReviewModelClient });
    expect(ordinaryPrimary.mock.calls[0]?.[1]).toEqual({ version: 'GroundedVerifierRequestContext.v1',
      findingFingerprint: dispute.findingFingerprint, severity: 'P1', purpose: 'primary',
      requestedRole: 'primary', appliedRole: 'primary', configuredAlternateModel: null, selectedModel: 'primary-alias' });
    expect(JSON.stringify(ordinaryPrimary.mock.calls[0]?.[0])).not.toContain('GroundedVerifierRequestContext.v1');

    const legacyClient = vi.fn(async (_request: any, _context?: any) => ({ model: 'legacy-reported-model',
      content: JSON.stringify({ status: 'insufficient', reason: 'Legacy verification cannot confirm.' }), usage: null, costUSD: null }));
    await runIndependentGroundedVerification({ findings: [finding], changedFiles: [{ path, patch }], provider,
      repository, headSha: head, baseSha: base, model: 'primary-alias',
      verificationVersion: 'GroundedIndependentVerification.v1',
      client: { complete: legacyClient } as unknown as ReviewModelClient });
    expect(legacyClient.mock.calls[0]).toHaveLength(1);

    const failingAdjudicator = vi.fn(async () => { throw new Error('alternate transport failed'); });
    const failed = await runIndependentGroundedVerification({ findings: [finding], changedFiles: [{ path, patch }], provider,
      repository, headSha: head, baseSha: base, model: 'primary-alias', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      authenticatedDisputes: [dispute], disputedBlockerAdjudicator: { model: 'adjudicator-alias',
        client: { complete: failingAdjudicator } as unknown as ReviewModelClient },
      client: { complete: primary } as unknown as ReviewModelClient });
    expect(failingAdjudicator).toHaveBeenCalledOnce();
    expect(primary).not.toHaveBeenCalled();
    expect(failed.outcomes[0]).toMatchObject({ status: 'insufficient', verifierRoute: {
      requestedRole: 'disputed-blocker-adjudicator', appliedRole: 'disputed-blocker-adjudicator',
      selectedModel: 'adjudicator-alias', responseReportedModel: null,
      responseModelUnavailableReason: 'The verifier call failed before a response was observed.',
    } });
  });

  it.each([
    { path: 'src/unresolved.ts', head: "import { Missing } from './missing';\nexport const changed = newValue();\n",
      base: "import { Missing } from './missing';\nexport const changed = oldValue();\n",
      patch: "@@ -2 +2 @@\n-export const changed = oldValue();\n+export const changed = newValue();\n", line: 2,
      missing: 'relative import contract could not be resolved' },
    { path: 'src/legacy.c', head: '#include "contract.h"\nunsafe_call();\n', base: '#include "contract.h"\nsafe_call();\n',
      patch: '@@ -2 +2 @@\n-safe_call();\n+unsafe_call();\n', line: 2,
      missing: 'C/C++ include dependencies are not supported' },
  ])('keeps unresolved contract syntax explicit and makes no call for $path', async ({ path, head: current, base: previous, patch, line, missing }) => {
    const changedFiles = [{ path, patch }];
    const complete = vi.fn();
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (requestedPath, side) => {
        const content = requestedPath === path ? (side === 'head' ? current : previous) : null;
        return { content, sha: side === 'head' ? head : base, presence: content === null ? 'absent' : 'present',
          source: { repository, path: requestedPath, side } };
      },
      readDiff: () => ({ patch, identity: { repository, headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path, line,
      title: 'Changed behavior lacks a required imported contract' }], changedFiles, provider, repository,
      headSha: head, baseSha: base, model: 'test-model', verificationVersion: GROUNDED_VERIFICATION_VERSION,
      client: { complete } as unknown as ReviewModelClient });
    expect(result.outcomes[0]).toMatchObject({ status: 'insufficient' });
    expect(result.outcomes[0]?.reason).toContain(missing);
    expect(result.calls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'added', path: 'src/new.ts', line: 1, absentSide: 'base' as const,
      diff: 'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const value = unsafe();\n',
      current: 'export const value = unsafe();', previous: null,
    },
    {
      kind: 'deleted', path: 'src/old.ts', line: 1, absentSide: 'head' as const,
      diff: 'diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const value = unsafe();\n',
      current: null, previous: 'export const value = unsafe();',
    },
  ])('grounds a $kind file through an authenticated absent source side', async ({ path, line, absentSide, diff, current, previous }) => {
    const file = parseChangedFiles(diff, { repository, headSha: head, baseSha: base }).files[0];
    const absentCommit = absentSide === 'head' ? head : base;
    const complete = vi.fn(async (request: any) => {
      const userMessage = request.messages[1].content;
      expect(userMessage).toContain('"absent"');
      expect(userMessage).toContain(`"side":"${absentSide}"`);
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The exported value must not invoke an unsafe operation.',
        failurePath: 'A caller reaches the unsafe operation through the exported value.',
        benignCheck: 'The changed source has no validation before the call.',
        changeConnection: `The ${absentSide === 'base' ? 'added' : 'deleted'} file supplies the causal behavior.`,
        citations: ['head:' + path, 'base:' + path, 'diff:' + path] }), usage: null, costUSD: null };
    });
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (requestedPath, side) => {
        const absent = (side === 'head' && current === null) || (side === 'base' && previous === null);
        return {
          content: side === 'head' ? current : previous,
          sha: side === 'head' ? head : base,
          presence: absent ? 'absent' : 'present',
          source: { repository, path: requestedPath, side },
        } as Awaited<ReturnType<NonNullable<RepoFileProvider['readFileAt']>>>;
      },
      readDiff: () => ({ patch: file.patch!,
        identity: { repository, headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({
      findings: [{ severity: 'P1', path, line, title: 'Unsafe exported behavior' }],
      changedFiles: [file], provider, repository, headSha: head, baseSha: base,
      model: 'test-model', client: { complete } as unknown as ReviewModelClient,
    });
    expect(result.outcomes[0].status, JSON.stringify(result.outcomes[0])).toBe('confirmed');
    expect(complete).toHaveBeenCalledOnce();
    expect(result.outcomes[0].evidence?.citations).toContainEqual(expect.objectContaining({
      id: `${absentSide}:${path}`, side: absentSide, sha: absentCommit, presence: 'absent',
    }));
  });

  it.each(['absent', 'unavailable'] as const)(
    'keeps an expected-present candidate source reported as %s incomplete without calling the verifier', async (presence) => {
    const path = 'src/unavailable.ts';
    const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-oldValue();\n+newValue();\n`;
    const file = parseChangedFiles(diff, { repository, headSha: head, baseSha: base }).files[0];
    const complete = vi.fn();
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_requestedPath, side) => ({ content: null, sha: side === 'head' ? head : base,
        presence, source: { repository, path, side } }) as Awaited<ReturnType<NonNullable<RepoFileProvider['readFileAt']>>>,
      readDiff: () => ({ patch: file.patch!, identity: { repository, headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({ findings: [{ severity: 'P1', path, line: 1,
      title: 'Changed behavior is unsafe' }], changedFiles: [file], provider, repository,
      headSha: head, baseSha: base, model: 'test-model', client: { complete } as unknown as ReviewModelClient });
    expect(result.outcomes[0].status).toBe('insufficient');
    expect(result.coverageComplete).toBe(false);
    expect(result.unverifiedBlockerCount).toBe(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('assigns every changed region deterministically without truncating the 24-partition ceiling', () => {
    const files = Array.from({ length: 31 }, (_, index) => ({ path: `src/file-${index}.ts`,
      patch: `@@ -1 +1 @@\n-old-${index}\n+new-${index}\n@@ -10 +10 @@\n-old-again-${index}\n+new-again-${index}` }));
    const first = buildDeterministicCoverageManifest(files, { maxAssignments: 24 });
    const second = buildDeterministicCoverageManifest([...files].reverse(), { maxAssignments: 24 });
    expect(first.complete).toBe(true);
    expect(first.assignments).toHaveLength(24);
    expect(first.regions).toHaveLength(62);
    expect(first.coveredRegionIds).toHaveLength(first.regions.length);
    expect([...new Set(first.regions.map((region) => region.path))].sort()).toEqual(files.map((file) => file.path).sort());
    for (const path of files.map((file) => file.path)) {
      expect(new Set(first.regions.filter((region) => region.path === path).map((region) => region.assignmentId)).size).toBe(1);
    }
    expect(first.digest).toBe(second.digest);
    const omitted = buildDeterministicCoverageManifest([{ path: 'src/omitted.ts',
      patch: '\\ Review Yeti: patch unavailable (omitted by GitHub; 20 changed lines)' }]);
    expect(omitted.complete).toBe(false);
    expect(omitted.omissions).toContain('patch-unavailable:src/omitted.ts');
  });

  it('keeps slow P1 evidence ahead of fast P2 calls without making advisory overflow blocking', async () => {
    const changedFiles = Array.from({ length: 25 }, (_, index) => {
      const path = index === 24 ? 'src/z24.ts' : `src/a${String(index).padStart(2, '0')}.ts`;
      return { path, patch: patch(path, 'before()', 'after()') };
    });
    const changedByPath = new Map(changedFiles.map((file) => [file.path, file]));
    const contractPaths = Array.from({ length: 12 }, (_, index) => `src/contracts/c${String(index).padStart(2, '0')}.ts`);
    const imports = contractPaths.map((path, index) =>
      `import { Contract${index} } from './contracts/c${String(index).padStart(2, '0')}.ts';`).join('\n');
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (path, side) => {
        if (path.startsWith('src/contracts/')) await new Promise((resolve) => setTimeout(resolve, 100));
        const file = changedByPath.get(path);
        if (file) return { content: path === 'src/a00.ts'
          ? `${imports}\nexport const changed = '${side === 'head' ? 'after' : 'before'}';`
          : `export const changed = '${side === 'head' ? 'after' : 'before'}';`,
        sha: side === 'head' ? head : base };
        if (contractPaths.includes(path)) return { content: `export type Contract${contractPaths.indexOf(path)} = string;`,
          sha: side === 'head' ? head : base };
        return { content: null, sha: side === 'head' ? head : base };
      },
      readDiff: (path) => {
        const file = changedByPath.get(path);
        return file ? { patch: file.patch,
          identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } } : null;
      },
    };
    let activeCalls = 0;
    let peakConcurrentCalls = 0;
    const complete = vi.fn(async (request: any) => {
      activeCalls += 1;
      peakConcurrentCalls = Math.max(peakConcurrentCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const claim = JSON.parse(request.messages[1].content.match(/<claim>(.*?)<\/claim>/su)[1]);
      activeCalls -= 1;
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The changed contract must be respected.',
        failurePath: 'The changed branch violates the contract.', benignCheck: 'No guard preserves the contract.',
        changeConnection: 'The admitted patch adds the violating branch.',
        citations: [`head:${claim.path}`, `base:${claim.path}`, `diff:${claim.path}`] }), usage: null, costUSD: null };
    });
    const findings = [
      ...Array.from({ length: 3 }, (_, index) => ({ severity: 'P1', path: 'src/a00.ts', line: 1,
        title: `Blocker hypothesis ${index + 1}` })),
      ...Array.from({ length: 22 }, (_, index) => ({ severity: 'P2', path: 'src/z24.ts', line: 1,
        title: `Advisory hypothesis ${String(index + 1).padStart(2, '0')}` })),
    ];

    const verification = await runIndependentGroundedVerification({ findings, changedFiles, provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      client: { complete } as unknown as ReviewModelClient,
      budget: { totalCalls: 12, callsPerTask: 12, concurrency: 18, stageBudgetMs: 10_000 },
    });

    expect(verification.calls).toBe(12);
    expect(verification.outcomes.filter((row) => row.severity === 'P1' && row.status === 'confirmed')).toHaveLength(3);
    expect(verification.outcomes.filter((row) => row.severity === 'P2' && row.status === 'confirmed')).toHaveLength(9);
    expect(verification.outcomes.filter((row) => row.severity === 'P2' && row.status === 'insufficient')).toHaveLength(13);
    expect(verification.unverifiedBlockerCount).toBe(0);
    expect(verification.coverageComplete).toBe(true);
    expect(peakConcurrentCalls).toBeGreaterThan(1);
    expect(peakConcurrentCalls).toBeLessThanOrEqual(18);

    const applied = applyGroundedVerificationToPersonas([{ id: 'security', findings }], verification,
      changedFiles, REVIEW_SEVERITY_POLICY_V2);
    expect(applied.unverifiedBlockerCount).toBe(0);
    expect(applied.coverageComplete).toBe(true);
    expect(applied.personas[0].findings).toHaveLength(25);

    const failedP1Provider: RepoFileProvider = { ...provider, readFileAt: async (path, side) =>
      path === 'src/a00.ts' && side === 'base' ? { content: null, sha: base } : provider.readFileAt!(path, side) };
    const oneP1SourceFails = await runIndependentGroundedVerification({ findings: [findings[0],
      { severity: 'P1', path: 'src/a01.ts', line: 1, title: 'Second blocker hypothesis' }, ...findings.slice(3)],
    changedFiles, provider: failedP1Provider, repository: 'example-org/sample-project', headSha: head, baseSha: base,
    model: 'test-model', severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
    client: { complete } as unknown as ReviewModelClient,
    budget: { totalCalls: 12, callsPerTask: 12, concurrency: 18, stageBudgetMs: 10_000 },
    });
    expect(oneP1SourceFails.calls).toBe(12);
    expect(oneP1SourceFails.outcomes.filter((row) => row.severity === 'P1' && row.status === 'confirmed')).toHaveLength(1);
    expect(oneP1SourceFails.outcomes.filter((row) => row.severity === 'P1' && row.status === 'insufficient')).toHaveLength(1);
    expect(oneP1SourceFails.outcomes.filter((row) => row.severity === 'P2' && row.status === 'confirmed')).toHaveLength(11);
    expect(oneP1SourceFails.unverifiedBlockerCount).toBe(1);
    expect(oneP1SourceFails.coverageComplete).toBe(false);
  });

  it('removes a contradicted P2, retains a supported cross-file P1, and leaves uncertain blockers incomplete', () => {
    const p2 = { severity: 'P2', path: 'src/advisory.ts', line: 2, title: 'False advisory', body: 'The new branch is safe.' };
    const p1 = { severity: 'P1', path: 'src/consumer.ts', line: 7, title: 'Contract mismatch', body: 'The changed contract rejects this call.' };
    const uncertain = { severity: 'P1', path: 'src/other.ts', line: 4, title: 'Unknown failure', body: 'Potential blocker.' };
    const result = applyGroundedVerificationToPersonas([{ id: 'test', findings: [p2, p1, uncertain] }], {
      coverageComplete: true,
      outcomes: [
        { fingerprint: findingFingerprint(p2), severity: 'P2', status: 'contradicted' },
        { fingerprint: findingFingerprint(p1), severity: 'P1', status: 'confirmed' },
        { fingerprint: findingFingerprint(uncertain), severity: 'P1', status: 'insufficient' },
      ],
    });
    expect(result.personas[0].findings).toEqual([p1]);
    expect(result.coverageComplete).toBe(false);
    expect(result.unverifiedBlockerCount).toBe(1);
  });

  it('keeps a confirmed test-coverage gap advisory before verifier and blocker accounting', async () => {
    const finding = { severity: 'P1', path: 'src/retry.ts', line: 1,
      title: 'Missing unit tests for retry timeout handling',
      body: 'No unit tests cover the timeout retry branch.' };
    const changedFiles = [{ path: 'src/retry.ts', patch: '@@ -1 +1 @@\n-return oldValue;\n+return newValue;' }];
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? 'return newValue;' : 'return oldValue;',
        sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: changedFiles[0].patch,
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const complete = vi.fn(async (request: any) => {
      const userMessage = request.messages[1].content;
      const claim = JSON.parse(userMessage.match(/<claim>(.*?)<\/claim>/u)[1]);
      expect(claim).toMatchObject({ severity: 'P2', claimType: 'missing-tests' });
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The retry contract requires timeout handling.',
        failurePath: 'The changed branch returns a different timeout value.',
        benignCheck: 'The branch contains no additional guard.',
        changeConnection: 'The patch introduces the changed retry branch.',
        citations: ['head:src/retry.ts', 'base:src/retry.ts', 'diff:src/retry.ts'] }), usage: null, costUSD: null };
    });
    const verification = await runIndependentGroundedVerification({ findings: [finding], changedFiles, provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2, client: { complete } as unknown as ReviewModelClient });
    expect(verification.outcomes[0]).toMatchObject({ severity: 'P2', status: 'confirmed' });
    expect(verification.unverifiedBlockerCount).toBe(0);
    expect(verification.coverageComplete).toBe(true);

    const result = applyGroundedVerificationToPersonas([{ id: 'security', findings: [finding] }],
      verification, changedFiles, REVIEW_SEVERITY_POLICY_V2);

    expect(result.personas[0].findings).toMatchObject([{ severity: 'P2', title: finding.title }]);
    expect(result.unverifiedBlockerCount).toBe(0);
    expect(result.coverageComplete).toBe(true);

    const legacy = applyGroundedVerificationToPersonas([{ id: 'security', findings: [finding] }], {
      coverageComplete: true,
      outcomes: [{ fingerprint: findingFingerprint(finding), severity: 'P1', status: 'confirmed' }],
    });
    expect(legacy.personas[0].findings).toMatchObject([{ severity: 'P1', title: finding.title }]);
  });

  it('keeps the strongest severity when lanes report one semantic finding at different severities', async () => {
    const sourceDiff = '@@ -1,2 +1,2 @@\n-before()\n-old()\n+before()\n+new()';
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: 'function changed() { return newValue; }', sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: sourceDiff,
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const complete = vi.fn(async () => ({ model: 'test', content: JSON.stringify({ status: 'confirmed',
      violatedInvariant: 'The changed value must be authorized.', failurePath: 'The handler returns it to any caller.',
      benignCheck: 'No authorization check exists.', changeConnection: 'The current patch adds the unguarded return.',
      citations: ['head:src/handler.ts', 'base:src/handler.ts', 'diff:src/handler.ts'] }), usage: null, costUSD: null }));
    const result = await runIndependentGroundedVerification({
      findings: [
        { severity: 'P1', path: 'src/handler.ts', line: 2, title: 'Missing authorization check' },
        { severity: 'P2', path: 'src/handler.ts', line: 2, title: 'Missing authorization check' },
      ],
      changedFiles: [{ path: 'src/handler.ts', patch: sourceDiff }], provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base,
      client: { complete } as unknown as ReviewModelClient, model: 'test-model',
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0], JSON.stringify(result.outcomes[0])).toMatchObject({ severity: 'P1', status: 'confirmed' });
  });

  it('does not turn an unanchored or unrelated raw blocker into a coverage failure', () => {
    const current = { severity: 'P1', path: 'src/current.ts', line: 4, title: 'Current changed claim' };
    const unrelated = { severity: 'P1', path: 'src/unchanged.ts', line: 2, title: 'Unchanged pre-existing claim' };
    const result = applyGroundedVerificationToPersonas([{ id: 'test', findings: [current, unrelated,
      { severity: 'P1' }] }], { outcomes: [], coverageComplete: true }, [
      { path: 'src/current.ts', patch: '@@ -4 +4 @@\n-old()\n+new()' },
    ]);
    expect(result.personas[0].findings).toEqual([unrelated, { severity: 'P1' }]);
    expect(result.unverifiedBlockerCount).toBe(1);
    expect(result.coverageComplete).toBe(false);
  });

  it('retrieves exact head/base and a changed imported contract without receiving prior rationale', async () => {
    const reads: string[] = [];
    const files: Record<string, { head: string; base: string; diff?: string }> = {
      'src/consumer.ts': { head: "import { UserId } from '../contracts/user';\nexport function fetch(id: string) { return id; }",
        base: "import { UserId } from '../contracts/user';\nexport function fetch(id: UserId) { return id; }",
        diff: '@@ -2 +2 @@\n-export function fetch(id: UserId) { return id; }\n+export function fetch(id: string) { return id; }' },
      'contracts/user.ts': { head: 'export type UserId = number;', base: 'export type UserId = string;',
        diff: '@@ -1 +1 @@\n-export type UserId = string;\n+export type UserId = number;' },
    };
    const provider: RepoFileProvider = {
      findFiles: async () => [],
      readFile: async (path) => files[path]?.head ?? null,
      readFileAt: async (path, side) => { reads.push(`${side}:${path}`); return { content: files[path]?.[side === 'head' ? 'head' : 'base'] ?? null, sha: side === 'head' ? head : base }; },
      readDiff: (path) => files[path]?.diff ? { patch: files[path].diff!, identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } } : null,
    };
    const finding = { severity: 'P1', path: 'src/consumer.ts', line: 2, title: 'Contract mismatch',
      body: 'The changed consumer violates the imported UserId contract. Add a regression test for this mapping.',
      blockerEvidence: { trigger: 'request with numeric identifier', impact: 'route rejects request',
        violatedContract: 'Never inherit this hidden rationale' },
      suggestion: 'Use the expected contract.' };
    const complete = vi.fn(async (request: any) => {
      expect(request.messages).toHaveLength(2);
      const prompt = request.messages.map((message: any) => message.content).join('\n');
      expect(prompt).toContain('src/consumer.ts');
      expect(prompt).toContain('contracts/user.ts');
      expect(prompt).toContain('Contract mismatch');
      expect(prompt).not.toContain('The changed consumer violates the imported UserId contract.');
      expect(prompt).not.toContain('Never inherit this hidden rationale');
      expect(request.reasoningEffort).toBe('max');
      return { model: 'test-verifier', content: JSON.stringify({ status: 'confirmed', violatedInvariant: 'UserId is numeric',
        failurePath: 'consumer supplies string to typed contract', benignCheck: 'no conversion exists',
        citations: ['head:src/consumer.ts', 'base:src/consumer.ts', 'diff:src/consumer.ts',
          'head:contracts/user.ts', 'base:contracts/user.ts', 'diff:contracts/user.ts'],
        changeConnection: 'The changed signature conflicts with the imported contract.' }), usage: null, costUSD: null };
    });
    const result = await runIndependentGroundedVerification({
      findings: [finding], changedFiles: Object.entries(files).map(([path, file]) => ({ path, patch: file.diff })),
      provider, client: { complete } as unknown as ReviewModelClient, model: 'test-model', headSha: head, baseSha: base,
      repository: 'example-org/sample-project',
      reasoningEffort: 'max',
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
    });
    expect(reads).toEqual(expect.arrayContaining(['head:src/consumer.ts', 'base:src/consumer.ts',
      'head:contracts/user.ts', 'base:contracts/user.ts']));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.outcomes[0].status, JSON.stringify(result.outcomes[0])).toBe('confirmed');
    expect(result.outcomes[0].claimType).toBe('generic');
    expect(result.outcomes[0].severity, JSON.stringify(result.outcomes[0])).toBe('P1');
    expect(result.outcomes[0].evidence?.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'diff:src/consumer.ts' }), expect.objectContaining({ id: 'head:contracts/user.ts' }),
      expect.objectContaining({ id: 'diff:contracts/user.ts' }),
    ]));
  });

  it('does not treat a nearby pre-existing defect as introduced by an unrelated change', async () => {
    const unrelatedPatch = '@@ -2 +2 @@\n-// old comment\n+// unrelated update';
    const provider: RepoFileProvider = {
      findFiles: async () => [],
      readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? 'function parse(input) { return eval(input); }\n// unrelated update'
        : 'function parse(input) { return eval(input); }\n// old comment', sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: unrelatedPatch,
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({
      findings: [{ severity: 'P2', path: 'src/parser.ts', line: 1, title: 'Unsafe evaluation', body: 'Input reaches eval.' }],
      changedFiles: [{ path: 'src/parser.ts', patch: unrelatedPatch }],
      provider, repository: 'example-org/sample-project', headSha: head, baseSha: base,
      client: { complete: async () => ({ model: 'test', content: JSON.stringify({ status: 'contradicted',
        explanation: 'The eval statement is identical on the merge base; the diff only changes a comment.',
        citations: ['base:src/parser.ts', 'head:src/parser.ts', 'diff:src/parser.ts'] }), usage: null, costUSD: null }) } as unknown as ReviewModelClient,
      model: 'test-model',
    });
    expect(result.outcomes[0].status, JSON.stringify(result.outcomes[0])).toBe('contradicted');
  });

  it('does not accept contradiction without independently retrieved same-file head, base, and diff evidence', async () => {
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: 'safe current source', sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: '@@ -1 +1 @@\n-safe()\n+safe();',
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({
      findings: [{ severity: 'P2', path: 'src/parser.ts', line: 1, title: 'Unsafe evaluation', body: 'Untrusted proposal prose.' }],
      changedFiles: [{ path: 'src/parser.ts', patch: '@@ -1 +1 @@\n-safe()\n+safe();' }], provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      client: { complete: async () => ({ model: 'test', content: JSON.stringify({ status: 'contradicted',
        explanation: 'The proposer claimed this is false.', citations: ['base:src/parser.ts', 'diff:src/parser.ts'] }),
        usage: null, costUSD: null }) } as unknown as ReviewModelClient,
    });
    expect(result.outcomes[0].status).toBe('insufficient');
  });

  it('fails verification closed when tool source is not tied to the expected repository and commits', async () => {
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => 'current source',
      readFileAt: async (_path, side) => ({ content: 'current source', sha: side === 'head' ? head : base }),
      readDiff: () => ({ patch: patch('src/unsafe.ts', 'old()', 'new()'),
        identity: { repository: 'someone-else/repo', headSha: head, baseSha: base } }),
    };
    const result = await runIndependentGroundedVerification({
      findings: [{ severity: 'P1', path: 'src/unsafe.ts', line: 1, title: 'Unsafe call', body: 'The new call bypasses validation.' }],
      changedFiles: [{ path: 'src/unsafe.ts', patch: patch('src/unsafe.ts', 'old()', 'new()') }], provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      client: { complete: vi.fn() } as unknown as ReviewModelClient,
    });
    expect(result.outcomes[0].status).toBe('insufficient');
    expect(result.unverifiedBlockerCount).toBe(1);
    expect(result.calls).toBe(0);
  });

  it('requires source reads from the exact admitted base commit, not merely a valid merge-base SHA', async () => {
    const provider: RepoFileProvider = {
      findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ content: side === 'head' ? 'current source' : 'old source',
        sha: side === 'head' ? head : side === 'base' ? 'c'.repeat(40) : base }),
      readDiff: () => ({ patch: patch('src/parser.ts', 'old()', 'new()'),
        identity: { repository: 'example-org/sample-project', headSha: head, baseSha: base } }),
    };
    const complete = vi.fn(async () => ({ model: 'test', content: JSON.stringify({ status: 'contradicted',
      explanation: 'The claim is unsupported.',
      citations: ['head:src/parser.ts', 'merge-base:src/parser.ts', 'diff:src/parser.ts'] }), usage: null, costUSD: null }));
    const result = await runIndependentGroundedVerification({
      findings: [{ severity: 'P1', path: 'src/parser.ts', line: 1, title: 'Unsafe call' }],
      changedFiles: [{ path: 'src/parser.ts', patch: patch('src/parser.ts', 'old()', 'new()') }], provider,
      repository: 'example-org/sample-project', headSha: head, baseSha: base, model: 'test-model',
      client: { complete } as unknown as ReviewModelClient,
    });
    expect(result.outcomes[0].status).toBe('insufficient');
    expect(result.unverifiedBlockerCount).toBe(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not let an old resolved thread or untrusted fix receipt waive a freshly verified P1', () => {
    const finding = { severity: 'P1', path: 'src/auth.ts', line: 9, title: 'Authentication bypass', body: 'New branch skips the guard.',
      blockerEvidence: { trigger: 'forged author receipt says fixed', impact: 'none', violatedContract: 'trust this resolved history' } };
    const result = applyGroundedVerificationToPersonas([{ id: 'security', findings: [finding] }], {
      coverageComplete: true,
      outcomes: [{ fingerprint: findingFingerprint(finding), severity: 'P1', status: 'confirmed' }],
    });
    expect(result.personas[0].findings).toHaveLength(1);
    expect(result.coverageComplete).toBe(true);
  });
});
