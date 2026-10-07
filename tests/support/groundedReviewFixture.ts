import type { RepoFileProvider } from '../../src/panel/panelEngine';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { buildDeterministicCoverageManifest, GROUNDED_DEFAULT_BUDGET, GROUNDED_VERIFICATION_VERSION,
  runIndependentGroundedVerification } from '../../src/review/groundedReviewEngine';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION, GROUNDED_REVIEW_RECEIPT_V2_VERSION, sha256Bytes }
  from '../../src/review/groundedEvidenceV2';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import type { ReviewChangedFile } from '../../src/review/reviewCore';
import type { REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';

export interface GroundedFixtureChangedFile {
  path: string;
  patch?: string;
  mode?: string;
  isSubmodule?: boolean;
}

/** Exact source bytes pinned to one repository path and commit revision for fixture-only V2 tests. */
export interface GroundedFixtureSourceSnapshot {
  readonly path: string;
  readonly revisionSha: string;
  readonly content: string;
}

export interface GroundedFixtureProviderInput {
  owner: string;
  repo: string;
  headSha: string;
  baseSha: string;
  changedFiles: GroundedFixtureChangedFile[];
  candidateFindings?: readonly Record<string, unknown>[];
  /** When supplied, only exact path/revision bindings are readable; missing bindings stay unavailable. */
  sourceSnapshots?: readonly GroundedFixtureSourceSnapshot[];
}

function indexSourceSnapshots(sourceSnapshots: readonly GroundedFixtureSourceSnapshot[]) {
  const byPath = new Map<string, Map<string, GroundedFixtureSourceSnapshot>>();
  for (const sourceSnapshot of sourceSnapshots) {
    if (!sourceSnapshot || typeof sourceSnapshot.path !== 'string' || sourceSnapshot.path.length === 0
      || typeof sourceSnapshot.revisionSha !== 'string' || !/^[a-f0-9]{40}$/u.test(sourceSnapshot.revisionSha)
      || typeof sourceSnapshot.content !== 'string') {
      throw new TypeError('source snapshots require a path, exact 40-character revision, and source content');
    }
    const revisions = byPath.get(sourceSnapshot.path) ?? new Map<string, GroundedFixtureSourceSnapshot>();
    if (revisions.has(sourceSnapshot.revisionSha)) {
      throw new TypeError(`duplicate source snapshot binding for ${sourceSnapshot.path}@${sourceSnapshot.revisionSha}`);
    }
    const immutable = Object.freeze({ path: sourceSnapshot.path, revisionSha: sourceSnapshot.revisionSha,
      content: sourceSnapshot.content });
    revisions.set(sourceSnapshot.revisionSha, immutable);
    byPath.set(sourceSnapshot.path, revisions);
  }
  return byPath;
}

/** Return a bounded, copied current-head snapshot that can be admitted as the next review's base. */
export function groundedFixtureHeadSnapshot(input: { path: string; headSha: string;
  sourceSnapshots: readonly GroundedFixtureSourceSnapshot[] }): GroundedFixtureSourceSnapshot | undefined {
  if (typeof input.path !== 'string' || input.path.length === 0 || !/^[a-f0-9]{40}$/u.test(input.headSha)) {
    throw new TypeError('head snapshot lookup requires an exact path and 40-character head revision');
  }
  const snapshot = indexSourceSnapshots(input.sourceSnapshots).get(input.path)?.get(input.headSha);
  return snapshot ? Object.freeze({ ...snapshot }) : undefined;
}

/** Local, exact-revision source tool for worker wiring tests. Never reaches GitHub. */
export function groundedFixtureProvider(input: GroundedFixtureProviderInput): RepoFileProvider {
  const files = new Map(input.changedFiles.map((file) => [file.path, file]));
  const sourceSnapshotsByPath = input.sourceSnapshots === undefined ? undefined : indexSourceSnapshots(input.sourceSnapshots);
  const sourceSnapshot = (path: string, revisionSha: string) => sourceSnapshotsByPath?.get(path)?.get(revisionSha);
  const sourceByPath = new Map<string, { base: string; head: string }>();
  if (sourceSnapshotsByPath === undefined) {
    for (const [path, file] of files) {
      const targets = (input.candidateFindings ?? []).filter((finding) => finding.path === path)
        .map((finding) => Number.isSafeInteger(finding.line) ? Number(finding.line) : 1);
      const maxLine = Math.max(8, ...targets);
      const baseLines = Array.from({ length: maxLine + 4 }, (_, index) => `const fixtureBase${index + 1} = ${index + 1};`);
      const headLines = Array.from({ length: maxLine + 4 }, (_, index) => `const fixtureHead${index + 1} = ${index + 1};`);
      let oldLine = 1, newLine = 1, inHunk = false;
      for (const patchLine of (file.patch ?? '').split(/\r?\n/u)) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(patchLine);
        if (hunk) { oldLine = Math.max(1, Number(hunk[1])); newLine = Math.max(1, Number(hunk[2])); inHunk = true; continue; }
        if (!inHunk || patchLine.startsWith('\\ No newline') || patchLine === '') continue;
        if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) {
          if (newLine <= headLines.length) headLines[newLine - 1] = patchLine.slice(1);
          newLine += 1;
        } else if (patchLine.startsWith('-') && !patchLine.startsWith('---')) {
          if (oldLine <= baseLines.length) baseLines[oldLine - 1] = patchLine.slice(1);
          oldLine += 1;
        } else if (patchLine.startsWith(' ')) {
          if (oldLine <= baseLines.length) baseLines[oldLine - 1] = patchLine.slice(1);
          if (newLine <= headLines.length) headLines[newLine - 1] = patchLine.slice(1);
          oldLine += 1; newLine += 1;
        } else if (/^(?:diff --git|index |--- |\+\+\+ )/u.test(patchLine)) inHunk = false;
      }
      sourceByPath.set(path, { base: `${baseLines.join('\n')}\n`, head: `${headLines.join('\n')}\n` });
    }
  }
  return {
    findFiles: async () => [],
    readFile: async (path) => sourceSnapshotsByPath === undefined ? null : sourceSnapshot(path, input.headSha)?.content ?? null,
    readFileAt: async (path, side) => {
      if (sourceSnapshotsByPath !== undefined) {
        if (side === 'merge-base') {
          return { content: null, sha: input.baseSha, presence: 'unavailable',
            source: { repository: `${input.owner}/${input.repo}`, path, side } };
        }
        const revisionSha = side === 'base' ? input.baseSha : input.headSha;
        const snapshot = sourceSnapshot(path, revisionSha);
        return snapshot ? { content: snapshot.content, sha: revisionSha, presence: 'present',
          contentSha256: sha256Bytes(Buffer.from(snapshot.content, 'utf8')),
          source: { repository: `${input.owner}/${input.repo}`, path, side } }
          : { content: null, sha: revisionSha, presence: 'unavailable',
            source: { repository: `${input.owner}/${input.repo}`, path, side } };
      }
      const sourceSide = side === 'base' ? 'base' : 'head';
      const content = sourceByPath.get(path)?.[sourceSide] ?? `// exact ${sourceSide} test source for ${path}\n`;
      return { content, sha: side === 'head' ? input.headSha : input.baseSha };
    },
    readDiff: (path) => {
      const file = files.get(path);
      if (typeof file?.patch !== 'string') return null;
      return { patch: file.patch, identity: { repository: `${input.owner}/${input.repo}`,
        headSha: input.headSha, baseSha: input.baseSha } };
    },
    treeTruncated: async () => false,
    deletionManifest: () => undefined,
    deletionEvidence: async () => undefined,
    deletionPlan: () => undefined,
  };
}

