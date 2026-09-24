/**
 * Deterministic diff shrinking (REL-1079; plan
 * `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`,
 * section 4 W2). Behind `REVIEW_YETI_DIFF_SHRINK`, default off.
 *
 * Before any model sees the diff, three deterministic rules reduce what is SENT
 * for a file. None of them removes a file from review:
 *
 * 1. Whitespace. A hunk whose removed and added lines are equal once leading and
 *    trailing ASCII whitespace and blank lines are ignored is collapsed to a
 *    one-line note. A file whose every hunk is whitespace-only is listed, not
 *    sent. Whitespace-significant formats (Python, YAML, Makefiles, ...) are
 *    never collapsed, and whitespace inside a line is never ignored, because
 *    either can change behaviour.
 * 2. Renames and copies. A `rename from`/`copy from` diff header (git `-M -C`,
 *    which GitHub's diff already applies for renames) is disclosed as
 *    `old -> new (similarity N%)`; a pure rename sends only that header and a
 *    modified one only its changed hunks. A deleted file and an added file whose
 *    entire contents are byte-identical and unique in the diff (a move the diff
 *    source did not pair, e.g. past git's rename limit) are paired the same way.
 * 3. `.gitattributes`. A path the repository's root `.gitattributes` marks
 *    `linguist-generated` or `linguist-vendored` is listed without content,
 *    alongside the existing lockfile / generated / `dist/` rules. The caller
 *    (see `loadDiffShrinkInput`) only supplies rules the pull request itself
 *    cannot have written.
 *
 * Safety (plan section 3):
 *
 * - One decision. Shrinking runs strictly AFTER `resolveReviewApplicability`,
 *   through `resolveShrunkReviewApplicability`, and replaces only patch text.
 *   Every file stays in `effectiveFiles`, so the applicable lanes, the
 *   no-reviewable-content exemption and the unmatched-path failure are exactly
 *   those the service's trusted completion context derives without the flag.
 *   (This is also why `.gitattributes` exclusions keep the file listed: the
 *   service cannot read `.gitattributes`, so dropping the file would let the
 *   worker and the service disagree about which lanes apply -- REL-1056.)
 * - Security-sensitive paths (`isSecuritySensitivePath`) are never shrunk.
 * - Submodule gitlinks, symlinks, binary files and mode changes are never shrunk.
 * - The fast-ship size bar reads the ORIGINAL patch size (`byteSize`), so a
 *   shrunk file never becomes fast-ship eligible because it was shrunk.
 * - Disclosure: `renderDiffShrinkSummary` lists every file each rule touched and
 *   every sensitive file a rule declined, for the check summary.
 *
 * Formatter-only detection (the plan's fourth bullet) is NOT implemented: it
 * needs a repository's formatter run on both sides, and a formatter's config
 * and plugins are repository code. It stays a documented follow-up until the
 * worker has a formatter it can run without executing repository code.
 */
import type { RepoFileProvider } from '../panel/panelEngine';
import { linguistExclusionFor, parseLinguistAttributes, type LinguistAttribute } from './gitattributesLinguist';
import { isRegularFileMode } from './lockfileChangeVerification';
import {
  isSubmoduleEntry,
  resolveReviewApplicability,
  type EffectiveReviewFile,
  type ReviewApplicability,
  type ReviewApplicabilityInputFile,
  buildEffectiveReviewFiles,
} from './personaApplicability';
import { isSecuritySensitivePath } from './securitySensitivePaths';

export const DIFF_SHRINK_FLAG = 'REVIEW_YETI_DIFF_SHRINK';

/** Why the root `.gitattributes` linguist rules are or are not applied. */
export type LinguistRulesState =
  | { status: 'applied'; content: string }
  | { status: 'none-declared' }
  | { status: 'not-applied'; reason: string };

export interface DiffShrinkInput {
  enabled: boolean;
  linguist?: LinguistRulesState;
}

export type ShrinkRule = 'whitespace' | 'rename' | 'linguist';

export interface DiffShrinkRename {
  from: string;
  to: string;
  /** Percentage from the diff header, or 100 for a content-matched move; null when the header gave none. */
  similarity: number | null;
  kind: 'rename' | 'copy';
  detectedBy: 'diff-header' | 'content-match';
  /** `none` for a pure rename/move, `changed-hunks` when the file also changed. */
  contentSent: 'none' | 'changed-hunks';
}

