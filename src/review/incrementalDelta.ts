/**
 * Delta-scoped incremental re-review (ADR 0770; extends REL-1084, `incrementalReview.ts`).
 *
 * REL-1084 carries an unchanged file forward but re-reviews a TOUCHED file whole. A pull request
 * under repair touches the same few files on every push, so almost nothing carries and each push
 * pays for a full re-read whose only output is new nitpicks on lines nobody changed. The delta
 * scope narrows exactly that case: a touched file that the previous review covered in full and
 * left with no open finding is shown to the lanes as the change since the previous head.
 *
 * Everything here is pure and deterministic. It never calls a model:
 *
 * - Hunks are never a unit of LLM work. They are ledger ITEMS routed (by path, deterministically)
 *   into the tasks the one composed plan turn already produced. `deltaMaxTasks` bounds that plan,
 *   so the number of model calls is a function of the task bound, never of hunks or files.
 * - Every item must come back with an explicit outcome (`resolved`/`still-open`/`unclear` for an
 *   open prior finding, `clean`/`finding` for a delta file). A missing, unknown or inconsistent
 *   outcome is rejected and never counted as resolved.
 */
import { createHash } from 'node:crypto';
import type { IncrementalDeltaFile, IncrementalOpenFinding } from '../types/incrementalReview';
import { changedLineNumbers } from './reviewCore';
import { repositoryFlagEnabledFor } from './repositoryFlag';

export const INCREMENTAL_DELTA_FLAG = 'REVIEW_YETI_INCREMENTAL_DELTA';
export const INCREMENTAL_MAX_CHAIN_ENV = 'REVIEW_YETI_INCREMENTAL_MAX_CHAIN';
/** Consecutive incremental reviews allowed before the next head is reviewed in full. */
export const DEFAULT_INCREMENTAL_MAX_CHAIN = 4;
const MAX_INCREMENTAL_MAX_CHAIN = 20;
/** Lines of context kept around a changed line when deciding what a delta review actually read. */
export const DELTA_CONTEXT_LINES = 20;
/** A delta re-review plans at most this many tasks, and never more than the previous full plan did. */
export const DELTA_DEFAULT_MAX_TASKS = 3;
/** Open prior findings the ledger itemizes; the rest are still reviewed through their whole files. */
export const MAX_LEDGER_PRIOR_ITEMS = 200;

/**
 * `REVIEW_YETI_INCREMENTAL_DELTA`: same grammar as `REVIEW_YETI_INCREMENTAL` (off by default, `all`,
 * or an `owner/repo` list). It only narrows what an already-enabled incremental review does, so
 * enabling it without `REVIEW_YETI_INCREMENTAL` has no effect.
 */
export function incrementalDeltaEnabledFor(env: Readonly<Record<string, string | undefined>>, repository: string): boolean {
  return repositoryFlagEnabledFor(env, INCREMENTAL_DELTA_FLAG, repository);
}

/** Whole number 1 to 20. Unset or invalid is the default. */
export function incrementalMaxChainFrom(env: Readonly<Record<string, string | undefined>>): number {
  const raw = String(env[INCREMENTAL_MAX_CHAIN_ENV] ?? '').trim();
  if (!/^\d{1,2}$/u.test(raw)) return DEFAULT_INCREMENTAL_MAX_CHAIN;
  const value = Number(raw);
  return value >= 1 && value <= MAX_INCREMENTAL_MAX_CHAIN ? value : DEFAULT_INCREMENTAL_MAX_CHAIN;
}

// ---------------------------------------------------------------------------
// Hunks and reviewed regions
// ---------------------------------------------------------------------------

