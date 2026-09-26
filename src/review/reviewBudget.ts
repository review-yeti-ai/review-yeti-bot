/**
 * Risk-ordered review budget per lane (REL-1082; plan
 * `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`,
 * section 4 W5). Behind `REVIEW_YETI_BUDGET`, default off.
 *
 * Each lane gets a character budget sized to the inline-diff knee W1 measured
 * (`PERSONA_BUDGET_CHARS`, 56,000 characters: past it the lane loop moves to
 * on-demand `get_diff`, and turns go from 5 to 19). The lane's files are packed
 * in deterministic category order:
 *
 * 1. Security-sensitive paths (`isSecuritySensitivePath`) and CI/IaC paths, in
 *    full, first. They are never summarized. They may exceed the soft budget,
 *    up to the per-request cap (`MAX_PACKED_DIFF_CHARS`).
 * 2. Source, then 3. tests, config and docs: each file gets a deterministic
 *    signature summary (hunk headers and changed declaration lines, extracted
 *    from the patch in code, never written by a model) while it fits. Files
 *    are then upgraded to full depth in category order while the budget lasts.
 * 4. A file whose signatures do not fit is listed as "not deeply reviewed".
 *
 * A minimal note is reserved for every file before anything is placed, and a
 * file is only given more when every unplaced file's reserve survives it, so
 * the pack never passes `MAX_PACKED_DIFF_CHARS`. A lane whose minimal notes
 * alone would not fit is not budgeted: it gets today's content, disclosed.
 *
 * A file that fits is sent whole: the 20,000-character per-file cut in
 * `hunkFilter.ts` no longer applies to it.
 *
 * Safety (plan section 3):
 *
 * - Deterministic exclusion only. The budget removes no file. Every file stays
 *   in the lane's file list, and its patch stays reachable through `get_diff`.
 *   Only the depth of the inline text changes, and every reduction is disclosed.
 * - Prompt-injection resistance. Category comes from the path alone. File
 *   content never raises or lowers a file's priority.
 * - One decision. `resolveBudgetedReviewApplicability` runs strictly after the
 *   shared decision (`resolveShrunkReviewApplicability` ->
 *   `resolveReviewApplicability`, which the trusted completion side calls) and
 *   returns its lanes, exemption, unmatched paths, omitted patches and coverage
 *   inputs untouched. The worker and the service cannot disagree about which
 *   lanes run or whether coverage is complete.
 * - Fail open. Flag off, a zero-lane decision, or a file missing from a pack
 *   gives today's content for that file.
 * - Request size. The packed inline diff is capped at `MAX_PACKED_DIFF_CHARS`,
 *   and a budgeted lane's tool results are clipped so the whole request stays
 *   under `MAX_BUDGETED_REQUEST_BYTES`, well below the gateway proxy's body
 *   limit (`BIFROST_PROXY_BODY_LIMIT_BYTES`).
 *
 * Jev seam: `budgetCategoryRank` is the only ordering input. Once W4 shadow
 * data calibrates Jev risk, a calibrated score may reorder files inside the
 * summarizable ranks only. It can never move a full-depth category.
 */
import type {
  BudgetCategory,
  BudgetDepth,
  BudgetFileEntry,
  ReviewBudgetDisclosure,
  ReviewBudgetInput,
  ReviewBudgetLaneDisclosure,
} from '../types/reviewBudget';
import { MAX_FILE_PATCH_CHARS } from '../pipeline/hunkFilter';
import { resolveShrunkReviewApplicability } from './diffShrink';
import { resolveCachedReviewApplicability } from './verdictCache';
import type { VerdictCacheDisclosure } from '../types/verdictCache';
import type { IncrementalReviewDisclosure } from '../types/incrementalReview';
import type { DiffShrinkDisclosure } from '../types/diffShrink';
import { scopeFilesForPersona, type EffectiveReviewFile, type ReviewApplicability } from './personaApplicability';
import { isDataOrConfigPath, isDocumentationOrAssetPath } from './reviewableContent';
import { isSecuritySensitivePath } from './securitySensitivePaths';