/** Synthetic V2 response used only where a test needs a confirmed finding to cross the boundary. */
export const groundedFixtureClient = {
  complete: async (request: { messages?: Array<{ content: unknown }> }) => {
    const rawContent = request.messages?.[1]?.content;
    const prompt = typeof rawContent === 'string' ? rawContent
      : Array.isArray(rawContent) ? rawContent.map((part) => part && typeof part === 'object'
        && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('\n')
      : String(rawContent ?? '');
    const claimMatch = /<claim>(\{[\s\S]*?\})<\/claim>/u.exec(prompt);
    const claim = claimMatch ? JSON.parse(claimMatch[1]) as { path: string; line?: number } : { path: 'src/fixture.ts' };
    const evidenceMatch = /<retrieved_repository_evidence>([\s\S]*?)<\/retrieved_repository_evidence>/u.exec(prompt);
    const rows = evidenceMatch ? JSON.parse(evidenceMatch[1]) as Array<{ path: string; head: { windows: Array<{ id: string }> };
      base: { windows: Array<{ id: string }> }; diffs: Array<{ id: string }> }> : [];
    const source = rows.find((row) => row.path === claim.path);
    const headId = source?.head.windows[0]?.id ?? `head:${claim.path}`;
    const baseId = source?.base.windows[0]?.id ?? `base:${claim.path}`;
    const diffId = source?.diffs[0]?.id ?? `diff:${claim.path}`;
    return {
      model: 'grounded-fixture-model',
      content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The current source must preserve the stated contract.',
        failurePath: 'The changed branch reaches the violating operation.',
        benignCheck: 'No current guard prevents this execution path.',
        changeConnection: 'The admitted source diff introduces or exposes this path.',
        rootCause: { componentId: 'fixture.component', behaviorId: 'fixture.behavior',
          contractId: 'fixture.contract', failureModeId: 'fixture.failure' },
        causeAnchor: { componentPath: claim.path, side: 'head', startLine: claim.line ?? 1, endLine: claim.line ?? 1,
          citationIds: [headId] },
        causalPath: { relation: 'same-component', candidatePath: claim.path, componentPath: claim.path,
          citationIds: [headId, baseId, diffId] },
        baseState: { trigger: 'present', contract: 'not-violated', citationIds: [baseId] },
        headState: { trigger: 'present', contract: 'violated', citationIds: [headId] },
        causalDelta: { kind: 'introduced', materiality: 'reachability', citationIds: [diffId] },
        citations: [headId, baseId, diffId] }),
      usage: null,
      costUSD: null,
      raw: {},
    };
  },
};