export interface DeltaHunkRange {
  /** Zero-based position of the hunk in the patch, the `#<index>` of its ledger id. */
  index: number;
  /** First and last new-file line the hunk covers. */
  start: number;
  end: number;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

/** The new-file line span of every hunk in a unified patch, in order. */
export function deltaHunkRanges(patch: string): DeltaHunkRange[] {
  const ranges: DeltaHunkRange[] = [];
  for (const line of String(patch ?? '').split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (!header) continue;
    const start = Number(header[1]);
    const length = header[2] === undefined ? 1 : Number(header[2]);
    ranges.push({ index: ranges.length, start, end: Math.max(start, start + length - 1) });
  }
  return ranges;
}

/**
 * New-file lines a delta review actually read: every added or changed line of the delta patch plus
 * `context` lines on each side. A finding anchored outside this set is about code the previous
 * review already covered in full and this change did not touch.
 */
export function deltaReviewedLines(patch: string, context: number = DELTA_CONTEXT_LINES): Set<number> {
  const reviewed = new Set<number>();
  for (const line of changedLineNumbers(patch) as Iterable<number>) {
    for (let at = Math.max(1, line - context); at <= line + context; at += 1) reviewed.add(at);
  }
  // A pure deletion has no new-file line; its hunk range (the surrounding context) was read.
  for (const range of deltaHunkRanges(patch)) {
    for (let at = range.start; at <= range.end; at += 1) reviewed.add(at);
  }
  return reviewed;
}

const DELTA_NOTE_PREFIX = '\\ Review Yeti:';

/**
 * The patch a lane sees for a delta-scoped file: the pull request's own file header, a note naming
 * what this is and where the rest is, then the change since the previous head.
 */
export function deltaScopedPatch(prPatch: string | undefined, deltaPatch: string, previousHeadSha: string): string {
  const header: string[] = [];
  for (const line of String(prPatch ?? '').split('\n')) {
    if (line.startsWith('@@ ')) break;
    header.push(line);
  }
  const head = header.length > 0 && header[header.length - 1] === '' ? header.slice(0, -1) : header;
  const body = deltaPatch.endsWith('\n') ? deltaPatch : `${deltaPatch}\n`;
  return `${[...head, `${DELTA_NOTE_PREFIX} re-review of the change since the previously reviewed head ${previousHeadSha}; `
    + 'the rest of this file was reviewed in full at that head with no open finding. '
    + 'The full pull-request patch for this file is available through the diff tool'].join('\n')}\n${body}`;
}

/** Number of tasks a delta re-review may plan. Never more than the previous full plan nor `maxTasks`. */
export function deltaMaxTasks(maxTasks: number, previousTaskCount?: number): number {
  const previous = Number.isSafeInteger(previousTaskCount) && (previousTaskCount as number) >= 1
    ? (previousTaskCount as number) : DELTA_DEFAULT_MAX_TASKS;
  const bounded = Number.isSafeInteger(maxTasks) && maxTasks >= 1 ? maxTasks : DELTA_DEFAULT_MAX_TASKS;
  return Math.max(1, Math.min(bounded, previous, DELTA_DEFAULT_MAX_TASKS));
}

// ---------------------------------------------------------------------------
// The grouped, itemized ledger
// ---------------------------------------------------------------------------

/** Stable id of a prior finding for the ledger, independent of its published fingerprint. */
export function priorFindingLedgerId(finding: { path: string; line?: number; title: string }): string {
  const digest = createHash('sha256').update(`${finding.path}\0${finding.line ?? ''}\0${finding.title}`).digest('hex');
  return `f_${digest.slice(0, 12)}`;
}

export function openFindingFrom(finding: { path: string; line?: number; severity: string; title: string }): IncrementalOpenFinding {
  return {
    id: priorFindingLedgerId(finding), path: finding.path,
    ...(Number.isInteger(finding.line) && (finding.line as number) > 0 ? { line: finding.line } : {}),
    severity: finding.severity, title: finding.title.slice(0, 200),
  };
}

export type LedgerKind = 'prior' | 'delta';

export interface LedgerItem {
  /** `prior:<findingId>` or `delta:<path>#<hunkIndex>`. */
  id: string;
  kind: LedgerKind;
  path: string;
  /** Prior finding, or hunk span, for display. */
  line?: number;
  endLine?: number;
  title?: string;
}

export const PRIOR_OUTCOMES = ['resolved', 'still-open', 'unclear'] as const;
export const DELTA_OUTCOMES = ['clean', 'finding'] as const;
export type LedgerOutcome = typeof PRIOR_OUTCOMES[number] | typeof DELTA_OUTCOMES[number];

export interface LedgerEntry {
  item: string;
  outcome: LedgerOutcome;
  note: string;
}

/** Every item of the delta re-review, in a fixed order. Pure over the scope. */
export function buildLedgerItems(input: {
  deltaFiles: readonly IncrementalDeltaFile[];
  openFindings: readonly IncrementalOpenFinding[];
}): LedgerItem[] {
  const items: LedgerItem[] = [];
  for (const finding of [...input.openFindings].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_LEDGER_PRIOR_ITEMS)) {
    items.push({ id: `prior:${finding.id}`, kind: 'prior', path: finding.path,
      ...(finding.line ? { line: finding.line } : {}), title: finding.title });
  }
  for (const file of [...input.deltaFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const range of deltaHunkRanges(file.patch)) {
      items.push({ id: `delta:${file.path}#${range.index}`, kind: 'delta', path: file.path, line: range.start, endLine: range.end });
    }
  }
  return items;
}

