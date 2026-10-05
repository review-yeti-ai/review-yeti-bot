import type { RepoFileProvider } from '../../src/panel/panelEngine';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { buildDeterministicCoverageManifest, GROUNDED_DEFAULT_BUDGET, GROUNDED_VERIFICATION_VERSION,
  runIndependentGroundedVerification } from '../../src/review/groundedReviewEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import type { ReviewChangedFile } from '../../src/review/reviewCore';
import type { REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';

export interface GroundedFixtureChangedFile {
  path: string;
  patch?: string;
  mode?: string;
  isSubmodule?: boolean;
}

export interface GroundedFixtureProviderInput {
  owner: string;
  repo: string;
  headSha: string;
  baseSha: string;
  changedFiles: GroundedFixtureChangedFile[];
}

/** Local, exact-revision source tool for worker wiring tests. Never reaches GitHub. */
export function groundedFixtureProvider(input: GroundedFixtureProviderInput): RepoFileProvider {
  const files = new Map(input.changedFiles.map((file) => [file.path, file]));
  return {
    findFiles: async () => [],
    readFile: async () => null,
    readFileAt: async (path, side) => ({
      content: side === 'head' ? `// current test source for ${path}` : `// admitted base source for ${path}`,
      sha: side === 'head' ? input.headSha : input.baseSha,
    }),
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

/** Synthetic model response used only where a test needs a confirmed finding to cross the boundary. */
export const groundedFixtureClient = {
  complete: async (request: { messages?: Array<{ content: unknown }> }) => {
    const prompt = String(request.messages?.[1]?.content ?? '');
    const match = /<claim>(\{[\s\S]*?\})<\/claim>/u.exec(prompt);
    const claim = match ? JSON.parse(match[1]) as { path: string } : { path: 'src/fixture.ts' };
    return {
      model: 'grounded-fixture-model',
      content: JSON.stringify({ status: 'confirmed',
        violatedInvariant: 'The current source must preserve the stated contract.',
        failurePath: 'The changed branch reaches the violating operation.',
        benignCheck: 'No current guard prevents this execution path.',
        changeConnection: 'The admitted source diff introduces or exposes this path.',
        citations: [`head:${claim.path}`, `base:${claim.path}`, `diff:${claim.path}`] }),
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
  severityPolicyVersion?: typeof REVIEW_SEVERITY_POLICY_V2;
}) {
  const coverage = buildDeterministicCoverageManifest(input.changedFiles);
  const verification = await runIndependentGroundedVerification({
    findings: input.findings,
    changedFiles: input.changedFiles,
    provider: groundedFixtureProvider({ ...input, changedFiles: [...input.changedFiles] }),
    repository: `${input.owner}/${input.repo}`,
    client: groundedFixtureClient as unknown as ReviewModelClient,
    model: 'grounded-fixture-model',
    headSha: input.headSha,
    baseSha: input.baseSha,
    ...(input.severityPolicyVersion ? { severityPolicyVersion: input.severityPolicyVersion } : {}),
    budget: { ...GROUNDED_DEFAULT_BUDGET, stageBudgetMs: 30_000 },
  });
  return {
    version: 'GroundedReviewReceipt.v1' as const,
    coverage: { digest: coverage.digest, regionCount: coverage.regions.length, assignmentCount: coverage.assignments.length,
      coveredRegionCount: coverage.coveredRegionIds.length, complete: coverage.complete, omissions: coverage.omissions },
    history: { status: 'unavailable' as const, eventCount: 0, findingCount: 0, loadedEventCount: 0, loadedFindingCount: 0,
      eventOmittedCount: 0, findingOmittedCount: 0, legacyOmittedCount: 0, omissions: ['fixture has no lifecycle history'],
      memorySources: { honcho: 'unavailable' as const, mcp: 'unavailable' as const },
      verificationWrites: { attempted: 0, recorded: 0, failed: 0 } },
    verification: { ...verification,
      version: GROUNDED_VERIFICATION_VERSION,
      outcomes: verification.outcomes.map(({ reason: _untrustedReason, ...outcome }) => outcome) },
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
      omissions: [],
    }),
    recordVerification: async () => true,
  };
}
