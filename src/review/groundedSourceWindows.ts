import { canonicalJson, sha256 } from './reviewCore';
import { groundedCitationManifestDigest, groundedSourceWindowId, GROUNDED_SOURCE_WINDOW_VERSION,
  sha256Bytes, type GroundedCitationV2, type GroundedDependencyEdgeV1, type GroundedSourceWindowV1,
  type GroundedWindowMappingV1 } from './groundedEvidenceV2';

export const GROUNDED_SOURCE_SIDE_BYTE_LIMIT = 24_000;
export const GROUNDED_SOURCE_WINDOW_CONTEXT_LINES = 40;

interface UnifiedHunkRecord {
  kind: 'context' | 'added' | 'deleted';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

interface UnifiedHunk {
  ordinal: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  records: UnifiedHunkRecord[];
  added: Array<{ line: number; oldCursor: number; recordIndex: number }>;
  deleted: Array<{ line: number; newCursor: number; recordIndex: number }>;
  regionDigest: string;
}

interface ByteLine {
  start: number;
  end: number;
}

export interface SelectedGroundedSourceWindow {
  window: GroundedSourceWindowV1;
  content: string;
}

export interface GroundedCandidateWindowSelection {
  complete: true;
  candidateSide: 'head' | 'base';
  hunkDigest: string;
  mapping: GroundedWindowMappingV1;
  head?: SelectedGroundedSourceWindow;
  base?: SelectedGroundedSourceWindow;
  absenceCitation?: GroundedCitationV2;
  citations: GroundedCitationV2[];
  manifestDigest: string;
}

export interface GroundedCandidateWindowFailure {
  complete: false;
  reason: string;
}

export type GroundedCandidateWindowResult = GroundedCandidateWindowSelection | GroundedCandidateWindowFailure;

function parseUnifiedHunks(patch: string): { hunks: UnifiedHunk[]; error?: string } {
  const lines = patch.split(/\r\n|\r|\n/u);
  const patchDigest = sha256Bytes(Buffer.from(patch, 'utf8'));
  const hunks: UnifiedHunk[] = [];
  let current: Omit<UnifiedHunk, 'regionDigest'> | undefined;
  let oldCursor = 0;
  let newCursor = 0;
  let oldSeen = 0;
  let newSeen = 0;

  const finish = (): string | undefined => {
    if (!current) return undefined;
    if (oldSeen !== current.oldLines || newSeen !== current.newLines) return 'malformed_hunk_counts';
    const material = {
      patchDigest, ordinal: current.ordinal, header: current.header,
      oldStart: current.oldStart, oldLines: current.oldLines,
      newStart: current.newStart, newLines: current.newLines,
      records: current.records,
    };
    hunks.push({ ...current, regionDigest: sha256(canonicalJson(material)) });
    current = undefined;
    return undefined;
  };

  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (match) {
      const finishError = finish();
      if (finishError) return { hunks: [], error: finishError };
      const oldStart = Number(match[1]);
      const oldLines = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newLines = match[4] === undefined ? 1 : Number(match[4]);
      if (![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger)
        || oldStart < 0 || newStart < 0 || oldLines < 0 || newLines < 0
        || (oldLines > 0 && oldStart < 1) || (newLines > 0 && newStart < 1)) {
        return { hunks: [], error: 'malformed_hunk_header' };
      }
      current = { ordinal: hunks.length + 1, header: line, oldStart, oldLines, newStart, newLines,
        records: [], added: [], deleted: [] };
      oldCursor = oldStart;
      newCursor = newStart;
      oldSeen = 0;
      newSeen = 0;
      continue;
    }
    if (current && oldSeen === current.oldLines && newSeen === current.newLines
      && (line.startsWith('diff --git ') || line.startsWith('index ')
        || /^--- [ab]\//u.test(line) || /^\+\+\+ [ab]\//u.test(line))) {
      const finishError = finish();
      if (finishError) return { hunks: [], error: finishError };
      continue;
    }
    if (!current || line === '' || line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith(' ')) {
      current.records.push({ kind: 'context', text: line.slice(1), oldLine: oldCursor, newLine: newCursor });
      oldCursor += 1; newCursor += 1; oldSeen += 1; newSeen += 1;
    } else if (line.startsWith('+')) {
      const recordIndex = current.records.length;
      current.records.push({ kind: 'added', text: line.slice(1), oldLine: null, newLine: newCursor });
      current.added.push({ line: newCursor, oldCursor, recordIndex });
      newCursor += 1; newSeen += 1;
    } else if (line.startsWith('-')) {
      const recordIndex = current.records.length;
      current.records.push({ kind: 'deleted', text: line.slice(1), oldLine: oldCursor, newLine: null });
      current.deleted.push({ line: oldCursor, newCursor, recordIndex });
      oldCursor += 1; oldSeen += 1;
    } else {
      return { hunks: [], error: 'malformed_hunk_body' };
    }
  }
  const finishError = finish();
  return finishError ? { hunks: [], error: finishError } : { hunks };
}

export function groundedPatchRegionDigest(patch: string): string | null {
  const parsed = parseUnifiedHunks(patch);
  if (parsed.error || parsed.hunks.length === 0) return null;
  return sha256(canonicalJson(parsed.hunks.map((hunk) => hunk.regionDigest)));
}

function sourceLines(source: string): { bytes: Buffer; lines: ByteLine[] } {
  const bytes = Buffer.from(source, 'utf8');
  const lines: ByteLine[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x0a || (byte === 0x0d && bytes[index + 1] !== 0x0a)) {
      lines.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < bytes.length) lines.push({ start, end: bytes.length });
  return { bytes, lines };
}

function lineContent(bytes: Buffer, line: ByteLine): string {
  let end = line.end;
  if (bytes[end - 1] === 0x0a) end -= 1;
  if (bytes[end - 1] === 0x0d) end -= 1;
  return bytes.subarray(line.start, end).toString('utf8');
}

function verifyHunkMatchesSources(hunk: UnifiedHunk, headSource: string | null, baseSource: string | null,
  absentSide?: 'head' | 'base'): boolean {
  const head = headSource === null ? null : sourceLines(headSource);
  const base = baseSource === null ? null : sourceLines(baseSource);
  for (const record of hunk.records) {
    if (record.oldLine !== null && absentSide !== 'base') {
      const line = base?.lines[record.oldLine - 1];
      if (!base || !line || lineContent(base.bytes, line) !== record.text) return false;
    }
    if (record.newLine !== null && absentSide !== 'head') {
      const line = head?.lines[record.newLine - 1];
      if (!head || !line || lineContent(head.bytes, line) !== record.text) return false;
    }
  }
  return true;
}

function boundedWindowRange(lineCount: number, fullBytes: number, startLine: number, endLine: number,
  bytes: Buffer, lines: ByteLine[], options: { contextLines?: number; wholeFileWhenBounded?: boolean } = {})
  : { startLine: number; endLine: number; content: string; exhaustive: boolean } | null {
  const emptySourceRange = lineCount === 0 && startLine === 1 && endLine === 0;
  if (emptySourceRange) {
    return { startLine: 1, endLine: 0, content: '', exhaustive: true };
  }
  if (startLine < 1 || endLine < startLine || endLine > lineCount) return null;
  if (fullBytes <= GROUNDED_SOURCE_SIDE_BYTE_LIMIT && options.wholeFileWhenBounded !== false) {
    return { startLine: 1, endLine: lineCount, content: bytes.toString('utf8'), exhaustive: true };
  }
  const requiredStart = lines[startLine - 1].start;
  const requiredEnd = lines[endLine - 1].end;
  if (requiredEnd - requiredStart > GROUNDED_SOURCE_SIDE_BYTE_LIMIT) return null;
  const maxContext = options.contextLines ?? GROUNDED_SOURCE_WINDOW_CONTEXT_LINES;
  for (let radius = maxContext; radius >= 0; radius -= 1) {
    const from = Math.max(1, startLine - radius);
    const through = Math.min(lineCount, endLine + radius);
    const byteStart = lines[from - 1].start;
    const byteEnd = lines[through - 1].end;
    if (byteEnd - byteStart <= GROUNDED_SOURCE_SIDE_BYTE_LIMIT) {
      return { startLine: from, endLine: through,
        content: bytes.subarray(byteStart, byteEnd).toString('utf8'), exhaustive: false };
    }
  }
  return null;
}

function createWindow(input: {
  repository: string;
  path: string;
  side: 'head' | 'base';
  revisionSha: string;
  headSha: string;
  baseSha: string;
  source: string;
  startLine: number;
  endLine: number;
  regionDigest: string;
  role: GroundedSourceWindowV1['role'];
  mapping: GroundedWindowMappingV1;
  contextLines?: number;
  wholeFileWhenBounded?: boolean;
}): SelectedGroundedSourceWindow | null {
  const source = sourceLines(input.source);
  const selected = boundedWindowRange(source.lines.length, source.bytes.length,
    input.startLine, input.endLine, source.bytes, source.lines,
    { contextLines: input.contextLines, wholeFileWhenBounded: input.wholeFileWhenBounded });
  if (!selected) return null;
  const material = {
    version: GROUNDED_SOURCE_WINDOW_VERSION,
    repository: input.repository,
    path: input.path,
    side: input.side,
    role: input.role,
    revisionSha: input.revisionSha,
    headSha: input.headSha,
    baseSha: input.baseSha,
    fullContentSha256: sha256Bytes(source.bytes),
    startLine: selected.startLine,
    endLine: selected.endLine,
    windowSha256: sha256Bytes(Buffer.from(selected.content, 'utf8')),
    byteLength: Buffer.byteLength(selected.content, 'utf8'),
    regionDigest: input.regionDigest,
    mapping: input.mapping,
    exhaustive: selected.exhaustive,
  };
  const id = groundedSourceWindowId(material);
  return { window: { ...material, id }, content: selected.content };
}

export function groundedWindowCitation(selection: SelectedGroundedSourceWindow): GroundedCitationV2 {
  const window = selection.window;
  return { id: `window:${window.id}`, path: window.path, repository: window.repository, side: window.side,
    revisionSha: window.revisionSha, headSha: window.headSha, baseSha: window.baseSha,
    sourceDigest: window.windowSha256, regionDigest: window.regionDigest, window };
}

export function groundedDiffCitation(input: { path: string; repository: string; headSha: string; baseSha: string;
  patch: string; regionDigest: string }): GroundedCitationV2 {
  return { id: `diff:${input.path}:${input.regionDigest}`, path: input.path, repository: input.repository,
    side: 'diff', revisionSha: input.headSha, headSha: input.headSha, baseSha: input.baseSha,
    sourceDigest: sha256Bytes(Buffer.from(input.patch, 'utf8')), regionDigest: input.regionDigest };
}

export function groundedAbsenceCitation(input: { path: string; repository: string; side: 'head' | 'base'; headSha: string;
  baseSha: string; sourceDigest: string }): GroundedCitationV2 {
  const revisionSha = input.side === 'head' ? input.headSha : input.baseSha;
  return { id: `absence:${input.side}:${input.path}`, path: input.path, repository: input.repository,
    side: input.side, revisionSha, headSha: input.headSha, baseSha: input.baseSha,
    sourceDigest: input.sourceDigest, presence: 'absent' };
}

function hunkMapping(input: { hunk: UnifiedHunk; candidateSide: 'head' | 'base'; candidateLine: number;
  insertionCursor: number; recordIndex: number }): GroundedWindowMappingV1 {
  const { hunk, candidateSide } = input;
  let blockStart = input.recordIndex;
  let blockEnd = input.recordIndex;
  while (blockStart > 0 && hunk.records[blockStart - 1]?.kind !== 'context') blockStart -= 1;
  while (blockEnd + 1 < hunk.records.length && hunk.records[blockEnd + 1]?.kind !== 'context') blockEnd += 1;
  const addedInBlock = hunk.added.filter((line) => line.recordIndex >= blockStart && line.recordIndex <= blockEnd);
  const deletedInBlock = hunk.deleted.filter((line) => line.recordIndex >= blockStart && line.recordIndex <= blockEnd);
  const isReplacement = addedInBlock.length > 0 && deletedInBlock.length > 0;
  if (isReplacement) {
    const counterpartLines = candidateSide === 'head'
      ? deletedInBlock.map((line) => line.line) : addedInBlock.map((line) => line.line);
    const counterpartStartLine = Math.min(...counterpartLines);
    return { kind: 'changed-hunk', candidateSide, candidateLine: input.candidateLine,
      hunkOrdinal: hunk.ordinal, oldStart: hunk.oldStart, oldLines: hunk.oldLines,
      newStart: hunk.newStart, newLines: hunk.newLines, relation: 'replaced-region',
      counterpartStartLine,
      counterpartEndLine: Math.max(...counterpartLines),
      beforeLine: null, afterLine: null };
  }
  const counterpartCursor = input.insertionCursor;
  const counterpartHunkLines = candidateSide === 'head' ? hunk.oldLines : hunk.newLines;
  const isZeroLengthCounterpart = counterpartHunkLines === 0;
  const beforeLine = isZeroLengthCounterpart
    ? counterpartCursor > 0 ? counterpartCursor : null
    : counterpartCursor > 1 ? counterpartCursor - 1 : null;
  const afterLine = isZeroLengthCounterpart ? counterpartCursor + 1 : counterpartCursor;
  const relation = candidateSide === 'head' ? 'insertion-gap' : 'deletion-gap';
  return { kind: 'changed-hunk', candidateSide, candidateLine: input.candidateLine,
    hunkOrdinal: hunk.ordinal, oldStart: hunk.oldStart, oldLines: hunk.oldLines,
    newStart: hunk.newStart, newLines: hunk.newLines, relation,
    counterpartStartLine: null,
    counterpartEndLine: null,
    beforeLine, afterLine };
}

export function groundedCandidateHunkProof(input: { patch: string; candidateLine: number; candidateSide: 'head' | 'base' }):
  { regionDigest: string; mapping: GroundedWindowMappingV1 } | null {
  if (Buffer.byteLength(input.patch, 'utf8') > GROUNDED_SOURCE_SIDE_BYTE_LIMIT) return null;
  const parsed = parseUnifiedHunks(input.patch);
  if (parsed.error) return null;
  const matches = parsed.hunks.flatMap((hunk) => (input.candidateSide === 'head' ? hunk.added : hunk.deleted)
    .filter((line) => line.line === input.candidateLine).map((line) => ({ hunk, line })));
  if (matches.length !== 1) return null;
  const { hunk, line } = matches[0];
  const cursor = input.candidateSide === 'head'
    ? ('oldCursor' in line ? line.oldCursor : undefined)
    : ('newCursor' in line ? line.newCursor : undefined);
  if (cursor === undefined) return null;
  return { regionDigest: hunk.regionDigest,
    mapping: hunkMapping({ hunk, candidateSide: input.candidateSide, candidateLine: input.candidateLine,
      insertionCursor: cursor, recordIndex: 'recordIndex' in line ? line.recordIndex : -1 }) };
}

function counterpartRange(mapping: GroundedWindowMappingV1, lineCount: number): { start: number; end: number } {
  if (mapping.kind !== 'changed-hunk') return { start: 1, end: 0 };
  if (mapping.counterpartStartLine !== null && mapping.counterpartEndLine !== null) {
    return { start: mapping.counterpartStartLine, end: mapping.counterpartEndLine };
  }
  const neighbors = [mapping.beforeLine, mapping.afterLine].filter((line): line is number => line !== null
    && line >= 1 && line <= lineCount);
  return neighbors.length ? { start: Math.min(...neighbors), end: Math.max(...neighbors) } : { start: 1, end: 0 };
}

export function selectGroundedCandidateWindows(input: {
  repository: string;
  path: string;
  headSha: string;
  baseSha: string;
  candidateLine: number;
  patch: string;
  headSource: string | null;
  baseSource: string | null;
  absentSide?: 'head' | 'base';
  absenceDigest?: string;
}): GroundedCandidateWindowResult {
  if (!/^[0-9a-f]{40}$/u.test(input.headSha) || !/^[0-9a-f]{40}$/u.test(input.baseSha)
    || !input.repository.includes('/') || !input.path || !Number.isSafeInteger(input.candidateLine) || input.candidateLine < 1) {
    return { complete: false, reason: 'source_window_identity_invalid' };
  }
  if (Buffer.byteLength(input.patch, 'utf8') > GROUNDED_SOURCE_SIDE_BYTE_LIMIT) {
    return { complete: false, reason: 'diff_exceeds_side_limit' };
  }
  if (input.absentSide && (!/^[a-f0-9]{64}$/u.test(input.absenceDigest ?? '')
    || (input.absentSide === 'head' ? input.headSource !== null : input.baseSource !== null))) {
    return { complete: false, reason: 'source_absence_proof_invalid' };
  }
  if (!input.absentSide && (input.headSource === null || input.baseSource === null)) {
    return { complete: false, reason: 'expected_source_unavailable' };
  }

  const parsed = parseUnifiedHunks(input.patch);
  if (parsed.error || parsed.hunks.length === 0) return { complete: false, reason: parsed.error ?? 'patch_has_no_hunks' };
  const addedMatches = parsed.hunks.flatMap((hunk) => hunk.added.filter((line) => line.line === input.candidateLine)
    .map((line) => ({ hunk, line, side: 'head' as const })));
  const deletedMatches = parsed.hunks.flatMap((hunk) => hunk.deleted.filter((line) => line.line === input.candidateLine)
    .map((line) => ({ hunk, line, side: 'base' as const })));
  let match: { hunk: UnifiedHunk; line: { line: number; oldCursor?: number; newCursor?: number; recordIndex: number };
    side: 'head' | 'base' } | undefined;
  if (input.absentSide === 'base') {
    if (addedMatches.length !== 1) return { complete: false, reason: addedMatches.length ? 'ambiguous_candidate_mapping' : 'candidate_line_not_added' };
    match = addedMatches[0];
  } else if (input.absentSide === 'head') {
    if (deletedMatches.length !== 1) return { complete: false, reason: deletedMatches.length ? 'ambiguous_candidate_mapping' : 'candidate_line_not_deleted' };
    match = deletedMatches[0];
  } else if (addedMatches.length === 1) match = addedMatches[0];
  else if (addedMatches.length > 1) return { complete: false, reason: 'ambiguous_candidate_mapping' };
  else if (deletedMatches.length === 1) match = deletedMatches[0];
  else return { complete: false, reason: deletedMatches.length ? 'ambiguous_candidate_mapping' : 'candidate_line_not_changed' };

  const hunk = match.hunk;
  if (input.absentSide === 'base' && hunk.oldLines !== 0
    || input.absentSide === 'head' && hunk.newLines !== 0
    || !verifyHunkMatchesSources(hunk, input.headSource, input.baseSource, input.absentSide)) {
    return { complete: false, reason: 'source_diff_content_mismatch' };
  }

  const candidateSide = match.side;
  const cursor = candidateSide === 'head' ? match.line.oldCursor! : match.line.newCursor!;
  const mapping = hunkMapping({ hunk, candidateSide, candidateLine: input.candidateLine, insertionCursor: cursor,
    recordIndex: match.line.recordIndex });
  const hunkDigest = hunk.regionDigest;
  const candidateSource = candidateSide === 'head' ? input.headSource : input.baseSource;
  if (candidateSource === null) return { complete: false, reason: 'candidate_source_unavailable' };
  const counterpartSide = candidateSide === 'head' ? 'base' : 'head';
  const counterpartSource = counterpartSide === 'head' ? input.headSource : input.baseSource;
  if (counterpartSource === null && input.absentSide !== counterpartSide) {
    return { complete: false, reason: 'mapped_source_unavailable' };
  }
  const counterpartLineCount = counterpartSource === null ? 0 : sourceLines(counterpartSource).lines.length;
  const zeroLengthCounterpart = candidateSide === 'head' ? hunk.oldLines === 0 : hunk.newLines === 0;
  if (zeroLengthCounterpart && cursor > counterpartLineCount) {
    return { complete: false, reason: 'counterpart_hunk_gap_outside_source' };
  }
  const candidateLines = sourceLines(candidateSource);
  if (input.candidateLine > candidateLines.lines.length) return { complete: false, reason: 'candidate_line_outside_source' };
  const candidateSelection = createWindow({ repository: input.repository, path: input.path, side: candidateSide,
    revisionSha: candidateSide === 'head' ? input.headSha : input.baseSha,
    headSha: input.headSha, baseSha: input.baseSha, source: candidateSource,
    startLine: input.candidateLine, endLine: input.candidateLine, regionDigest: hunkDigest, role: 'candidate', mapping });
  if (!candidateSelection) return { complete: false, reason: 'source_window_exceeds_side_limit' };

  const headSelection = candidateSide === 'head' ? candidateSelection : undefined;
  const baseSelection = candidateSide === 'base' ? candidateSelection : undefined;
  let head = headSelection;
  let base = baseSelection;
  if (counterpartSource !== null) {
    const counterpartInfo = sourceLines(counterpartSource);
    const range = counterpartRange(mapping, counterpartInfo.lines.length);
    if (range.start === 1 && range.end === 0 && counterpartInfo.lines.length > 0) {
      return { complete: false, reason: 'counterpart_hunk_gap_outside_source' };
    }
    const role = counterpartSide === 'base' ? 'mapped-base' : 'mapped-head';
    const selected = createWindow({ repository: input.repository, path: input.path, side: counterpartSide,
      revisionSha: counterpartSide === 'head' ? input.headSha : input.baseSha,
      headSha: input.headSha, baseSha: input.baseSha, source: counterpartSource,
      startLine: range.start, endLine: range.end, regionDigest: hunkDigest, role, mapping });
    if (!selected) return { complete: false, reason: 'source_window_exceeds_side_limit' };
    if (counterpartSide === 'head') head = selected;
    else base = selected;
  }

  let absenceCitation: GroundedCitationV2 | undefined;
  if (input.absentSide) {
    absenceCitation = groundedAbsenceCitation({ path: input.path, repository: input.repository, side: input.absentSide,
      headSha: input.headSha, baseSha: input.baseSha, sourceDigest: input.absenceDigest! });
  }
  const candidateCitation = groundedWindowCitation(candidateSelection);
  const counterpartCitation = counterpartSide === 'head' ? (head ? groundedWindowCitation(head) : undefined)
    : (base ? groundedWindowCitation(base) : undefined);
  const diff = groundedDiffCitation({ path: input.path, repository: input.repository, headSha: input.headSha,
    baseSha: input.baseSha, patch: input.patch, regionDigest: hunkDigest });
  const citations = [candidateCitation, ...(counterpartCitation ? [counterpartCitation] : []),
    ...(absenceCitation ? [absenceCitation] : []), diff].sort((left, right) => left.id.localeCompare(right.id));
  return { complete: true, candidateSide, hunkDigest, mapping, ...(head ? { head } : {}), ...(base ? { base } : {}),
    ...(absenceCitation ? { absenceCitation } : {}), citations, manifestDigest: groundedCitationManifestDigest(citations) };
}

/**
 * Imported contracts are windowed only when their complete content fits the existing side cap.
 * Without a syntax-aware declaration resolver, a partial dependency excerpt is not evidence of
 * the imported contract.
 */
export function groundedDependencyContractId(edge: Omit<GroundedDependencyEdgeV1, 'contractId'>): string {
  return sha256(canonicalJson(edge));
}

export function groundedSourceTextLineRangeDigest(source: string, startLine: number, endLine: number): string | null {
  const indexed = sourceLines(source);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1
    || endLine < startLine || endLine > indexed.lines.length) return null;
  return sha256Bytes(indexed.bytes.subarray(indexed.lines[startLine - 1].start, indexed.lines[endLine - 1].end));
}