export interface DiffShrinkDisclosure {
  whitespaceOnlyFiles: string[];
  collapsedWhitespaceHunks: Array<{ path: string; hunks: number }>;
  renames: DiffShrinkRename[];
  linguistExcluded: Array<{ path: string; attribute: LinguistAttribute }>;
  linguistRules: 'applied' | 'none-declared' | 'not-provided' | { notApplied: string };
  /** Security-sensitive files a rule would have shrunk, kept at full depth instead. */
  keptFullDepth: Array<{ path: string; rule: ShrinkRule }>;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

const NOTE_PREFIX = '\\ Review Yeti:';

/**
 * Formats where leading/trailing whitespace or blank lines carry meaning. A
 * whitespace-only change there is a real change and is always sent in full.
 */
const WHITESPACE_SIGNIFICANT_EXTENSION =
  /\.(py|pyi|pyx|pxd|yaml|yml|mk|mak|haml|pug|jade|sass|styl|coffee|nim|hs|lhs|elm|fs|fsi|fsx|slim|tsv|csv|diff|patch|rst|md|markdown|mdown|mkdn|snap|tmpl|tpl|j2|jinja|jinja2|erb|mustache|hbs|txt)$/iu;
const WHITESPACE_SIGNIFICANT_BASENAME = /^(makefile|gnumakefile|.*\.mk|procfile|dockerfile.*|\.editorconfig)$/iu;

export function isWhitespaceSignificantPath(filePath: string): boolean {
  const base = (filePath.split('/').pop() || filePath);
  return WHITESPACE_SIGNIFICANT_EXTENSION.test(filePath) || WHITESPACE_SIGNIFICANT_BASENAME.test(base);
}

interface ParsedPatch {
  header: string[];
  hunks: Array<{ header: string; lines: string[] }>;
}

function parsePatch(patch: string): ParsedPatch {
  const lines = patch.split('\n');
  const header: string[] = [];
  const hunks: ParsedPatch['hunks'] = [];
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      hunks.push({ header: line, lines: [] });
    } else if (hunks.length === 0) {
      header.push(line);
    } else {
      hunks[hunks.length - 1].lines.push(line);
    }
  }
  return { header, hunks };
}

function joinPatch(header: readonly string[], body: readonly string[]): string {
  // Keep the trailing newline shape git produces: drop a dangling empty line
  // from the header split, then end with exactly one newline.
  const head = header.length > 0 && header[header.length - 1] === '' ? header.slice(0, -1) : header;
  return `${[...head, ...body].join('\n')}\n`;
}

const EDGE_ASCII_WHITESPACE = /^[ \t\r\f\v]+|[ \t\r\f\v]+$/gu;

function normalizedChangedLines(lines: readonly string[], sign: '+' | '-'): string[] {
  return lines
    .filter((line) => line.startsWith(sign))
    .map((line) => line.slice(1).replace(EDGE_ASCII_WHITESPACE, ''))
    .filter((line) => line.length > 0);
}

/** True when a hunk changes nothing but edge whitespace and blank lines. */
export function isWhitespaceOnlyHunk(lines: readonly string[]): boolean {
  const changed = lines.some((line) => line.startsWith('+') || line.startsWith('-'));
  if (!changed) return false;
  const removed = normalizedChangedLines(lines, '-');
  const added = normalizedChangedLines(lines, '+');
  return removed.length === added.length && removed.every((line, index) => line === added[index]);
}

function hunkRange(header: string): string {
  const match = /^@@ (-\S+ \+\S+) @@/u.exec(header);
  return match ? match[1] : 'unknown range';
}

function changedLineCount(parsed: ParsedPatch): number {
  return parsed.hunks.reduce(
    (count, hunk) => count + hunk.lines.filter((line) => line.startsWith('+') || line.startsWith('-')).length,
    0,
  );
}

function hasModeChange(header: readonly string[]): boolean {
  return header.some((line) => /^(old|new) mode /u.test(line));
}

function isBinaryPatch(header: readonly string[]): boolean {
  return header.some((line) => /^Binary files .* differ$/u.test(line) || line === 'GIT binary patch');
}

