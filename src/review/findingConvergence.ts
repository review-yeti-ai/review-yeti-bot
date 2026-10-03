/**
 * Required-finding convergence (ADR 0002).
 *
 * P0, P1 and P2 findings all block a merge. A blocking P2 policy on its own does not converge:
 * every new head is a fresh model run, the same nit comes back under a new title, and a nit about
 * the code that fixed the previous nit is raised as new. This module is the single decision that
 * keeps the policy finite. Both the worker's raw check and the service Gate call it, so the two
 * cannot disagree about which findings are still required.
 *
 * Rules, each pinned by a test in `tests/unit/findingConvergence.test.ts`:
 *
 * 1. A finding that is fixed on the new head is dropped. Only findings the current run reports
 *    can block; a prior thread whose finding is not reported again is listed as `droppedPrior`
 *    and never counted.
 * 2. A previously raised finding is matched by a stable fingerprint across heads, not re-raised
 *    as new. The match is the exact fingerprint first, then the same claim about the same file
 *    (`compareClaims`), so a reworded title or a shifted line keeps the prior identity.
 * 3. The author can close a P2 by resolving its review thread with a reply that states why. A
 *    resolved thread with a non-bot reply that carries a reason satisfies the matching P2 on
 *    every later head. The resolution is returned so it can be recorded. A resolution never
 *    satisfies a P0 or P1.
 * 4. A P2 outside the diff of the new head does not block. "In the diff" means anchored to a line
 *    the pull request adds or changes at that head (or to a changed gitlink path).
 */
import { createHash } from 'node:crypto';
import { claimTokens, claimType, compareClaims } from './claimSimilarity';
import { changedLineNumbers } from './reviewCore';

export const FINDING_FINGERPRINT_PREFIX = 'fp1_';
export const FINDING_MARKER_PREFIX = '<!-- review-yeti:finding';
/** Characters of meaningful text a resolution reply needs before it counts as a stated reason. */
export const MIN_RESOLUTION_REASON_CHARS = 12;
const MAX_MARKER_TITLE_CHARS = 300;

export type FindingSeverity = 'P0' | 'P1' | 'P2';

export interface ConvergenceFinding {
  severity?: string;
  path?: string;
  line?: number;
  title?: string;
  body?: string;
}

export interface ConvergenceChangedFile {
  path: string;
  patch?: string;
  mode?: string;
  isSubmodule?: boolean;
}

export interface FindingThreadResolution {
  /** Login of the human who stated the reason. */
  author: string;
  /** The stated reason, bounded. */
  reason: string;
  /** When the reason was written (ISO-8601), when GitHub reported it. */
  at?: string;
}

/** One bot-published finding thread as read back from the pull request. */
export interface PriorFindingThread {
  threadId?: string;
  fingerprint: string;
  severity: FindingSeverity;
  path: string;
  line?: number;
  title: string;
  body?: string;
  resolved: boolean;
  outdated: boolean;
  /** Present only when the thread is resolved AND a human reply states a reason. */
  resolution?: FindingThreadResolution;
}

export type ConvergenceStatus =
  /** Not seen before; blocks (any severity). */
  | 'new'
  /** Matches an open prior thread; blocks (any severity). */
  | 'carried'
  /** P2 matching a thread the author resolved with a reason; does not block. */
  | 'satisfied'
  /** P2 not anchored to a line this head changes; does not block. */
  | 'outside-diff';

export interface ConvergenceEntry<F extends ConvergenceFinding = ConvergenceFinding> {
  finding: F;
  severity: FindingSeverity;
  /** The stable identity: the matched prior thread's fingerprint, or this finding's own. */
  fingerprint: string;
  status: ConvergenceStatus;
  blocking: boolean;
  matchedThread?: PriorFindingThread;
  resolution?: FindingThreadResolution;
}

export interface ConvergenceResult<F extends ConvergenceFinding = ConvergenceFinding> {
  entries: ConvergenceEntry<F>[];
  /** Findings that block the merge, in input order. */
  required: F[];
  /** Entries that do not block, with the reason (`satisfied` or `outside-diff`). */
  nonBlocking: ConvergenceEntry<F>[];
  /** Prior threads no current finding matched: fixed (or no longer reported) on this head. */
  droppedPrior: PriorFindingThread[];
  counts: {
    required: number;
    requiredP0: number;
    requiredP1: number;
    requiredP2: number;
    satisfied: number;
    outsideDiff: number;
    droppedPrior: number;
  };
}

