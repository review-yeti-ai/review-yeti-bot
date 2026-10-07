import { describe, expect, it } from 'vitest';
import { isValidGroundedCitationV2, sha256Bytes } from '../../src/review/groundedEvidenceV2';
import { groundedDependencyContractId, selectGroundedCallerEdgeWindow, selectGroundedCandidateWindows,
  selectGroundedDependencyWindow, groundedWindowCitation } from '../../src/review/groundedSourceWindows';
import type { GroundedDependencyEdgeV1 } from '../../src/review/groundedEvidenceV2';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const repository = 'public-example/project';

function line(value: string): string {
  return `const value = '${value.padEnd(52, 'x')}';\n`;
}

function exactLargeSource(targetLine: number, targetValue: string): string {
  const lines = Array.from({ length: targetLine + 100 }, (_, index) => line(`line-${index}`));
  lines[targetLine - 1] = line(targetValue);
  let source = lines.join('');
  const targetBytes = 444_656;
  if (Buffer.byteLength(source, 'utf8') < targetBytes) {
    const padding = targetBytes - Buffer.byteLength(source, 'utf8');
    lines[lines.length - 1] = `${lines.at(-1)!.slice(0, -1)}${'x'.repeat(padding)}\n`;
    source = lines.join('');
  }
  return source;
}