export type {
  BudgetCategory,
  BudgetDepth,
  BudgetFileEntry,
  ReviewBudgetDisclosure,
  ReviewBudgetInput,
  ReviewBudgetLaneDisclosure,
} from '../types/reviewBudget';
import { repositoryFlagEnabledFor } from './repositoryFlag';

export const REVIEW_BUDGET_FLAG = 'REVIEW_YETI_BUDGET';

/**
 * Soft per-lane budget, in characters of inline diff. Equal to the panel's
 * `MAX_INLINE_DIFF_CHARS_CEILING` (14,000 tokens x 4), the knee W1 measured.
 * A test pins the two together.
 */
export const PERSONA_BUDGET_CHARS = 56_000;

/**
 * Body limit on the path review workers use to reach Bifrost. The in-cluster
 * front `gateway-internal-https` (ct-infrastructure,
 * `clusters/doks-nyc1/apps/llm-gateway/deploy-gateway-internal-https.yaml`) is
 * nginx with no `client_max_body_size`, so nginx's default of 1 MiB applies.
 * Bifrost's own `maxRequestBodySizeMb` is 10. An oversized sec-lane request
 * already hit HTTP 413 there (W1). If the proxy limit is raised, this stays a
 * safe lower bound.
 */
export const BIFROST_PROXY_BODY_LIMIT_BYTES = 1_048_576;

/** Whole-request cap for a budgeted lane: 62.5% of the proxy limit, leaving room for headers and the reply turn. */
export const MAX_BUDGETED_REQUEST_BYTES = 640 * 1024;

/**
 * Hard cap on one lane's packed inline diff, in characters. Full-depth files
 * may use it all; nothing else may pass the soft budget. At 3 UTF-8 bytes per
 * character (worst case after sanitizing), 160,000 characters is 480 KiB,
 * inside `MAX_BUDGETED_REQUEST_BYTES`.
 */
export const MAX_PACKED_DIFF_CHARS = 160_000;

/** Characters the diff section adds per file around the patch (XML envelope, index line). */
const ENVELOPE_OVERHEAD_CHARS = 96;
const MAX_SIGNATURE_LINES = 40;
const MAX_SIGNATURE_LINE_CHARS = 200;
const TOOL_RESULT_RESERVE_BYTES = 16 * 1024;
const NOTE_PREFIX = '\\ Review Yeti budget:';

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

/**
 * `REVIEW_YETI_BUDGET`: unset, empty, `0`, `false` or `off` is off (the
 * default); `1`, `true`, `on` or `all` is on for every repository; anything
 * else is a comma- or space-separated list of `owner/repo` names it is on for
 * (case-insensitive), so it can be enabled per repository first.
 */
export function reviewBudgetEnabledFor(env: Readonly<Record<string, string | undefined>>, repository: string): boolean {
  return repositoryFlagEnabledFor(env, REVIEW_BUDGET_FLAG, repository);
}

/** Worker-side input for the engines, or undefined when the flag is off for this repository. */
export function loadReviewBudgetInput(options: {
  env: Readonly<Record<string, string | undefined>>;
  repository: string;
}): ReviewBudgetInput | undefined {
  return reviewBudgetEnabledFor(options.env, options.repository) ? { enabled: true } : undefined;
}

// ---------------------------------------------------------------------------
// Category and rank (deterministic, path only)
// ---------------------------------------------------------------------------

/** CI and infrastructure-as-code paths (W1 section 7.6) that the security list does not already name. */
const CI_IAC_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github\//iu,
  /(^|\/)\.gitlab-ci[^/]*$/iu,
  /(^|\/)jenkinsfile[^/]*$/iu,
  /(^|\/)\.(circleci|buildkite)\//iu,
  /\.(tf|tfvars|hcl)$/iu,
  /(^|\/)(helm|charts|k8s|kustomize|clusters|manifests|deploy|infra|terraform)\//iu,
  /(^|\/)chart\.ya?ml$/iu,
  /(^|\/)kustomization\.ya?ml$/iu,
  /(^|\/)dockerfile[^/]*$/iu,
  /(^|\/)docker-compose[^/]*\.ya?ml$/iu,
];

const TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)(tests?|__tests__|spec|specs|e2e|testdata|fixtures)\//iu,
  /[._](test|spec)\.[^/]+$/iu,
  /(^|\/)test_[^/]+\.py$/iu,
  /[a-z0-9]Tests?\.[^/]+$/u,
];

export function classifyBudgetCategory(filePath: string): BudgetCategory {
  if (isSecuritySensitivePath(filePath)) return 'security-sensitive';
  const path = filePath.replace(/\\/gu, '/');
  if (CI_IAC_PATTERNS.some((pattern) => pattern.test(path))) return 'ci-iac';
  if (TEST_PATTERNS.some((pattern) => pattern.test(path))) return 'test';
  if (isDocumentationOrAssetPath(path)) return 'docs';
  if (isDataOrConfigPath(path)) return 'config';
  return 'source';
}

/** Packing rank: 0 is always full depth; 1 and 2 may be summarized, 1 before 2. */
export function budgetCategoryRank(category: BudgetCategory): 0 | 1 | 2 {
  if (category === 'security-sensitive' || category === 'ci-iac') return 0;
  if (category === 'source') return 1;
  return 2;
}

/** A category whose files are never summarized or listed while they fit the request cap. */
export function isFullDepthCategory(category: BudgetCategory): boolean {
  return budgetCategoryRank(category) === 0;
}

// ---------------------------------------------------------------------------
// Deterministic signature summary
// ---------------------------------------------------------------------------

/** Changed lines that declare or import something, across common languages. */
const DECLARATION_LINE = new RegExp(
  '^\\s*(?:(?:export|pub(?:\\([^)]*\\))?|public|private|protected|internal|static|abstract|final|override|async|default|open|sealed|data|inline|virtual|extern|unsafe)\\s+)*'
  + '(?:function\\*?|class|interface|type|enum|struct|trait|impl|fn|func|def|defp|defmodule|defmacro|defstruct|module|namespace|package|'
  + 'import|from|use|require|record|object|protocol|extension|typedef|template)\\b',
  'u',
);
/** Variable bindings count only at the top level (no indentation) or when exported: module state, not locals. */
const TOP_LEVEL_BINDING = /^(?:export\s+(?:default\s+)?)?(?:const|let|var|val)\s+[A-Za-z_$]/u;
const EXPORTED_BINDING = /^\s*export\s+(?:const|let|var)\s/u;
/** Methods and bound functions: `name(args) {`, `name = (args) =>`, `name: function`. */
const METHOD_LINE = /^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*(?:=\s*(?:async\s*)?\(|:\s*(?:async\s+)?function\b|\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$)/u;

function isSignatureLine(text: string): boolean {
  return DECLARATION_LINE.test(text) || METHOD_LINE.test(text) || TOP_LEVEL_BINDING.test(text) || EXPORTED_BINDING.test(text);
}

interface PatchShape {
  hunks: number;
  additions: number;
  deletions: number;
}

function patchShape(patch: string): PatchShape {
  let hunks = 0;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) { hunks += 1; inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { hunks, additions, deletions };
}

function clip(line: string): string {
  return line.length > MAX_SIGNATURE_LINE_CHARS ? `${line.slice(0, MAX_SIGNATURE_LINE_CHARS)} ...` : line;
}

function shapeText(shape: PatchShape): string {
  return `+${shape.additions} -${shape.deletions} lines in ${shape.hunks} hunk${shape.hunks === 1 ? '' : 's'}`;
}

/**
 * Deterministic signature summary of one patch: its hunk headers (which carry
 * git's enclosing-function context) and the changed lines that declare or
 * import something, each tagged with its line number. Pure: the same patch
 * always gives the same text. The lines are copied from the patch and stay
 * inside the lane's untrusted-data envelope.
 */
export function summarizePatchSignatures(patch: string): string {
  const shape = patchShape(patch);
  const kept: string[] = [];
  let omitted = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const keep = (line: string) => {
    if (kept.length < MAX_SIGNATURE_LINES) kept.push(clip(line));
    else omitted += 1;
  };
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      keep(line);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      if (isSignatureLine(line.slice(1))) keep(`[new L${newLine}] +${line.slice(1).trim()}`);
      newLine += 1;
    } else if (line.startsWith('-')) {
      if (isSignatureLine(line.slice(1))) keep(`[old L${oldLine}] -${line.slice(1).trim()}`);
      oldLine += 1;
    } else if (!line.startsWith('\\')) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return [
    `${NOTE_PREFIX} signatures only (${shapeText(shape)}, ${patch.length.toLocaleString('en-US')} patch characters not sent in full). `
      + 'Lines below are hunk headers and changed declarations. Fetch the full patch with get_diff before reporting a finding on this file.',
    ...kept,
    ...(omitted > 0 ? [`${NOTE_PREFIX} ${omitted} more signature line(s) not shown.`] : []),
  ].join('\n');
}