function severityOf(finding: ConvergenceFinding): FindingSeverity {
  const value = String(finding?.severity || 'P2').toUpperCase();
  return value === 'P0' || value === 'P1' ? value : 'P2';
}

function normalizedPath(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\\/g, '/').replace(/^\.\//, '').trim() : '';
}

/**
 * The stable identity of a finding: file, claim archetype and the claim tokens of its title. Line
 * numbers and body wording are deliberately excluded -- both move between heads while the claim
 * stays the same. Severity is excluded so a re-filed P1 -> P2 keeps its thread.
 */
export function findingFingerprint(finding: ConvergenceFinding): string {
  const title = typeof finding?.title === 'string' ? finding.title : '';
  const tokens = [...claimTokens(title)].sort().join(' ');
  const material = `v1|${normalizedPath(finding?.path)}|${claimType(finding)}|${tokens}`;
  return FINDING_FINGERPRINT_PREFIX + createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 24);
}

export function isFindingFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^fp1_[a-f0-9]{24}$/u.test(value);
}

/** The hidden marker a published finding thread carries so a later head can recognise it. */
export function renderFindingMarker(input: { fingerprint: string; severity: FindingSeverity; title: string }): string {
  const title = Buffer.from(String(input.title || '').slice(0, MAX_MARKER_TITLE_CHARS), 'utf8').toString('base64url');
  return `${FINDING_MARKER_PREFIX} v=1 fp=${input.fingerprint} sev=${input.severity} t=${title} -->`;
}

/** Parses a marker written by `renderFindingMarker`; null for anything else. */
export function parseFindingMarker(body: unknown): { fingerprint: string; severity: FindingSeverity; title: string } | null {
  if (typeof body !== 'string') return null;
  const match = /<!-- review-yeti:finding v=1 fp=(fp1_[a-f0-9]{24}) sev=(P0|P1|P2) t=([A-Za-z0-9_-]*) -->/u.exec(body);
  if (!match) return null;
  let title = '';
  try { title = Buffer.from(match[3], 'base64url').toString('utf8').slice(0, MAX_MARKER_TITLE_CHARS); } catch { title = ''; }
  return { fingerprint: match[1], severity: match[2] as FindingSeverity, title };
}

/**
 * The reason a human gave when replying to a finding thread, or null. Bot replies, empty replies,
 * and one-word acknowledgements ("done", "ok", "+1") are not a stated reason.
 */
export function statedResolutionReason(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/<!--[\s\S]*?-->/gu, ' ').replace(/\s+/gu, ' ').trim();
  const meaningful = cleaned.replace(/[^\p{L}\p{N}]/gu, '');
  if (meaningful.length < MIN_RESOLUTION_REASON_CHARS) return null;
  return cleaned.slice(0, 1_000);
}

/** Added/changed new-file lines per path; `null` for a path whose patch has no line hunks. */
function changedLineIndex(changedFiles: readonly ConvergenceChangedFile[]): Map<string, Set<number> | null> {
  const index = new Map<string, Set<number> | null>();
  for (const file of changedFiles) {
    const path = normalizedPath(file?.path);
    if (!path) continue;
    const gitlink = file.isSubmodule === true || String(file.mode) === '160000';
    const lines = gitlink ? null : changedLineNumbers(file.patch);
    index.set(path, lines && lines.size > 0 ? lines : null);
  }
  return index;
}

function insideDiff(finding: ConvergenceFinding, index: Map<string, Set<number> | null>): boolean {
  const path = normalizedPath(finding?.path);
  if (!index.has(path)) return false;
  const lines = index.get(path);
  // A changed path without line hunks (gitlink, binary, mode-only) is in the diff as a path.
  if (lines === null || lines === undefined) return true;
  const line = Number(finding?.line);
  return Number.isInteger(line) && lines.has(line);
}

function matchThread(finding: ConvergenceFinding, fingerprint: string,
  threads: readonly PriorFindingThread[], used: Set<PriorFindingThread>): PriorFindingThread | undefined {
  const free = threads.filter((thread) => !used.has(thread));
  const exact = free.find((thread) => thread.fingerprint === fingerprint);
  if (exact) return exact;
  let best: { thread: PriorFindingThread; similarity: number } | undefined;
  for (const thread of free) {
    const comparison = compareClaims(
      { path: thread.path, line: thread.outdated ? null : thread.line ?? null, title: thread.title, body: thread.body ?? '' },
      finding,
    );
    if (comparison.duplicate && (!best || comparison.similarity > best.similarity)) {
      best = { thread, similarity: comparison.similarity };
    }
  }
  return best?.thread;
}

