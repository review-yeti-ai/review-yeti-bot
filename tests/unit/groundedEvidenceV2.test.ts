import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { groundedCitationManifestDigest, isValidGroundedCitationV2, groundedSourceWindowId,
  type GroundedCitationV2 } from '../../src/review/groundedEvidenceV2';

function windowCitation(id: string, mappingLine = 42): GroundedCitationV2 {
  const window = {
    version: 'GroundedSourceWindow.v1' as const,
    id,
    repository: 'public-example/project',
    path: 'src/handler.ts',
    side: 'head' as const,
    role: 'candidate' as const,
    revisionSha: 'a'.repeat(40),
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    fullContentSha256: 'c'.repeat(64),
    startLine: 32,
    endLine: 52,
    windowSha256: 'd'.repeat(64),
    byteLength: 800,
    regionDigest: 'e'.repeat(64),
    mapping: {
      kind: 'changed-hunk' as const,
      candidateSide: 'head' as const,
      candidateLine: mappingLine,
      hunkOrdinal: 1,
      oldStart: 42,
      oldLines: 1,
      newStart: 42,
      newLines: 1,
      relation: 'replaced-region' as const,
      counterpartStartLine: 42,
      counterpartEndLine: 42,
      beforeLine: null,
      afterLine: null,
    },
    exhaustive: false,
  };
  return { id: `window:${id}`, path: window.path, repository: window.repository, side: 'head',
    revisionSha: window.revisionSha, headSha: window.headSha, baseSha: window.baseSha,
    sourceDigest: window.windowSha256, regionDigest: window.regionDigest, window };
}