export interface LedgerRouting {
  /** Task id to its items. Every item appears under exactly one task. */
  byTask: Map<string, LedgerItem[]>;
  /** Items whose path no task covered; routed to the first task so none is dropped. */
  fallbackRouted: string[];
}

/**
 * Route each item to the ONE task whose `paths` cover it: the first such task in plan order, or the
 * first task when none does (documentation or unlisted paths). No model is involved, so the number
 * of model calls cannot depend on how many items there are. Empty when the plan has no tasks.
 */
export function routeLedgerItems(tasks: ReadonlyArray<{ id: string; paths: readonly string[] }>, items: readonly LedgerItem[]): LedgerRouting {
  const byTask = new Map<string, LedgerItem[]>();
  const fallbackRouted: string[] = [];
  if (tasks.length === 0) return { byTask, fallbackRouted };
  for (const task of tasks) byTask.set(task.id, []);
  for (const item of items) {
    const owner = tasks.find((task) => task.paths.includes(item.path));
    if (!owner) fallbackRouted.push(item.id);
    byTask.get((owner ?? tasks[0]).id)!.push(item);
  }
  return { byTask, fallbackRouted };
}

/** The ledger block appended to a task directive. Empty string when the task has no items. */
export function renderLedgerDirective(items: readonly LedgerItem[]): string {
  if (items.length === 0) return '';
  const lines = [
    '=== RE-REVIEW LEDGER ===',
    'This is an incremental re-review. In addition to your normal findings you MUST return a "ledger" array with exactly one entry for each item below, using its exact id as "item":',
    '- prior:<id> is a finding raised at the previous head on a file included in full here. Outcome "resolved" only if the current code no longer has the defect, "still-open" if it does, "unclear" if you cannot tell. A finding that is still open must also appear in "findings".',
    '- delta:<path>#<n> is one hunk of the change since the previous head. Outcome "finding" if you report a finding for it (the finding must be on that path), otherwise "clean". Review only what that hunk changes and what it directly affects; code outside it was already reviewed in full.',
    'Each entry has "item", "outcome" and a short "note". Do not add entries for other ids and do not omit any.',
    ...items.map((item) => {
      const where = item.kind === 'delta'
        ? `${item.path} lines ${item.line}-${item.endLine}`
        : `${item.path}${item.line ? `:${item.line}` : ''} ${JSON.stringify(item.title ?? '')}`;
      return `- ${item.id}: ${where}`;
    }),
  ];
  return lines.join('\n');
}

export type LedgerValidation =
  | { valid: true; entries: LedgerEntry[] }
  | { valid: false; error: string; missing: string[] };

/**
 * Check a task's reported ledger against the items it was assigned: every item exactly once, no
 * extras, an outcome that is legal for its kind, and a `finding` outcome only when the task also
 * reported a finding on that path. Anything else is invalid; nothing is inferred from silence.
 */
export function validateLedgerEntries(
  assigned: readonly LedgerItem[],
  reported: unknown,
  findings: ReadonlyArray<{ path?: string }>,
): LedgerValidation {
  if (assigned.length === 0) return { valid: true, entries: [] };
  if (!Array.isArray(reported)) return { valid: false, error: 'ledger missing', missing: assigned.map((item) => item.id) };
  const byId = new Map(assigned.map((item) => [item.id, item]));
  const seen = new Map<string, LedgerEntry>();
  for (const raw of reported) {
    const entry = raw as { item?: unknown; outcome?: unknown; note?: unknown } | null;
    if (!entry || typeof entry.item !== 'string' || typeof entry.outcome !== 'string') {
      return { valid: false, error: 'ledger entry malformed', missing: [] };
    }
    const item = byId.get(entry.item);
    if (!item) return { valid: false, error: `ledger names an item that was not assigned: ${entry.item.slice(0, 120)}`, missing: [] };
    if (seen.has(entry.item)) return { valid: false, error: `ledger lists ${entry.item} twice`, missing: [] };
    const legal: readonly string[] = item.kind === 'prior' ? PRIOR_OUTCOMES : DELTA_OUTCOMES;
    if (!legal.includes(entry.outcome)) {
      return { valid: false, error: `ledger outcome "${entry.outcome.slice(0, 40)}" is not valid for ${item.kind} item ${item.id}`, missing: [] };
    }
    if (entry.outcome === 'finding' && !findings.some((finding) => finding.path === item.path)) {
      return { valid: false, error: `ledger reports a finding for ${item.id} but no finding is on ${item.path}`, missing: [] };
    }
    seen.set(entry.item, { item: entry.item, outcome: entry.outcome as LedgerOutcome,
      note: typeof entry.note === 'string' ? entry.note.slice(0, 300) : '' });
  }
  const missing = assigned.filter((item) => !seen.has(item.id)).map((item) => item.id);
  if (missing.length > 0) return { valid: false, error: `ledger omits ${missing.length} assigned item(s)`, missing };
  return { valid: true, entries: assigned.map((item) => seen.get(item.id)!) };
}