/** The smallest note a listed file can carry; reserved for every file before packing. */
const MINIMAL_NOTE = `${NOTE_PREFIX} not deeply reviewed. Use get_diff.`;

function notDeeplyReviewedNote(patch: string): string {
  return `${NOTE_PREFIX} not deeply reviewed (over this lane's budget; ${shapeText(patchShape(patch))}). Use get_diff.`;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/** One file as the packer sees it. */
export interface BudgetCandidate {
  path: string;
  /** The patch the shared decision sends today (possibly cut at `MAX_FILE_PATCH_CHARS`). */
  effectivePatch: string;
  /** The whole patch when it differs from `effectivePatch` because of the per-file cut, else null. */
  wholePatch: string | null;
}

/** What one lane receives for one path. */
export interface LaneBudgetEntry {
  depth: BudgetDepth;
  /** Inline text for the lane's diff section. */
  promptPatch: string;
  /** Patch the lane's read-only tools and findings validation read. */
  toolPatch: string;
}

export interface LaneBudgetPack {
  laneId: string;
  entries: Map<string, LaneBudgetEntry>;
  /** Token budget to give the diff-section builder so the whole pack is inlined. */
  inlineTokenBudget: number;
  requestCapBytes: number;
  disclosure: ReviewBudgetLaneDisclosure;
  /**
   * REL-1083 (map-reduce chunks): `entries` inlines only the files this pack
   * names; every other scoped file stays readable through the lane's tools but
   * is not inlined. Absent (a W5 lane pack) inlines every scoped file.
   */
  promptScope?: 'entries';
  /** REL-1083: text placed just before the lane's diff section (the chunk's scope). */
  scopeNote?: string;
}

function inlineCost(path: string, text: string): number {
  return text.length + path.length * 2 + ENVELOPE_OVERHEAD_CHARS;
}

/** Characters one file costs in a lane's diff section; shared with map-reduce (REL-1083) so chunks are sized the same way. */
export const budgetInlineCost = inlineCost;

/**
 * Pack one lane's files. Pure and deterministic: files are ordered by
 * category rank, then path, and the same candidates always give the same pack.
 */
export function packLaneBudget(
  laneId: string,
  candidates: readonly BudgetCandidate[],
  options: { budgetChars?: number; hardCapChars?: number; requestCapBytes?: number } = {},
): LaneBudgetPack {
  const budgetChars = options.budgetChars ?? PERSONA_BUDGET_CHARS;
  const hardCapChars = Math.max(budgetChars, options.hardCapChars ?? MAX_PACKED_DIFF_CHARS);
  const requestCapBytes = options.requestCapBytes ?? MAX_BUDGETED_REQUEST_BYTES;
  const ordered = candidates
    .map((file) => ({ ...file, category: classifyBudgetCategory(file.path) }))
    .sort((a, b) => budgetCategoryRank(a.category) - budgetCategoryRank(b.category)
      || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const whole = (file: { effectivePatch: string; wholePatch: string | null }) => file.wholePatch ?? file.effectivePatch;

  // Every file needs at least a minimal note in the pack. Those notes are
  // reserved up front and a file is only given more when the reserve of every
  // file still unplaced survives it, so the pack never passes the hard cap.
  // A lane whose minimal notes alone do not fit is not budgeted at all: it
  // falls back to today's content (fail open), and the summary says so.
  const minimalCost = (file: { path: string }) => inlineCost(file.path, MINIMAL_NOTE);
  let pending = ordered.reduce((sum, file) => sum + minimalCost(file), 0);
  if (pending > hardCapChars) {
    return {
      laneId,
      entries: new Map(),
      inlineTokenBudget: 0,
      requestCapBytes,
      disclosure: { laneId, budgetChars, packedChars: 0, files: [], fallback: { files: ordered.length } },
    };
  }

  const state = new Map<string, { depth: BudgetDepth; prompt: string; cost: number }>();
  let used = 0;
  const fits = (file: { path: string }, text: string) => {
    const previous = state.get(file.path);
    const reserve = previous ? 0 : minimalCost(file);
    return used - (previous?.cost ?? 0) + inlineCost(file.path, text) + (pending - reserve) <= hardCapChars;
  };
  const set = (file: { path: string }, depth: BudgetDepth, prompt: string) => {
    const previous = state.get(file.path);
    if (!previous) pending -= minimalCost(file);
    const cost = inlineCost(file.path, prompt);
    used += cost - (previous?.cost ?? 0);
    state.set(file.path, { depth, prompt, cost });
  };
  const list = (file: { path: string }, patch: string) => {
    const note = notDeeplyReviewedNote(patch);
    set(file, 'not-deeply-reviewed', fits(file, note) ? note : MINIMAL_NOTE);
  };

  // 1. Full-depth categories, in order, up to the hard cap. Never summarized:
  //    a file whose whole patch does not fit keeps today's cut patch, and only
  //    when even that does not fit is it listed (still readable via get_diff).
  for (const file of ordered.filter((entry) => isFullDepthCategory(entry.category))) {
    const full = whole(file);
    if (fits(file, full)) set(file, 'full', full);
    else if (file.wholePatch !== null && fits(file, file.effectivePatch)) set(file, 'truncated', file.effectivePatch);
    else list(file, full);
  }

  // 2. Everything else, in priority order, as signatures while they fit, then
  //    listed. Lower-priority files are the ones listed first.
  const summarizable = ordered.filter((entry) => !isFullDepthCategory(entry.category));
  for (const file of summarizable) {
    const signatures = summarizePatchSignatures(whole(file));
    if (fits(file, signatures)) set(file, 'signatures', signatures);
    else list(file, whole(file));
  }

  // 3. Upgrade to full depth in priority order while the soft budget lasts.
  //    A file that fits is sent whole, past the per-file cut.
  for (const file of summarizable) {
    const current = state.get(file.path)!;
    if (current.depth !== 'signatures') continue;
    const full = whole(file);
    if (used - current.cost + inlineCost(file.path, full) <= budgetChars) set(file, 'full', full);
  }

  const entries = new Map<string, LaneBudgetEntry>();
  const files: BudgetFileEntry[] = [];
  for (const file of ordered) {
    const { depth, prompt } = state.get(file.path)!;
    const full = whole(file);
    entries.set(file.path, {
      depth,
      promptPatch: prompt,
      // Tools and findings validation read the whole patch only for a file the
      // lane was sent whole, so a finding past the old cut can be anchored.
      // Everything else keeps today's patch, which bounds get_diff output.
      toolPatch: depth === 'full' ? full : file.effectivePatch,
    });
    files.push({
      path: file.path,
      category: file.category,
      depth,
      originalChars: full.length,
      sentChars: prompt.length,
      pastPerFileCut: depth === 'full' && file.wholePatch !== null,
    });
  }
  return {
    laneId,
    entries,
    inlineTokenBudget: Math.ceil((Math.max(used, 1) + 4_096) / 4),
    requestCapBytes,
    disclosure: { laneId, budgetChars, packedChars: used, files },
  };
}

/**
 * Apply a lane's pack to the files that lane is scoped to. Files are matched
 * by path; a file the pack does not name (never expected) is sent as today.
 */
export function applyLaneBudgetPack<T extends { path: string; patch?: string }>(
  scopedFiles: readonly T[],
  pack: LaneBudgetPack,
): { promptFiles: T[]; toolFiles: T[] } {
  const promptFiles: T[] = [];
  const toolFiles: T[] = [];
  for (const file of scopedFiles) {
    const entry = pack.entries.get(file.path);
    // A file without a patch string sent at full depth is passed through as
    // is, so the pack never invents an empty patch where there was none.
    const untouched = entry && typeof file.patch !== 'string' && entry.depth === 'full';
    if (!entry || untouched) {
      // REL-1083: a chunk pack inlines only its own files; the rest stay tool-readable.
      if (entry || pack.promptScope !== 'entries') promptFiles.push(file);
      toolFiles.push(file);
      continue;
    }
    promptFiles.push({ ...file, patch: entry.promptPatch });
    toolFiles.push(entry.toolPatch === file.patch ? file : { ...file, patch: entry.toolPatch });
  }
  return { promptFiles, toolFiles };
}

// ---------------------------------------------------------------------------
// Shared decision
// ---------------------------------------------------------------------------

export interface ReviewBudgetPlan {
  scope: 'per-lane' | 'whole-diff';
  /** Packs the engines apply. A lane that fell back to today's content has none. */
  packs: Map<string, LaneBudgetPack>;
  /** Lanes too large to budget within the hard cap: they get today's content, disclosed. */
  fallbacks?: Map<string, ReviewBudgetLaneDisclosure>;
}

export const COMPOSED_BUDGET_LANE_ID = 'composed';

/**
 * The packer's view of each effective file: the patch the shared decision
 * sends today, plus the whole patch of a file the per-file cut shortened when
 * nothing after the cut (diff shrinking, the incremental scope) rewrote it.
 * Otherwise the file keeps its patch. Shared with map-reduce (REL-1083) so
 * both see exactly the same content.
 */
export function budgetCandidateResolver(
  decision: Pick<ReviewApplicability<never>, 'hunkResult' | 'truncatedFiles'>,
  changedFiles: ReadonlyArray<{ path: string; patch?: string }>,
): (file: EffectiveReviewFile) => BudgetCandidate {
  const inputPatch = new Map(changedFiles.map((file) => [file.path, file.patch]));
  const cutPatch = new Map(decision.hunkResult.files.map((file) => [file.path, file.patch]));
  const truncated = new Set(decision.truncatedFiles.map((file) => file.path));
  return (file) => {
    const effectivePatch = typeof file.patch === 'string' ? file.patch : (file.content ?? '');
    const original = inputPatch.get(file.path);
    const restorable = truncated.has(file.path) && file.patch === cutPatch.get(file.path)
      && typeof original === 'string' && original.length > MAX_FILE_PATCH_CHARS;
    return { path: file.path, effectivePatch, wholePatch: restorable ? original! : null };
  };
}

type ScopedOptions = NonNullable<Parameters<typeof resolveCachedReviewApplicability>[2]>;

/**
 * The shared applicability decision, diff shrinking, the incremental scope
 * (REL-1084), and the review budget, for every engine. The decision, the
 * shrink and the incremental scope run first and are returned untouched; the
 * budget only adds `reviewBudget`, the per-lane packs. A file the shrink or
 * the incremental scope rewrote keeps that patch (it is never restored).
 *
 * `budgetScope` is `per-lane` for the persona panel (one pack per applicable
 * persona, over the files that persona is scoped to) and `whole-diff` for the
 * composed engine (one pack over every effective file).
 */
export function resolveBudgetedReviewApplicability<P extends Parameters<typeof resolveShrunkReviewApplicability>[0][number]>(
  enabledPersonas: readonly P[],
  changedFiles: Parameters<typeof resolveShrunkReviewApplicability>[1],
  options: ScopedOptions & { reviewBudget?: ReviewBudgetInput; budgetScope?: 'per-lane' | 'whole-diff' } = {},
): ReviewApplicability<P> & {
  diffShrink: DiffShrinkDisclosure | null;
  incremental: IncrementalReviewDisclosure | null;
  verdictCache: VerdictCacheDisclosure | null;
  reviewBudget: ReviewBudgetPlan | null;
} {
  const { reviewBudget, budgetScope = 'per-lane', ...scopedOptions } = options;
  // REL-1085: the verdict cache (a thin pass-through when absent) runs before the budget, so a
  // file served from cache is packed as its one-line note.
  const decision = resolveCachedReviewApplicability(enabledPersonas, changedFiles, scopedOptions);
  if (!reviewBudget?.enabled || decision.applicable.length === 0) return { ...decision, reviewBudget: null };

  const candidateOf = budgetCandidateResolver(decision, changedFiles);

  const packs = new Map<string, LaneBudgetPack>();
  const fallbacks = new Map<string, ReviewBudgetLaneDisclosure>();
  const add = (pack: LaneBudgetPack) => {
    if (pack.disclosure.fallback) fallbacks.set(pack.laneId, pack.disclosure);
    else packs.set(pack.laneId, pack);
  };
  if (budgetScope === 'whole-diff') {
    add(packLaneBudget(COMPOSED_BUDGET_LANE_ID, decision.effectiveFiles.map(candidateOf)));
  } else {
    for (const persona of decision.applicable) {
      const scoped = scopeFilesForPersona(persona as Parameters<typeof scopeFilesForPersona>[0], decision.effectiveFiles);
      add(packLaneBudget(persona.id, scoped.map(candidateOf)));
    }
  }
  return { ...decision, reviewBudget: { scope: budgetScope, packs, fallbacks } };
}

/**
 * Attach the disclosure of the packs whose lanes actually ran to an engine's
 * result, and correct the per-file-cut disclosure (REL-1092) to what those
 * lanes received: a file every running lane got whole, as signatures or as a
 * listing is no longer "truncated". A fast-ship result ran no lane and is
 * returned unchanged, as is any result when the budget was off.
 */
export function attachReviewBudgetDisclosure<T extends object>(
  result: T,
  plan: ReviewBudgetPlan | null,
  /**
   * REL-1083: files a lane outside this plan (a map-reduce chunked lane) still
   * received only as the per-file cut. They stay in the truncation list.
   */
  keepTruncated?: ReadonlySet<string>,
): T & { reviewBudget?: ReviewBudgetDisclosure } {
  if (!plan || (result as { isFastShip?: unknown }).isFastShip === true) return result;
  const personas = (result as { personas?: unknown }).personas;
  const ran = new Set(
    (Array.isArray(personas) ? personas : [])
      .filter((persona: any) => persona && typeof persona.id === 'string' && persona.notApplicable !== true)
      .map((persona: any) => persona.id as string),
  );
  const lanes = [...plan.packs.values()].map((pack) => pack.disclosure)
    .concat([...(plan.fallbacks?.values() ?? [])])
    .filter((lane) => plan.scope === 'whole-diff' || ran.has(lane.laneId));
  if (lanes.length === 0) return result;

  const stillCut = new Set<string>();
  const budgeted = new Set<string>();
  for (const lane of lanes) {
    for (const file of lane.files) {
      budgeted.add(file.path);
      if (file.depth === 'truncated') stillCut.add(file.path);
    }
  }
  const disclosure: ReviewBudgetDisclosure = { ordering: 'deterministic-category', requestCapBytes: MAX_BUDGETED_REQUEST_BYTES, lanes };
  const next: any = { ...result, reviewBudget: disclosure };
  if (Array.isArray(next.truncatedFiles)) {
    const kept = next.truncatedFiles.filter((file: { path: string }) => stillCut.has(file.path) || !budgeted.has(file.path)
      || keepTruncated?.has(file.path) === true);
    if (kept.length > 0) next.truncatedFiles = kept;
    else delete next.truncatedFiles;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Whole-request cap for tool results
// ---------------------------------------------------------------------------

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * Clip one tool result so the lane's next request (the conversation so far
 * plus this result) stays under `capBytes` once serialized. Deterministic,
 * and a no-op when the result fits. The note tells the lane what happened.
 */
export function clipToolOutputToRequestCap(
  toolOutput: string,
  messages: readonly unknown[],
  capBytes: number = MAX_BUDGETED_REQUEST_BYTES,
): string {
  const room = capBytes - jsonBytes(messages) - TOOL_RESULT_RESERVE_BYTES;
  if (jsonBytes(toolOutput) <= room) return toolOutput;
  const note = (kept: number) => `\n[Review Yeti budget: tool output cut to ${kept.toLocaleString('en-US')} of `
    + `${toolOutput.length.toLocaleString('en-US')} characters to keep this request under ${capBytes.toLocaleString('en-US')} bytes. `
    + 'Request a narrower line range or another file, or finish with the evidence you have.]';
  const noteRoom = room - jsonBytes(note(toolOutput.length));
  if (noteRoom <= 0) {
    return `[Review Yeti budget: tool output withheld (${toolOutput.length.toLocaleString('en-US')} characters): this request is at its `
      + `${capBytes.toLocaleString('en-US')}-byte cap. Finish with the evidence you have.]`;
  }
  let keep = Math.max(0, Math.floor(toolOutput.length * (noteRoom / jsonBytes(toolOutput))));
  while (keep > 0 && jsonBytes(toolOutput.slice(0, keep)) > noteRoom) keep = Math.floor(keep * 0.9);
  return toolOutput.slice(0, keep) + note(keep);
}

// ---------------------------------------------------------------------------
// Check-summary disclosure
// ---------------------------------------------------------------------------

const MAX_LISTED = 15;

function code(path: string): string {
  return `\`${String(path).replace(/[`<>\r\n]/gu, ' ').slice(0, 300)}\``;
}