function unquote(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

function headerRename(header: readonly string[]): Omit<DiffShrinkRename, 'to' | 'contentSent'> | null {
  let from: string | null = null;
  let kind: DiffShrinkRename['kind'] = 'rename';
  let similarity: number | null = null;
  for (const line of header) {
    const renamed = /^(rename|copy) from (.+)$/u.exec(line);
    if (renamed) { kind = renamed[1] as DiffShrinkRename['kind']; from = unquote(renamed[2]); }
    const score = /^similarity index (\d{1,3})%$/u.exec(line);
    if (score) similarity = Number(score[1]);
  }
  return from === null ? null : { from, kind, similarity, detectedBy: 'diff-header' };
}

/** A regular text file this module may shrink at all (any rule). */
function shrinkable(file: EffectiveReviewFile, parsed: ParsedPatch): boolean {
  if (typeof file.patch !== 'string' || file.patch.length === 0) return false;
  if (isSubmoduleEntry(file) || !isRegularFileMode(file.mode)) return false;
  return !hasModeChange(parsed.header) && !isBinaryPatch(parsed.header);
}

/** Whole-file content of a pure addition or pure deletion, or null. */
function wholeFileContent(parsed: ParsedPatch, side: 'added' | 'deleted'): string | null {
  const marker = side === 'added' ? /^new file mode 100(644|755)$/u : /^deleted file mode 100(644|755)$/u;
  if (!parsed.header.some((line) => marker.test(line)) || parsed.hunks.length !== 1) return null;
  const sign = side === 'added' ? '+' : '-';
  const body = parsed.hunks[0].lines.filter((line) => line !== '');
  if (body.length === 0 || body.some((line) => !line.startsWith(sign) && !line.startsWith('\\'))) return null;
  // Keep the "\ No newline at end of file" marker: it is part of the content.
  const content = body.join('\n');
  return content.length > 1 ? content : null;
}

function fileMode(parsed: ParsedPatch): string | null {
  for (const line of parsed.header) {
    const match = /^(?:new|deleted) file mode (\d+)$/u.exec(line);
    if (match) return match[1];
  }
  return null;
}

function estimateTokens(files: readonly EffectiveReviewFile[]): number {
  return Math.ceil(files.reduce((chars, file) => chars + (file.patch?.length ?? 0) + (file.content?.length ?? 0), 0) / 4);
}

function linguistRulesState(input: DiffShrinkInput): DiffShrinkDisclosure['linguistRules'] {
  const state = input.linguist;
  if (!state) return 'not-provided';
  if (state.status === 'not-applied') return { notApplied: state.reason };
  return state.status;
}

/**
 * Apply the shrink rules to the post-filter effective files. Pure and
 * deterministic: the same files and input always give the same result.
 */
export function planDiffShrink(
  files: readonly EffectiveReviewFile[],
  input: DiffShrinkInput,
): { files: EffectiveReviewFile[]; disclosure: DiffShrinkDisclosure } {
  const disclosure: DiffShrinkDisclosure = {
    whitespaceOnlyFiles: [],
    collapsedWhitespaceHunks: [],
    renames: [],
    linguistExcluded: [],
    linguistRules: linguistRulesState(input),
    keptFullDepth: [],
    estimatedTokensBefore: estimateTokens(files),
    estimatedTokensAfter: 0,
  };
  const parsed = files.map((file) => parsePatch(typeof file.patch === 'string' ? file.patch : ''));
  const linguist = input.linguist?.status === 'applied' ? parseLinguistAttributes(input.linguist.content) : null;

  // Moves the diff source did not pair: unique byte-identical delete/add pairs.
  const movedFrom = new Map<number, string>();
  const movedTo = new Map<number, string>();
  const bucket = (side: 'added' | 'deleted') => {
    const byContent = new Map<string, number[]>();
    files.forEach((file, index) => {
      if (!shrinkable(file, parsed[index])) return;
      const content = wholeFileContent(parsed[index], side);
      if (content === null) return;
      const key = `${fileMode(parsed[index])}\0${content.slice(1).replace(/\n[+-]/gu, '\n')}`;
      byContent.set(key, [...(byContent.get(key) ?? []), index]);
    });
    return byContent;
  };
  const added = bucket('added');
  const deleted = bucket('deleted');
  for (const [key, addedIndexes] of added) {
    const deletedIndexes = deleted.get(key);
    if (addedIndexes.length !== 1 || deletedIndexes?.length !== 1) continue;
    const [to, from] = [addedIndexes[0], deletedIndexes[0]];
    if (isSecuritySensitivePath(files[to].path) || isSecuritySensitivePath(files[from].path)) {
      disclosure.keptFullDepth.push({ path: files[to].path, rule: 'rename' }, { path: files[from].path, rule: 'rename' });
      continue;
    }
    movedFrom.set(to, files[from].path);
    movedTo.set(from, files[to].path);
  }

  const out = files.map((file, index): EffectiveReviewFile => {
    const patch = parsed[index];
    if (!shrinkable(file, patch)) return file;
    const sensitive = isSecuritySensitivePath(file.path);
    const replace = (body: string[]): EffectiveReviewFile => {
      const next = joinPatch(patch.header, body);
      const originalBytes = Buffer.byteLength(file.patch ?? '', 'utf8');
      return {
        ...file,
        patch: next,
        // The fast-ship size bar must see the original change, not the shrunk one.
        byteSize: Math.max(typeof file.byteSize === 'number' ? file.byteSize : 0, originalBytes),
      };
    };

    // Rule 3: base .gitattributes linguist exclusion.
    const attribute = linguist ? linguistExclusionFor(linguist, file.path) : null;
    if (attribute) {
      if (sensitive) {
        disclosure.keptFullDepth.push({ path: file.path, rule: 'linguist' });
      } else {
        disclosure.linguistExcluded.push({ path: file.path, attribute });
        const excluded = replace([
          `${NOTE_PREFIX} not sent (${attribute} in .gitattributes, ${changedLineCount(patch)} changed lines)`,
        ]);
        return { ...excluded, content: undefined };
      }
    }

    // Rule 2a: a delete/add pair with identical content.
    const pairedFrom = movedFrom.get(index);
    if (pairedFrom !== undefined) {
      disclosure.renames.push({
        from: pairedFrom, to: file.path, similarity: 100, kind: 'rename', detectedBy: 'content-match', contentSent: 'none',
      });
      return replace([`${NOTE_PREFIX} moved from ${pairedFrom} unchanged, not sent`]);
    }
    const pairedTo = movedTo.get(index);
    if (pairedTo !== undefined) {
      return replace([`${NOTE_PREFIX} moved to ${pairedTo} unchanged, not sent`]);
    }

    // Rule 2b: rename/copy reported by the diff header (git -M -C).
    const renamed = headerRename(patch.header);
    if (renamed) {
      if (sensitive || isSecuritySensitivePath(renamed.from)) {
        disclosure.keptFullDepth.push({ path: file.path, rule: 'rename' });
        return file;
      }
      const pure = patch.hunks.length === 0;
      disclosure.renames.push({ ...renamed, to: file.path, contentSent: pure ? 'none' : 'changed-hunks' });
      // A pure rename's patch is already only its `rename from`/`rename to`
      // header, and a modified one carries only its changed hunks (whitespace
      // collapse below may still apply to them). Nothing more to cut.
      if (pure) return file;
    }

    // Rule 1: whitespace-only hunks.
    if (isWhitespaceSignificantPath(file.path) || patch.hunks.length === 0) return file;
    const whitespaceOnly = patch.hunks.map((hunk) => isWhitespaceOnlyHunk(hunk.lines));
    if (!whitespaceOnly.some(Boolean)) return file;
    if (sensitive) {
      disclosure.keptFullDepth.push({ path: file.path, rule: 'whitespace' });
      return file;
    }
    if (whitespaceOnly.every(Boolean)) {
      disclosure.whitespaceOnlyFiles.push(file.path);
      return replace([`${NOTE_PREFIX} whitespace-only change, not sent`]);
    }
    const body: string[] = [];
    let collapsed = 0;
    patch.hunks.forEach((hunk, hunkIndex) => {
      if (whitespaceOnly[hunkIndex]) {
        collapsed += 1;
        body.push(`${NOTE_PREFIX} whitespace-only hunk ${hunkRange(hunk.header)} not sent`);
        return;
      }
      body.push(hunk.header, ...hunk.lines.filter((line, lineIndex, all) => !(line === '' && lineIndex === all.length - 1)));
    });
    disclosure.collapsedWhitespaceHunks.push({ path: file.path, hunks: collapsed });
    return replace(body);
  });

  disclosure.estimatedTokensAfter = estimateTokens(out);
  return { files: out, disclosure };
}

/**
 * The shared applicability decision plus diff shrinking, for every engine.
 *
 * Applicability is decided first, on the unshrunk files, by the same
 * `resolveReviewApplicability` the service's trusted completion context calls.
 * Shrinking then replaces only patch text in `effectiveFiles`: lanes, the
 * no-reviewable-content exemption and unmatched paths are returned untouched,
 * so the flag can never make the worker and the service disagree.
 */
export function resolveShrunkReviewApplicability<P extends Parameters<typeof resolveReviewApplicability>[0][number]>(
  enabledPersonas: readonly P[],
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  options: NonNullable<Parameters<typeof resolveReviewApplicability>[2]> & { diffShrink?: DiffShrinkInput } = {},
): ReviewApplicability<P> & { diffShrink: DiffShrinkDisclosure | null } {
  const { diffShrink, ...applicabilityOptions } = options;
  const decision = resolveReviewApplicability(enabledPersonas, changedFiles, applicabilityOptions);
  if (!diffShrink?.enabled || decision.applicable.length === 0) return { ...decision, diffShrink: null };
  const { files, disclosure } = planDiffShrink(decision.effectiveFiles, diffShrink);
  return { ...decision, effectiveFiles: files, diffShrink: disclosure };
}

/**
 * The disclosure for the check summary, computed from the same inputs and the
 * same projection the engines shrink (`buildEffectiveReviewFiles` +
 * `planDiffShrink`). Null when shrinking is off.
 */
export function describeDiffShrink(
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  options: { pathFilters?: readonly string[]; diffShrink?: DiffShrinkInput },
): DiffShrinkDisclosure | null {
  if (!options.diffShrink?.enabled) return null;
  const { files } = buildEffectiveReviewFiles(changedFiles, { pathFilters: options.pathFilters });
  return planDiffShrink(files, options.diffShrink).disclosure;
}

/**
 * `REVIEW_YETI_DIFF_SHRINK`: unset, empty, `0`, `false` or `off` is off (the
 * default); `1`, `true`, `on` or `all` is on for every repository; anything
 * else is a comma- or space-separated list of `owner/repo` names it is on for
 * (case-insensitive), so it can be enabled per repository first.
 */
export function diffShrinkEnabledFor(env: Readonly<Record<string, string | undefined>>, repository: string): boolean {
  const raw = String(env[DIFF_SHRINK_FLAG] ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'all') return true;
  const target = String(repository || '').trim().toLowerCase();
  return target.length > 0 && raw.split(/[\s,]+/u).some((entry) => entry === target);
}

const GITATTRIBUTES_READ_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/**
 * Worker-side input for the engines: the flag, and the root `.gitattributes`
 * linguist rules only when the pull request cannot have written them.
 *
 * - Any changed `.gitattributes` (root or nested) disables the rules: head
 *   content must equal the base content, or a PR could mark its own source
 *   generated and hide it.
 * - Nested `.gitattributes` files in the tree disable the rules: they can
 *   override the root file and are not read here.
 * - Every read failure disables the rules (fail open to today's review).
 */
export async function loadDiffShrinkInput(options: {
  env: Readonly<Record<string, string | undefined>>;
  repository: string;
  changedPaths: readonly string[];
  repoFileProvider?: Pick<RepoFileProvider, 'readFile' | 'findFiles' | 'treeTruncated'>;
  timeoutMs?: number;
}): Promise<DiffShrinkInput | undefined> {
  if (!diffShrinkEnabledFor(options.env, options.repository)) return undefined;
  const notApplied = (reason: string): DiffShrinkInput => ({ enabled: true, linguist: { status: 'not-applied', reason } });
  if (options.changedPaths.some((path) => (path.split('/').pop() || path) === '.gitattributes')) {
    return notApplied('this pull request changes a .gitattributes file');
  }
  const provider = options.repoFileProvider;
  if (!provider) return notApplied('repository files are not readable in this run');
  const readRules = async (): Promise<DiffShrinkInput> => {
    const content = await provider.readFile('.gitattributes');
    if (typeof content !== 'string' || !parseLinguistAttributes(content).hasExclusions) {
      return { enabled: true, linguist: { status: 'none-declared' } };
    }
    const found = await provider.findFiles('.gitattributes');
    if (!Array.isArray(found)) return notApplied('the repository tree could not be listed');
    if (found.some((path) => path !== '.gitattributes' && path.endsWith('/.gitattributes'))) {
      return notApplied('nested .gitattributes files are not supported');
    }
    if (provider.treeTruncated && await provider.treeTruncated()) {
      return notApplied('the repository tree listing was truncated');
    }
    return { enabled: true, linguist: { status: 'applied', content } };
  };
  try {
    // One deadline for every read, so a slow API cannot hold the review up for long.
    return await withTimeout(readRules(), options.timeoutMs ?? GITATTRIBUTES_READ_TIMEOUT_MS);
  } catch {
    return notApplied('the repository .gitattributes could not be read');
  }
}

const MAX_LISTED_PER_RULE = 15;

function code(path: string): string {
  return `\`${path.replace(/[`\r\n]/gu, ' ')}\``;
}