describe('grounded v2 citation manifest', () => {
  it('is stable across citation order and binds every selected window mapping', () => {
    const head = windowCitation('window_head');
    const base = { ...windowCitation('window_base'), id: 'window:window_base', side: 'base' as const,
      window: { ...windowCitation('window_base').window!, side: 'base' as const,
        revisionSha: 'b'.repeat(40), mapping: { ...windowCitation('window_base').window!.mapping,
          candidateSide: 'head' as const } } };
    const diff: GroundedCitationV2 = { id: `diff:src/handler.ts:${'e'.repeat(64)}`, path: 'src/handler.ts',
      repository: 'public-example/project', side: 'diff', revisionSha: 'a'.repeat(40),
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), sourceDigest: 'f'.repeat(64), regionDigest: 'e'.repeat(64) };

    expect(groundedCitationManifestDigest([head, base, diff]))
      .toBe(groundedCitationManifestDigest([diff, head, base]));
    if (head.window!.mapping.kind !== 'changed-hunk') throw new Error('test requires a changed-hunk mapping');
    const movedCandidate = { ...head, window: { ...head.window!, mapping: {
      ...head.window!.mapping, candidateLine: 43,
    } } };
    expect(groundedCitationManifestDigest([head, base, diff]))
      .not.toBe(groundedCitationManifestDigest([movedCandidate, base, diff]));
  });

  it('uses only the v2 allow-listed fields when building the manifest digest', () => {
    const citation = windowCitation('window_head');
    const forgedRuntimeField = { ...citation, untrustedSummary: 'ignore the strict receipt' } as GroundedCitationV2;
    expect(groundedCitationManifestDigest([citation])).toBe(groundedCitationManifestDigest([forgedRuntimeField]));
  });

  it('sorts citation IDs by locale-independent code point order', () => {
    const ascii = windowCitation('window:z');
    const unicode = { ...windowCitation('window:é'), id: 'window:é' };
    const compare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => 1);
    try {
      expect(groundedCitationManifestDigest([ascii, unicode]))
        .toBe(groundedCitationManifestDigest([unicode, ascii]));
      expect(compare).not.toHaveBeenCalled();
    } finally {
      compare.mockRestore();
    }
  });

  it('validates window IDs from exact metadata and rejects stale mapping digests', () => {
    const citation = windowCitation('placeholder');
    const { id: _ignored, ...material } = citation.window!;
    const id = groundedSourceWindowId(material);
    const validWindow = { ...material, id };
    const validCitation = { ...citation, id: `window:${id}`, window: validWindow,
      sourceDigest: validWindow.windowSha256 };
    expect(isValidGroundedCitationV2(validCitation)).toBe(true);
    if (validWindow.mapping.kind !== 'changed-hunk') throw new Error('test requires a changed-hunk mapping');
    expect(isValidGroundedCitationV2({ ...validCitation, window: { ...validWindow,
      mapping: { ...validWindow.mapping, candidateLine: 41 } } })).toBe(false);
  });

  it('rejects a candidate line outside the exact changed hunk range even when the window covers it', () => {
    const original = windowCitation('placeholder');
    const { id: _oldId, ...sourceWindow } = original.window!;
    if (sourceWindow.mapping.kind !== 'changed-hunk') throw new Error('test requires a changed-hunk mapping');
    const invalidMaterial = { ...sourceWindow, startLine: 1, endLine: 120, byteLength: 1_200,
      mapping: { ...sourceWindow.mapping, candidateLine: 100, oldStart: 10, oldLines: 1,
        newStart: 10, newLines: 1, counterpartStartLine: 10, counterpartEndLine: 10 } };
    const invalidId = groundedSourceWindowId(invalidMaterial);
    const invalidWindow = { ...invalidMaterial, id: invalidId };
    const invalidCitation = { ...original, id: `window:${invalidId}`, window: invalidWindow,
      sourceDigest: invalidWindow.windowSha256 };
    expect(isValidGroundedCitationV2(invalidCitation)).toBe(false);
  });

  it('rejects an opposite-side window whose candidate line is outside the mapped hunk interval', () => {
    const original = windowCitation('placeholder');
    const { id: _oldId, ...sourceWindow } = original.window!;
    if (sourceWindow.mapping.kind !== 'changed-hunk') throw new Error('test requires a changed-hunk mapping');
    const invalidMaterial = { ...sourceWindow, side: 'base' as const, role: 'mapped-base' as const,
      revisionSha: 'b'.repeat(40), startLine: 20, endLine: 30, byteLength: 1_000,
      mapping: { ...sourceWindow.mapping, candidateLine: 100, oldStart: 20, oldLines: 1,
        newStart: 10, newLines: 1, relation: 'replaced-region' as const,
        counterpartStartLine: 20, counterpartEndLine: 20 } };
    const invalidId = groundedSourceWindowId(invalidMaterial);
    const invalidWindow = { ...invalidMaterial, id: invalidId };
    const invalidCitation = { ...original, side: 'base' as const, revisionSha: invalidWindow.revisionSha,
      id: `window:${invalidId}`, window: invalidWindow, sourceDigest: invalidWindow.windowSha256 };
    expect(isValidGroundedCitationV2(invalidCitation)).toBe(false);
  });

  it('accepts an insertion-gap mapping in an equal-size mixed-change hunk', () => {
    const original = windowCitation('placeholder');
    const { id: _oldId, ...sourceWindow } = original.window!;
    if (sourceWindow.mapping.kind !== 'changed-hunk') throw new Error('test requires a changed-hunk mapping');
    const invalidMaterial = { ...sourceWindow, mapping: { ...sourceWindow.mapping,
      candidateLine: 43, oldStart: 42, oldLines: 1, newStart: 43, newLines: 1,
      relation: 'insertion-gap' as const, counterpartStartLine: null, counterpartEndLine: null,
      beforeLine: 42, afterLine: 43 } };
    const invalidId = groundedSourceWindowId(invalidMaterial);
    const invalidWindow = { ...invalidMaterial, id: invalidId };
    const invalidCitation = { ...original, id: `window:${invalidId}`, window: invalidWindow,
      sourceDigest: invalidWindow.windowSha256 };
    expect(isValidGroundedCitationV2(invalidCitation)).toBe(true);
  });

  it('rejects a gap mapping with no local counterpart anchor', () => {
    const original = windowCitation('placeholder');
    const { id: _oldId, ...sourceWindow } = original.window!;
    if (sourceWindow.mapping.kind !== 'changed-hunk') throw new Error('test requires a changed-hunk mapping');
    const invalidMaterial = { ...sourceWindow, mapping: { ...sourceWindow.mapping,
      candidateLine: 43, newStart: 43, newLines: 1, relation: 'insertion-gap' as const,
      counterpartStartLine: null, counterpartEndLine: null, beforeLine: null, afterLine: null } };
    const invalidId = groundedSourceWindowId(invalidMaterial);
    const invalidWindow = { ...invalidMaterial, id: invalidId };
    const invalidCitation = { ...original, id: `window:${invalidId}`, window: invalidWindow,
      sourceDigest: invalidWindow.windowSha256 };
    expect(isValidGroundedCitationV2(invalidCitation)).toBe(false);
  });

  it('rejects a dependency contract window whose source side disagrees with its import-edge side', () => {
    const edgeMaterial = {
      resolver: 'relative-import-v1' as const,
      importerPath: 'src/caller.ts', importerSide: 'head' as const,
      importerFullContentSha256: '1'.repeat(64), importerStatementStartLine: 1, importerStatementEndLine: 1,
      importSpecifier: './helper', contractSymbols: ['helper'], resolvedPath: 'src/helper.ts',
      contractFullContentSha256: '2'.repeat(64), definitionStartLine: 1, definitionEndLine: 1,
      definitionSha256: '3'.repeat(64), importStatementDigest: '4'.repeat(64),
      originRegionDigest: '5'.repeat(64),
    };
    const edge = { ...edgeMaterial, contractId: sha256(canonicalJson(edgeMaterial)) };
    const material = {
      version: 'GroundedSourceWindow.v1' as const, repository: 'public-example/project', path: 'src/helper.ts',
      side: 'base' as const, role: 'dependency-contract' as const, revisionSha: 'b'.repeat(40),
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), fullContentSha256: edge.contractFullContentSha256,
      startLine: 1, endLine: 1, windowSha256: '6'.repeat(64), byteLength: 20,
      regionDigest: edge.contractId, mapping: { kind: 'dependency-contract' as const, exhaustive: true as const, edge },
      exhaustive: false,
    };
    const id = groundedSourceWindowId(material);
    const citation: GroundedCitationV2 = { id: `window:${id}`, path: material.path, repository: material.repository,
      side: material.side, revisionSha: material.revisionSha, headSha: material.headSha, baseSha: material.baseSha,
      sourceDigest: material.windowSha256, regionDigest: material.regionDigest, window: { ...material, id } };
    expect(isValidGroundedCitationV2(citation)).toBe(false);
  });
});