export function groundedSourceContainsLines(window: GroundedSourceWindowV1, startLine: number, endLine: number): boolean {
  return Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine)
    && startLine >= window.startLine && endLine <= window.endLine && endLine >= startLine;
}

export function selectGroundedCallerEdgeWindow(input: {
  repository: string;
  path: string;
  side: 'head' | 'base';
  revisionSha: string;
  headSha: string;
  baseSha: string;
  source: string;
  edge: GroundedDependencyEdgeV1;
}): SelectedGroundedSourceWindow | null {
  const { edge } = input;
  const { contractId, ...material } = edge;
  const sourceDigest = sha256Bytes(Buffer.from(input.source, 'utf8'));
  if (edge.importerPath !== input.path || edge.importerSide !== input.side
    || edge.importerFullContentSha256 !== sourceDigest
    || contractId !== groundedDependencyContractId(material)
    || groundedSourceTextLineRangeDigest(input.source, edge.importerStatementStartLine, edge.importerStatementEndLine) !== edge.importStatementDigest) {
    return null;
  }
  const mapping: GroundedWindowMappingV1 = { kind: 'dependency-contract', exhaustive: true, edge };
  return createWindow({ repository: input.repository, path: input.path, side: input.side,
    revisionSha: input.revisionSha, headSha: input.headSha, baseSha: input.baseSha, source: input.source,
    startLine: edge.importerStatementStartLine, endLine: edge.importerStatementEndLine,
    regionDigest: edge.contractId, role: 'dependency-caller', mapping, contextLines: 2,
    wholeFileWhenBounded: false });
}