function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED).map(code).join(', ');
  const more = paths.length - MAX_LISTED;
  return more > 0 ? `${shown}, +${more} more` : shown;
}

/** Check-summary disclosure lines (plan section 3, invariant 5). Empty when the budget did not run. */
export function renderReviewBudgetSummary(disclosure: ReviewBudgetDisclosure | null | undefined): string[] {
  if (!disclosure || !Array.isArray(disclosure.lanes) || disclosure.lanes.length === 0) return [];
  const lines = [
    `**Review budget** (\`${REVIEW_BUDGET_FLAG}\`): each lane was sent up to ~${PERSONA_BUDGET_CHARS.toLocaleString('en-US')} diff characters, `
    + 'packed in deterministic order: security-sensitive and CI/IaC files in full first, then source, then tests, config and docs. '
    + 'Security-sensitive files are never summarized. Every file stays in each lane\'s file list and readable with get_diff.',
  ];
  for (const lane of disclosure.lanes) {
    if (lane.fallback) {
      lines.push(`- ${code(lane.laneId)}: budget not applied: its ${lane.fallback.files.toLocaleString('en-US')} files cannot all be listed `
        + 'within the per-request cap, so this lane was sent today\'s content (map-reduce for huge diffs is W6).');
      continue;
    }
    const by = (depth: BudgetDepth) => lane.files.filter((file) => file.depth === depth).map((file) => file.path);
    const full = by('full');
    const pastCut = lane.files.filter((file) => file.pastPerFileCut).length;
    const signatures = by('signatures');
    const notDeep = by('not-deeply-reviewed');
    const cut = by('truncated');
    lines.push(`- ${code(lane.laneId)}: ${full.length} in full`
      + (pastCut > 0 ? ` (${pastCut} past the ${(MAX_FILE_PATCH_CHARS / 1000).toLocaleString('en-US')}k per-file cut)` : '')
      + `, ${signatures.length} as signatures only, ${notDeep.length} not deeply reviewed`
      + (cut.length > 0 ? `, ${cut.length} cut at the per-file limit` : '')
      + `; ~${lane.packedChars.toLocaleString('en-US')} characters sent.`);
    if (signatures.length > 0) lines.push(`  - Signatures only: ${listed(signatures)}`);
    if (notDeep.length > 0) lines.push(`  - Not deeply reviewed: ${listed(notDeep)}`);
    if (cut.length > 0) lines.push(`  - Security-sensitive, over the request cap, cut at the per-file limit: ${listed(cut)}`);
  }
  return lines;
}