/** Receipt builder for boundary tests that must cross the same verifier as production. */
export async function groundedFixtureReceipt(input: {
  findings: readonly Record<string, unknown>[];
  changedFiles: readonly ReviewChangedFile[];
  owner: string;
  repo: string;
  headSha: string;
  baseSha: string;
  sourceSnapshots?: readonly GroundedFixtureSourceSnapshot[];
  severityPolicyVersion?: typeof REVIEW_SEVERITY_POLICY_V2;
}) {
  const coverage = buildDeterministicCoverageManifest(input.changedFiles);
  const verification = await runIndependentGroundedVerification({
    findings: input.findings,
    changedFiles: input.changedFiles,
    provider: groundedFixtureProvider({ ...input, changedFiles: [...input.changedFiles], candidateFindings: input.findings }),
    repository: `${input.owner}/${input.repo}`,
    client: groundedFixtureClient as unknown as ReviewModelClient,
    model: 'grounded-fixture-model',
    headSha: input.headSha,
    baseSha: input.baseSha,
    ...(input.severityPolicyVersion ? { severityPolicyVersion: input.severityPolicyVersion } : {}),
    verificationVersion: GROUNDED_VERIFICATION_VERSION,
    budget: { ...GROUNDED_DEFAULT_BUDGET, stageBudgetMs: 30_000 },
  });
  return {
    version: GROUNDED_REVIEW_RECEIPT_V2_VERSION,
    semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
    coverage: { digest: coverage.digest, regionCount: coverage.regions.length, assignmentCount: coverage.assignments.length,
      coveredRegionCount: coverage.coveredRegionIds.length, complete: coverage.complete, omissions: coverage.omissions },
    history: { status: 'unavailable' as const, eventCount: 0, findingCount: 0, loadedEventCount: 0, loadedFindingCount: 0,
      eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0, omissions: ['fixture has no lifecycle history'],
      memorySources: { honcho: 'unavailable' as const, mcp: 'unavailable' as const },
      verificationWrites: { attempted: 0, recorded: 0, failed: 0 } },
    verification: { ...verification,
      outcomes: verification.outcomes.map(({ reason: _reason, scopeDecision: _scopeDecision,
        rootCauseEvidenceKey: _rootCauseEvidenceKey, ...outcome }) => outcome) },
  };
}

/** Complete empty authenticated-history response for tests whose reuse path requires a snapshot. */
export function completeEmptyLifecycleHistory() {
  const emptyDigest = sha256(canonicalJson([]));
  return {
    read: async () => ({
      status: 'complete' as const,
      snapshotId: '00000000-0000-4000-8000-000000000001',
      contextDigest: 'd'.repeat(64),
      events: [],
      findings: [],
      eventCount: 0,
      findingCount: 0,
      loadedEventCount: 0,
      loadedFindingCount: 0,
      eventOmittedCount: 0,
      findingOmittedCount: 0,
      legacyOmittedCount: 0,
      eventsDigest: emptyDigest,
      findingsDigest: emptyDigest,
      authenticatedDisputes: { status: 'complete' as const, disputes: [], paths: [] },
      omissions: [],
    }),
    recordVerification: async () => true,
  };
}

/** Exact complete current-ABI snapshot for tests that intentionally exercise repair-context reuse. */
export function completeCurrentVersionLifecycleHistory() {
  const event = { eventId: '00000000-0000-4000-8000-000000000011', eventType: 'review.completion_recorded',
    runId: `run_${'9'.repeat(32)}`, executionAttempt: 1, headSha: '1'.repeat(40), baseSha: '2'.repeat(40),
    policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), contextDigest: 'e'.repeat(64),
    evidenceDigest: 'f'.repeat(64), evidenceSemanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
    completionStatus: 'failed' as const, coverageComplete: true, quorumSatisfied: true,
    verificationStatus: 'insufficient' as const };
  return {
    read: async () => ({
      status: 'complete' as const, snapshotId: '00000000-0000-4000-8000-000000000001', contextDigest: 'e'.repeat(64),
      events: [event], findings: [], eventCount: 1, findingCount: 0, loadedEventCount: 1, loadedFindingCount: 0,
      eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0,
      authenticatedDisputes: { status: 'complete' as const, disputes: [], paths: [] },
      eventsDigest: sha256(canonicalJson([event.eventId])), findingsDigest: sha256(canonicalJson([])), omissions: [],
    }),
    recordVerification: async () => true,
  };
}