export function selectGroundedDependencyWindow(input: {
  repository: string;
  path: string;
  side: 'head' | 'base';
  revisionSha: string;
  headSha: string;
  baseSha: string;
  source: string;
  edge: GroundedDependencyEdgeV1;
}): SelectedGroundedSourceWindow | null {
  const { edge } = input;
  const { contractId, ...material } = edge;
  if (edge.resolvedPath !== input.path || contractId !== groundedDependencyContractId(material)
    || edge.contractFullContentSha256 !== sha256Bytes(Buffer.from(input.source, 'utf8'))
    || groundedSourceTextLineRangeDigest(input.source, edge.definitionStartLine, edge.definitionEndLine) !== edge.definitionSha256
    || !/^[a-f0-9]{64}$/u.test(edge.originRegionDigest)
    || !/^[a-f0-9]{64}$/u.test(edge.importerFullContentSha256)
    || !/^[a-f0-9]{64}$/u.test(edge.importStatementDigest)) return null;
  const mapping: GroundedWindowMappingV1 = { kind: 'dependency-contract', exhaustive: true, edge };
  return createWindow({ repository: input.repository, path: input.path, side: input.side,
    revisionSha: input.revisionSha, headSha: input.headSha, baseSha: input.baseSha, source: input.source,
    startLine: edge.definitionStartLine, endLine: edge.definitionEndLine, regionDigest: edge.contractId,
    role: 'dependency-contract', mapping, contextLines: 4, wholeFileWhenBounded: false });
}

export function groundedSourceLineDigest(selection: SelectedGroundedSourceWindow, startLine: number, endLine: number): string | null {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < selection.window.startLine
    || endLine > selection.window.endLine || endLine < startLine) return null;
  const source = sourceLines(selection.content);
  const localStart = startLine - selection.window.startLine + 1;
  const localEnd = endLine - selection.window.startLine + 1;
  if (localStart < 1 || localEnd > source.lines.length) return null;
  const byteStart = source.lines[localStart - 1].start;
  const byteEnd = source.lines[localEnd - 1].end;
  return sha256Bytes(source.bytes.subarray(byteStart, byteEnd));
}