/**
 * The single convergence decision. `findings` are the canonical (sanitized, clustered) findings
 * of the current head; `priorThreads` are the bot's finding threads read from the pull request;
 * `changedFiles` is the new head's diff.
 */
export function evaluateFindingConvergence<F extends ConvergenceFinding>(input: {
  findings: readonly F[];
  changedFiles: readonly ConvergenceChangedFile[];
  priorThreads?: readonly PriorFindingThread[];
}): ConvergenceResult<F> {
  const threads = Array.isArray(input.priorThreads) ? input.priorThreads : [];
  const index = changedLineIndex(Array.isArray(input.changedFiles) ? input.changedFiles : []);
  const used = new Set<PriorFindingThread>();
  const entries: ConvergenceEntry<F>[] = [];
  for (const finding of Array.isArray(input.findings) ? input.findings : []) {
    const severity = severityOf(finding);
    const own = findingFingerprint(finding);
    const matchedThread = matchThread(finding, own, threads, used);
    if (matchedThread) used.add(matchedThread);
    const fingerprint = matchedThread?.fingerprint ?? own;
    let status: ConvergenceStatus = matchedThread ? 'carried' : 'new';
    let resolution: FindingThreadResolution | undefined;
    if (severity === 'P2') {
      if (matchedThread?.resolved === true && matchedThread.resolution) {
        status = 'satisfied';
        resolution = matchedThread.resolution;
      } else if (!insideDiff(finding, index)) {
        status = 'outside-diff';
      }
    }
    const blocking = status === 'new' || status === 'carried';
    entries.push({
      finding, severity, fingerprint, status, blocking,
      ...(matchedThread ? { matchedThread } : {}),
      ...(resolution ? { resolution } : {}),
    });
  }
  const required = entries.filter((entry) => entry.blocking).map((entry) => entry.finding);
  const nonBlocking = entries.filter((entry) => !entry.blocking);
  const droppedPrior = threads.filter((thread) => !used.has(thread));
  const count = (predicate: (entry: ConvergenceEntry<F>) => boolean) => entries.filter(predicate).length;
  return {
    entries,
    required,
    nonBlocking,
    droppedPrior,
    counts: {
      required: required.length,
      requiredP0: count((entry) => entry.blocking && entry.severity === 'P0'),
      requiredP1: count((entry) => entry.blocking && entry.severity === 'P1'),
      requiredP2: count((entry) => entry.blocking && entry.severity === 'P2'),
      satisfied: count((entry) => entry.status === 'satisfied'),
      outsideDiff: count((entry) => entry.status === 'outside-diff'),
      droppedPrior: droppedPrior.length,
    },
  };
}

/** One-line, bounded rendering of the convergence for a check summary. */
export function renderConvergenceSummary(result: ConvergenceResult, options: { threadsRead: boolean }): string[] {
  const lines: string[] = [];
  const { counts } = result;
  lines.push(`Required findings: ${counts.required} (P0: ${counts.requiredP0}, P1: ${counts.requiredP1}, P2: ${counts.requiredP2}). P0, P1 and P2 findings all block the merge.`);
  if (counts.required > 0 && counts.requiredP2 > 0) {
    lines.push('To clear a P2: fix it, or reply on its review thread with the reason it does not apply and resolve the thread. The next head records the resolution.');
  }
  const satisfied = result.nonBlocking.filter((entry) => entry.status === 'satisfied');
  if (satisfied.length > 0) {
    lines.push(`Satisfied by a resolved thread with a stated reason (${satisfied.length}):`);
    for (const entry of satisfied.slice(0, 20)) {
      const reason = (entry.resolution?.reason || '').replace(/[`<>\r\n]/gu, ' ').slice(0, 160);
      lines.push(`- \`${entry.fingerprint}\` ${String(entry.finding.path || '')}: resolved by @${entry.resolution?.author || 'unknown'} -- ${reason}`);
    }
  }
  if (counts.outsideDiff > 0) lines.push(`${counts.outsideDiff} P2 finding(s) outside this head's diff are advisory and do not block.`);
  if (counts.droppedPrior > 0) lines.push(`${counts.droppedPrior} previously raised finding(s) were not reported at this head and no longer block.`);
  if (!options.threadsRead) lines.push('Review thread state could not be read, so no P2 was treated as resolved on this run.');
  return lines;
}