export interface LedgerTotals {
  resolved: number;
  stillOpen: number;
  unclear: number;
  clean: number;
  finding: number;
}

export function ledgerTotals(entries: readonly LedgerEntry[]): LedgerTotals {
  const totals: LedgerTotals = { resolved: 0, stillOpen: 0, unclear: 0, clean: 0, finding: 0 };
  for (const entry of entries) {
    if (entry.outcome === 'resolved') totals.resolved += 1;
    else if (entry.outcome === 'still-open') totals.stillOpen += 1;
    else if (entry.outcome === 'unclear') totals.unclear += 1;
    else if (entry.outcome === 'clean') totals.clean += 1;
    else totals.finding += 1;
  }
  return totals;
}

/** `unclear` is never a resolution: it counts with the open findings. */
export function unresolvedPriorCount(entries: readonly LedgerEntry[]): number {
  return entries.filter((entry) => entry.item.startsWith('prior:') && entry.outcome !== 'resolved').length;
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

const MAX_LEDGER_LINES = 40;

function ledgerCode(value: string): string {
  return `\`${value.replace(/[`\r\n]/gu, ' ')}\``;
}

/**
 * Check-summary lines for a delta re-review's ledger: totals first, then one line per item grouped
 * under its task. Bounded, and every unrecorded task is named, so nothing reads as resolved by silence.
 */
export function renderIncrementalLedgerSummary(ledger: {
  maxTasks: number;
  plannedTasks: number;
  itemCount: number;
  tasks: ReadonlyArray<{ taskId: string; dimension: string; entries: ReadonlyArray<{ item: string; outcome: string }> }>;
  unrecordedTaskIds: readonly string[];
  fallbackRoutedItems: readonly string[];
} | null | undefined): string[] {
  if (!ledger) return [];
  const all = ledger.tasks.flatMap((task) => task.entries);
  const count = (outcome: string) => all.filter((entry) => entry.outcome === outcome).length;
  const lines = [
    `**Delta re-review ledger**: ${ledger.itemCount} item(s) grouped into ${ledger.plannedTasks} task(s) (at most ${ledger.maxTasks}; `
    + 'no model call is made per hunk or file). '
    + `Outcomes: ${count('resolved')} resolved, ${count('still-open')} still open, ${count('unclear')} unclear (counted as open), `
    + `${count('clean')} clean, ${count('finding')} with a finding.`,
  ];
  let shown = 0;
  for (const task of ledger.tasks) {
    lines.push(`- Task ${ledgerCode(task.taskId)} (${task.dimension}):`);
    for (const entry of task.entries) {
      if (shown >= MAX_LEDGER_LINES) break;
      lines.push(`  - ${ledgerCode(entry.item)} -> ${entry.outcome}`);
      shown += 1;
    }
  }
  if (all.length > shown) lines.push(`- +${all.length - shown} more item outcome(s) not listed`);
  if (ledger.unrecordedTaskIds.length > 0) {
    lines.push(`- No outcome recorded for task(s) ${ledger.unrecordedTaskIds.map(ledgerCode).join(', ')}; their items are counted as not verified.`);
  }
  if (ledger.fallbackRoutedItems.length > 0) {
    lines.push(`- ${ledger.fallbackRoutedItems.length} item(s) were on paths no task listed and were routed to the first task.`);
  }
  return lines;
}