function listed<T>(items: readonly T[], render: (item: T) => string): string {
  const shown = items.slice(0, MAX_LISTED_PER_RULE).map(render).join(', ');
  const more = items.length - MAX_LISTED_PER_RULE;
  return more > 0 ? `${shown}, +${more} more` : shown;
}

/** Check-summary disclosure lines (plan section 3, invariant 5). Empty when shrinking is off. */
export function renderDiffShrinkSummary(disclosure: DiffShrinkDisclosure | null): string[] {
  if (!disclosure) return [];
  const lines: string[] = [
    `**Diff shrinking** (\`${DIFF_SHRINK_FLAG}\`): every changed file stays listed to its lanes; `
    + `~${disclosure.estimatedTokensBefore.toLocaleString('en-US')} -> ~${disclosure.estimatedTokensAfter.toLocaleString('en-US')} estimated diff tokens.`,
  ];
  if (disclosure.whitespaceOnlyFiles.length > 0) {
    lines.push(`- Whitespace-only, content not sent (${disclosure.whitespaceOnlyFiles.length}): ${listed(disclosure.whitespaceOnlyFiles, code)}`);
  }
  if (disclosure.collapsedWhitespaceHunks.length > 0) {
    const hunks = disclosure.collapsedWhitespaceHunks.reduce((sum, entry) => sum + entry.hunks, 0);
    lines.push(`- Whitespace-only hunks collapsed (${hunks} in ${disclosure.collapsedWhitespaceHunks.length} file(s)): `
      + listed(disclosure.collapsedWhitespaceHunks, (entry) => `${code(entry.path)} (${entry.hunks})`));
  }
  if (disclosure.renames.length > 0) {
    lines.push(`- Renamed, moved or copied (${disclosure.renames.length}): ${listed(disclosure.renames, (entry) => {
      const similarity = entry.similarity === null ? 'similarity unknown' : `similarity ${entry.similarity}%`;
      const sent = entry.contentSent === 'none' ? 'content unchanged, not sent' : 'only changed hunks sent';
      return `${code(entry.from)} -> ${code(entry.to)} (${entry.kind}, ${similarity}, ${sent})`;
    })}`);
  }
  if (disclosure.linguistExcluded.length > 0) {
    lines.push(`- Excluded by .gitattributes, content not sent (${disclosure.linguistExcluded.length}): `
      + listed(disclosure.linguistExcluded, (entry) => `${code(entry.path)} (${entry.attribute})`));
  }
  const rules = disclosure.linguistRules;
  if (typeof rules === 'object') {
    lines.push(`- .gitattributes linguist rules not applied: ${rules.notApplied}.`);
  }
  if (disclosure.keptFullDepth.length > 0) {
    lines.push(`- Security-sensitive, kept at full depth (${disclosure.keptFullDepth.length}): `
      + listed(disclosure.keptFullDepth, (entry) => `${code(entry.path)} (${entry.rule})`));
  }
  const touched = disclosure.whitespaceOnlyFiles.length + disclosure.collapsedWhitespaceHunks.length
    + disclosure.renames.length + disclosure.linguistExcluded.length;
  if (touched === 0) lines.push('- No file was shrunk; every change was sent in full.');
  return lines;
}