describe('grounded source windows', () => {
  it('selects deterministic bounded evidence from a 444,656-byte source and binds the full bytes', () => {
    const candidateLine = 3_000;
    const oldLine = line('old-target');
    const newLine = line('new-target');
    const baseSource = exactLargeSource(candidateLine, 'old-target');
    const headSource = exactLargeSource(candidateLine, 'new-target');
    expect(Buffer.byteLength(headSource, 'utf8')).toBe(444_656);
    expect(Buffer.byteLength(baseSource, 'utf8')).toBe(444_656);

    const selected = selectGroundedCandidateWindows({ repository, path: 'src/large.ts', headSha, baseSha,
      candidateLine, patch: `@@ -${candidateLine} +${candidateLine} @@\n-${oldLine.slice(0, -1)}\n+${newLine.slice(0, -1)}\n`,
      headSource, baseSource });

    expect(selected.complete, JSON.stringify(selected)).toBe(true);
    if (!selected.complete) throw new Error(selected.reason);
    if (!selected.head || !selected.base) throw new Error('modified source must have head and base windows');
    expect(selected.head.window.fullContentSha256).toBe(sha256Bytes(Buffer.from(headSource)));
    expect(selected.base.window.fullContentSha256).toBe(sha256Bytes(Buffer.from(baseSource)));
    expect(selected.head.window.startLine).toBeLessThanOrEqual(candidateLine);
    expect(selected.head.window.endLine).toBeGreaterThanOrEqual(candidateLine);
    expect(selected.head.content).toContain(newLine);
    expect(Buffer.byteLength(selected.head.content, 'utf8')).toBeLessThanOrEqual(24_000);
    const repeated = selectGroundedCandidateWindows({ repository, path: 'src/large.ts', headSha, baseSha,
      candidateLine, patch: `@@ -${candidateLine} +${candidateLine} @@\n-${oldLine.slice(0, -1)}\n+${newLine.slice(0, -1)}\n`,
      headSource, baseSource });
    expect(repeated.complete && selected.complete && repeated.manifestDigest).toBe(selected.manifestDigest);
    if (!repeated.complete || !repeated.head) throw new Error('repeated modified source must retain its candidate window');
    expect(repeated.head.window.id).toBe(selected.head.window.id);
  });

  it('binds a candidate in the second of multiple hunks to that hunk and its base range', () => {
    const candidateLine = 90;
    const baseLines = Array.from({ length: 120 }, (_, index) => line(index === 89 ? 'old-target' : `base-${index}`));
    const headLines = [...baseLines];
    baseLines[1] = line('old-first');
    headLines[1] = line('new-first');
    headLines[89] = line('new-target');
    const baseSource = baseLines.join('');
    const headSource = headLines.join('');
    const patch = `@@ -2 +2 @@\n-${line('old-first').slice(0, -1)}\n+${line('new-first').slice(0, -1)}\n`
      + `@@ -90 +90 @@\n-${line('old-target').slice(0, -1)}\n+${line('new-target').slice(0, -1)}\n`;
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/multiple.ts', headSha, baseSha,
      candidateLine, patch, headSource, baseSource });

    expect(selected.complete, JSON.stringify(selected)).toBe(true);
    if (!selected.complete) throw new Error(selected.reason);
    if (!selected.head || !selected.base) throw new Error('multi-hunk source must have head and base windows');
    expect(selected.head.window.mapping).toMatchObject({ kind: 'changed-hunk', hunkOrdinal: 2, candidateLine });
    expect(selected.head.window.regionDigest).toBe(selected.base.window.regionDigest);
    expect(selected.base.window.startLine).toBeLessThanOrEqual(candidateLine);
    expect(selected.base.window.endLine).toBeGreaterThanOrEqual(candidateLine);
    expect(selected.head.content).toContain('new-target');
  });

  it('preserves CRLF and multibyte UTF-8 bytes in selected windows and hashes', () => {
    const baseSource = 'one 🧪\r\nold café\r\nthree\r\n';
    const headSource = 'one 🧪\r\nnew café\r\nthree\r\n';
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/utf8.ts', headSha, baseSha,
      candidateLine: 2, patch: '@@ -2 +2 @@\r\n-old café\r\n+new café\r\n', headSource, baseSource });

    expect(selected.complete, JSON.stringify(selected)).toBe(true);
    if (!selected.complete) throw new Error(selected.reason);
    if (!selected.head) throw new Error('UTF-8 candidate must have a head window');
    expect(selected.head.content).toBe(headSource);
    expect(selected.head.window.fullContentSha256).toBe(sha256Bytes(Buffer.from(headSource, 'utf8')));
    expect(selected.head.window.windowSha256).toBe(sha256Bytes(Buffer.from(selected.head.content, 'utf8')));
  });

  it('maps an insertion locally when the same unified hunk also deletes a different line', () => {
    const baseSource = 'alpha\nremoved\nbeta\ngamma\n';
    const headSource = 'alpha\nbeta\ngamma\ninserted\n';
    const patch = '@@ -1,4 +1,4 @@\n alpha\n-removed\n beta\n gamma\n+inserted\n';
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/mixed-hunk.ts', headSha, baseSha,
      candidateLine: 4, patch, headSource, baseSource });

    expect(selected.complete, JSON.stringify(selected)).toBe(true);
    if (!selected.complete) throw new Error(selected.reason);
    if (!selected.head || !selected.base) throw new Error('mixed hunk requires both exact source sides');
    expect(selected.mapping).toMatchObject({ relation: 'insertion-gap', oldLines: 4, newLines: 4,
      candidateSide: 'head', candidateLine: 4, beforeLine: 4, afterLine: 5 });
    expect(isValidGroundedCitationV2(groundedWindowCitation(selected.head))).toBe(true);
    expect(isValidGroundedCitationV2(groundedWindowCitation(selected.base))).toBe(true);
  });

  it('rejects a zero-length counterpart gap outside the fetched source before the whole-file shortcut', () => {
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/out-of-range.ts', headSha, baseSha,
      candidateLine: 1, patch: '@@ -99,0 +1 @@\n+new\n', headSource: 'new\n', baseSource: 'old\n' });
    expect(selected).toMatchObject({ complete: false, reason: 'counterpart_hunk_gap_outside_source' });
  });

  it('rejects a nonzero insertion cursor into a present-empty counterpart while retaining cursor zero', () => {
    const invalid = selectGroundedCandidateWindows({ repository, path: 'src/empty-cursor.ts', headSha, baseSha,
      candidateLine: 1, patch: '@@ -99,0 +1 @@\n+new\n', headSource: 'new\n', baseSource: '' });
    expect(invalid).toMatchObject({ complete: false, reason: 'counterpart_hunk_gap_outside_source' });
    const valid = selectGroundedCandidateWindows({ repository, path: 'src/empty-cursor.ts', headSha, baseSha,
      candidateLine: 1, patch: '@@ -0,0 +1 @@\n+new\n', headSource: 'new\n', baseSource: '' });
    expect(valid).toMatchObject({ complete: true, candidateSide: 'head', mapping: {
      kind: 'changed-hunk', relation: 'insertion-gap', beforeLine: null, afterLine: 1,
    } });
  });

  it('rejects ambiguous candidate-to-hunk mappings before evidence is emitted', () => {
    const patch = '@@ -1 +1 @@\n-old-a\n+new-a\n@@ -1 +1 @@\n-old-b\n+new-b\n';
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/ambiguous.ts', headSha, baseSha,
      candidateLine: 1, patch, headSource: 'new-b\n', baseSource: 'old-b\n' });

    expect(selected).toMatchObject({ complete: false, reason: 'ambiguous_candidate_mapping' });
  });

  it('rejects a source line that alone exceeds the existing per-side evidence cap', () => {
    const oversizedLine = `export const value = '${'x'.repeat(25_000)}';\n`;
    const patch = `@@ -1 +1 @@\n-old\n+${oversizedLine.slice(0, -1)}\n`;
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/long-line.ts', headSha, baseSha,
      candidateLine: 1, patch, headSource: oversizedLine, baseSource: 'old\n' });

    expect(selected).toMatchObject({ complete: false, reason: 'diff_exceeds_side_limit' });
  });

  it('keeps an authenticated absent side distinct from a present-source window', () => {
    const headSource = 'export const added = true;\n';
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/added.ts', headSha, baseSha,
      candidateLine: 1, patch: '@@ -0,0 +1 @@\n+export const added = true;\n', headSource, baseSource: null,
      absentSide: 'base', absenceDigest: 'c'.repeat(64) });

    expect(selected.complete, JSON.stringify(selected)).toBe(true);
    if (!selected.complete) throw new Error(selected.reason);
    if (!selected.head) throw new Error('added file must have a head window');
    expect(selected.head.window.mapping.kind).toBe('changed-hunk');
    expect(selected.base).toBeUndefined();
    expect(selected.absenceCitation).toMatchObject({ id: 'absence:base:src/added.ts', presence: 'absent',
      sourceDigest: 'c'.repeat(64) });
  });

  it('keeps an empty-but-present base file distinct from absence for an insertion', () => {
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/from-empty.ts', headSha, baseSha,
      candidateLine: 1, patch: '@@ -0,0 +1 @@\n+export const first = true;\n',
      headSource: 'export const first = true;\n', baseSource: '' });

    expect(selected.complete, JSON.stringify(selected)).toBe(true);
    if (!selected.complete) throw new Error(selected.reason);
    if (!selected.head || !selected.base) throw new Error('present empty source requires both side windows');
    expect(selected.base).toMatchObject({ content: '', window: { byteLength: 0, exhaustive: true,
      fullContentSha256: sha256Bytes(Buffer.from('')) } });
    expect(selected.absenceCitation).toBeUndefined();
    expect(selected.citations.find((citation) => citation.side === 'base')?.presence).toBeUndefined();
  });

  it('maps a deletion-only guard removal to exact old source and the current head gap', () => {
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/guard.ts', headSha, baseSha,
      candidateLine: 2, patch: '@@ -2 +1,0 @@\n-guard();\n',
      headSource: 'safe();\n', baseSource: 'safe();\nguard();\n' });

    expect(selected.complete, JSON.stringify(selected)).toBe(true);
    if (!selected.complete) throw new Error(selected.reason);
    if (!selected.base || !selected.head) throw new Error('deletion requires base candidate and head mapping windows');
    expect(selected.candidateSide).toBe('base');
    expect(selected.base?.window.role).toBe('candidate');
    expect(selected.base?.content).toBe('safe();\nguard();\n');
    expect(selected.head?.window.role).toBe('mapped-head');
    expect(selected.mapping).toMatchObject({ kind: 'changed-hunk', relation: 'deletion-gap', candidateSide: 'base' });
  });

  it('anchors insertion-at-EOF between the last old line and the exact new candidate line', () => {
    const selected = selectGroundedCandidateWindows({ repository, path: 'src/eof.ts', headSha, baseSha,
      candidateLine: 3, patch: '@@ -2,0 +3 @@\n+last();\n', headSource: 'first();\nsecond();\nlast();\n',
      baseSource: 'first();\nsecond();\n' });

    expect(selected.complete).toBe(true);
    if (!selected.complete) throw new Error(selected.reason);
    if (!selected.head || !selected.base) throw new Error('EOF insertion requires both source sides');
    expect(selected.mapping).toMatchObject({ relation: 'insertion-gap', beforeLine: 2, afterLine: 3,
      candidateSide: 'head', candidateLine: 3 });
    expect(selected.base?.window.startLine).toBe(1);
    expect(selected.base?.window.endLine).toBe(2);
  });

  it('selects a complete imported export definition from a large helper file and binds its caller edge', () => {
    const importStatement = "import { safeHelper } from './helper';\n";
    const helperDefinition = 'export function safeHelper(input: string) { return input.trim(); }\n';
    const importerPath = 'src/caller.ts';
    const contractPath = 'src/helper.ts';
    const importerSource = importStatement + Array.from({ length: 1_000 }, (_, index) => `const row${index} = '${'x'.repeat(40)}';\n`).join('');
    const contractLines = Array.from({ length: 1_000 }, (_, index) => `const helperRow${index} = '${'y'.repeat(40)}';\n`);
    contractLines[500] = helperDefinition;
    const contractSource = contractLines.join('');
    const definitionLine = 501;
    const lineDigest = (source: string, line: number) => {
      const lines = source.split(/(?<=\n)/u);
      return sha256Bytes(Buffer.from(lines[line - 1], 'utf8'));
    };
    const edgeMaterial = {
      resolver: 'relative-import-v1' as const,
      importerPath,
      importerSide: 'head' as const,
      importerFullContentSha256: sha256Bytes(Buffer.from(importerSource, 'utf8')),
      importerStatementStartLine: 1,
      importerStatementEndLine: 1,
      importSpecifier: './helper',
      contractSymbols: ['safeHelper'],
      resolvedPath: contractPath,
      contractFullContentSha256: sha256Bytes(Buffer.from(contractSource, 'utf8')),
      definitionStartLine: definitionLine,
      definitionEndLine: definitionLine,
      definitionSha256: lineDigest(contractSource, definitionLine),
      importStatementDigest: lineDigest(importerSource, 1),
      originRegionDigest: 'c'.repeat(64),
    };
    const edge: GroundedDependencyEdgeV1 = { ...edgeMaterial, contractId: groundedDependencyContractId(edgeMaterial) };
    const callerWindow = selectGroundedCallerEdgeWindow({ repository, path: importerPath, side: 'head', revisionSha: headSha,
      headSha, baseSha, source: importerSource, edge });
    const contractWindow = selectGroundedDependencyWindow({ repository, path: contractPath, side: 'head',
      revisionSha: headSha, headSha, baseSha, source: contractSource, edge });

    expect(Buffer.byteLength(contractSource, 'utf8')).toBeGreaterThan(24_000);
    expect(callerWindow?.content).toContain(importStatement);
    expect(callerWindow?.window.role).toBe('dependency-caller');
    expect(contractWindow?.content).toContain(helperDefinition);
    expect(contractWindow?.window.role).toBe('dependency-contract');
    expect(contractWindow?.window.fullContentSha256).toBe(edge.contractFullContentSha256);
    expect(Buffer.byteLength(contractWindow!.content, 'utf8')).toBeLessThanOrEqual(24_000);
    expect(contractWindow?.window.mapping).toMatchObject({ kind: 'dependency-contract', edge });
  });

  it('rejects a relevant exported definition that exceeds the source-side evidence cap', () => {
    const source = Array.from({ length: 3_000 }, (_, index) => `const row${index} = '${'y'.repeat(40)}';\n`);
    source[1_000] = `export function huge() {\n${'x'.repeat(25_000)}\n}\n`;
    const full = source.join('');
    const importLine = "import { huge } from './helper';\n";
    const edgeMaterial = {
      resolver: 'relative-import-v1' as const, importerPath: 'src/caller.ts', importerSide: 'head' as const,
      importerFullContentSha256: sha256Bytes(Buffer.from(importLine, 'utf8')), importerStatementStartLine: 1,
      importerStatementEndLine: 1, importSpecifier: './helper', contractSymbols: ['huge'], resolvedPath: 'src/helper.ts',
      contractFullContentSha256: sha256Bytes(Buffer.from(full, 'utf8')), definitionStartLine: 1001,
      definitionEndLine: 1003, definitionSha256: sha256Bytes(Buffer.from(source[1_000]!, 'utf8')),
      importStatementDigest: sha256Bytes(Buffer.from(importLine, 'utf8')), originRegionDigest: 'd'.repeat(64),
    };
    const edge: GroundedDependencyEdgeV1 = { ...edgeMaterial, contractId: groundedDependencyContractId(edgeMaterial) };
    expect(selectGroundedDependencyWindow({ repository, path: edge.resolvedPath, side: 'head', revisionSha: headSha,
      headSha, baseSha, source: full, edge })).toBeNull();
  });
});
