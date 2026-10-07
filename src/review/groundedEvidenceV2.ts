import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from './reviewCore';
import {
  GROUNDED_SOURCE_WINDOW_MANIFEST_VERSION,
  GROUNDED_SOURCE_WINDOW_VERSION,
} from './groundedEvidenceContract';

export {
  GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
  GROUNDED_REVIEW_RECEIPT_V2_VERSION,
  GROUNDED_SOURCE_WINDOW_MANIFEST_VERSION,
  GROUNDED_SOURCE_WINDOW_VERSION,
  GROUNDED_VERIFICATION_V2_VERSION,
} from './groundedEvidenceContract';

/** SHA-256 over raw file bytes. `reviewCore.sha256` canonicalizes non-string inputs, so do not pass Buffers to it. */
export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export type GroundedWindowMappingV1 =
  | {
      kind: 'changed-hunk';
      candidateSide: 'head' | 'base';
      candidateLine: number;
      hunkOrdinal: number;
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      relation: 'replaced-region' | 'insertion-gap' | 'deletion-gap';
      counterpartStartLine: number | null;
      counterpartEndLine: number | null;
      beforeLine: number | null;
      afterLine: number | null;
    }
  | {
      kind: 'dependency-contract';
      exhaustive: true;
      edge: GroundedDependencyEdgeV1;
    };

export interface GroundedImportResolutionProbeV1 {
  path: string;
  presence: 'present' | 'absent';
  sourceDigest: string | null;
}

export interface GroundedImportResolutionReferenceV1 {
  importerPath: string;
  importerSide: 'head' | 'base';
  importerFullContentSha256: string;
  importerStatementStartLine: number;
  importerStatementEndLine: number;
  importSpecifier: string;
  importStatementDigest: string;
}

/** One unique pinned repository source observation used by the bounded resolver. */
export interface GroundedImportResolutionSourceV1 {
  repository: string;
  revisionSha: string;
  path: string;
  presence: 'present' | 'absent' | 'unavailable';
  sourceDigest: string | null;
  resolutionRefs: GroundedImportResolutionReferenceV1[];
}

/** Exact ordered path probes from a pinned repository source provider. */
export interface GroundedRelativeImportResolutionV1 {
  version: 'BoundedRelativeImportResolution.v1';
  revisionSha: string;
  state: 'resolved' | 'unresolved';
  resolvedPath: string | null;
  probes: GroundedImportResolutionProbeV1[];
}

export interface GroundedDependencyEdgeV1 {
  resolver: 'relative-import-v1';
  importerPath: string;
  importerSide: 'head' | 'base';
  importerFullContentSha256: string;
  importerStatementStartLine: number;
  importerStatementEndLine: number;
  importSpecifier: string;
  /** Required on reverse deleted-export proof; absent from historical forward dependency edges. */
  resolution?: GroundedRelativeImportResolutionV1;
  contractSymbols: string[];
  resolvedPath: string;
  contractFullContentSha256: string;
  definitionStartLine: number;
  definitionEndLine: number;
  definitionSha256: string;
  importStatementDigest: string;
  contractId: string;
  originRegionDigest: string;
}

/** Metadata for one exact UTF-8 excerpt from a complete, revision-pinned source file. */
export interface GroundedSourceWindowV1 {
  version: typeof GROUNDED_SOURCE_WINDOW_VERSION;
  id: string;
  repository: string;
  path: string;
  side: 'head' | 'base';
  role: 'candidate' | 'mapped-base' | 'mapped-head' | 'dependency-contract' | 'dependency-caller';
  revisionSha: string;
  headSha: string;
  baseSha: string;
  fullContentSha256: string;
  startLine: number;
  endLine: number;
  windowSha256: string;
  byteLength: number;
  regionDigest: string;
  mapping: GroundedWindowMappingV1;
  exhaustive: boolean;
}

/** A v2 allow-listed evidence reference. Raw excerpts never cross the durable receipt boundary. */
export interface GroundedCitationV2 {
  id: string;
  path: string;
  repository: string;
  side: 'head' | 'base' | 'diff';
  revisionSha: string;
  headSha: string;
  baseSha: string;
  sourceDigest: string;
  presence?: 'absent';
  window?: GroundedSourceWindowV1;
  regionDigest?: string;
}

function sourceWindowMaterial(window: Omit<GroundedSourceWindowV1, 'id'>): Omit<GroundedSourceWindowV1, 'id'> {
  return {
    version: window.version,
    repository: window.repository,
    path: window.path,
    side: window.side,
    role: window.role,
    revisionSha: window.revisionSha,
    headSha: window.headSha,
    baseSha: window.baseSha,
    fullContentSha256: window.fullContentSha256,
    startLine: window.startLine,
    endLine: window.endLine,
    windowSha256: window.windowSha256,
    byteLength: window.byteLength,
    regionDigest: window.regionDigest,
    mapping: window.mapping,
    exhaustive: window.exhaustive,
  };
}

export function groundedSourceWindowId(window: Omit<GroundedSourceWindowV1, 'id'>): string {
  return sha256(canonicalJson(sourceWindowMaterial(window)));
}

const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const isCommitSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validImportResolution(value: unknown): value is GroundedRelativeImportResolutionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const resolution = value as Record<string, unknown>;
  const keys = ['version', 'revisionSha', 'state', 'resolvedPath', 'probes'];
  if (Object.keys(resolution).length !== keys.length || Object.keys(resolution).some((key) => !keys.includes(key))
    || resolution.version !== 'BoundedRelativeImportResolution.v1' || !isCommitSha(resolution.revisionSha)
    || !['resolved', 'unresolved'].includes(String(resolution.state)) || !Array.isArray(resolution.probes)
    || resolution.probes.length === 0 || resolution.probes.length > 12) return false;
  const seen = new Set<string>();
  let presentIndex = -1;
  for (let index = 0; index < resolution.probes.length; index += 1) {
    const probe = resolution.probes[index];
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return false;
    const row = probe as Record<string, unknown>;
    if (Object.keys(row).length !== 3 || Object.keys(row).some((key) => !['path', 'presence', 'sourceDigest'].includes(key))
      || typeof row.path !== 'string' || row.path.length === 0 || row.path.startsWith('/')
      || row.path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || seen.has(row.path) || !['present', 'absent'].includes(String(row.presence))) return false;
    seen.add(row.path);
    if (row.presence === 'present') {
      if (!isDigest(row.sourceDigest) || presentIndex !== -1 || index !== resolution.probes.length - 1) return false;
      presentIndex = index;
    } else if (row.sourceDigest !== null) return false;
  }
  if (resolution.state === 'resolved') {
    return presentIndex === resolution.probes.length - 1
      && resolution.resolvedPath === (resolution.probes.at(-1) as Record<string, unknown>).path;
  }
  return presentIndex === -1 && resolution.resolvedPath === null;
}

function validWindowMapping(value: unknown, windowSide: 'head' | 'base', range: { start: number; end: number }): value is GroundedWindowMappingV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mapping = value as Record<string, unknown>;
  if (mapping.kind === 'changed-hunk') {
    const allowed = ['kind', 'candidateSide', 'candidateLine', 'hunkOrdinal', 'oldStart', 'oldLines', 'newStart',
      'newLines', 'relation', 'counterpartStartLine', 'counterpartEndLine', 'beforeLine', 'afterLine'];
    if (Object.keys(mapping).some((key) => !allowed.includes(key)) || Object.keys(mapping).length !== allowed.length) return false;
    const ints = ['candidateLine', 'hunkOrdinal', 'oldStart', 'oldLines', 'newStart', 'newLines'];
    if (ints.some((key) => !Number.isSafeInteger(mapping[key]) || Number(mapping[key]) < (key === 'candidateLine' ? 1 : 0))) return false;
    const optionalLines = ['counterpartStartLine', 'counterpartEndLine', 'beforeLine', 'afterLine'];
    if (optionalLines.some((key) => mapping[key] !== null && (!Number.isSafeInteger(mapping[key]) || Number(mapping[key]) < 1))) return false;
    if (!['head', 'base'].includes(String(mapping.candidateSide))
      || !['replaced-region', 'insertion-gap', 'deletion-gap'].includes(String(mapping.relation))) return false;
    const candidateSide = mapping.candidateSide;
    if (candidateSide === 'head' && mapping.relation === 'deletion-gap'
      || candidateSide === 'base' && mapping.relation === 'insertion-gap') return false;
    const candidateHunkStart = Number(candidateSide === 'head' ? mapping.newStart : mapping.oldStart);
    const candidateHunkLines = Number(candidateSide === 'head' ? mapping.newLines : mapping.oldLines);
    if (Number(mapping.candidateLine) < candidateHunkStart
      || Number(mapping.candidateLine) >= candidateHunkStart + candidateHunkLines) return false;
    if (mapping.relation === 'replaced-region'
      && (mapping.counterpartStartLine === null || mapping.counterpartEndLine === null
        || mapping.beforeLine !== null || mapping.afterLine !== null)) return false;
    if (mapping.relation !== 'replaced-region'
      && (mapping.counterpartStartLine !== null || mapping.counterpartEndLine !== null
        || mapping.beforeLine === null && mapping.afterLine === null
          && !(range.start === 1 && range.end === 0))) return false;
    if (candidateSide === windowSide) return Number(mapping.candidateLine) >= range.start && Number(mapping.candidateLine) <= range.end;
    if (range.start === 1 && range.end === 0 && mapping.beforeLine === null && mapping.afterLine === 1) return true;
    if (mapping.counterpartStartLine !== null && mapping.counterpartEndLine !== null) {
      return range.start <= Number(mapping.counterpartStartLine) && range.end >= Number(mapping.counterpartEndLine);
    }
    const eofGapAfter = mapping.beforeLine !== null && Number(mapping.beforeLine) === range.end
      && mapping.afterLine !== null && Number(mapping.afterLine) === range.end + 1;
    return [mapping.beforeLine, mapping.afterLine].filter((line) => line !== null)
      .every((line) => range.start <= Number(line) && range.end >= Number(line)
        || eofGapAfter && line === mapping.afterLine);
  }
  if (mapping.kind === 'dependency-contract') {
    const allowed = ['kind', 'exhaustive', 'edge'];
    if (Object.keys(mapping).some((key) => !allowed.includes(key)) || Object.keys(mapping).length !== allowed.length
      || mapping.exhaustive !== true || !mapping.edge || typeof mapping.edge !== 'object' || Array.isArray(mapping.edge)) return false;
    const edge = mapping.edge as Record<string, unknown>;
    const edgeKeys = ['resolver', 'importerPath', 'importerSide', 'importerFullContentSha256',
      'importerStatementStartLine', 'importerStatementEndLine',
      'importSpecifier', 'contractSymbols', 'resolvedPath', 'contractFullContentSha256', 'definitionStartLine',
      'definitionEndLine', 'definitionSha256', 'importStatementDigest', 'contractId', 'originRegionDigest', 'resolution'];
    const edgeKeysRequired = edgeKeys.filter((key) => key !== 'resolution');
    if (Object.keys(edge).some((key) => !edgeKeys.includes(key))
      || edgeKeysRequired.some((key) => !(key in edge))
      || Object.keys(edge).length < edgeKeysRequired.length || Object.keys(edge).length > edgeKeys.length
      || 'resolution' in edge && !validImportResolution(edge.resolution)
      || edge.resolver !== 'relative-import-v1' || typeof edge.resolvedPath !== 'string' || edge.resolvedPath.length === 0
      || !['head', 'base'].includes(String(edge.importerSide))
      || typeof edge.importerPath !== 'string' || edge.importerPath.length === 0
      || typeof edge.importSpecifier !== 'string' || !/^\.\.?\//u.test(edge.importSpecifier)
      || !Array.isArray(edge.contractSymbols) || edge.contractSymbols.length === 0 || edge.contractSymbols.length > 32
      || edge.contractSymbols.some((symbol) => typeof symbol !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(symbol))
      || canonicalJson([...edge.contractSymbols].sort()) !== canonicalJson(edge.contractSymbols)
      || !Number.isSafeInteger(edge.importerStatementStartLine) || Number(edge.importerStatementStartLine) < 1
      || !Number.isSafeInteger(edge.importerStatementEndLine)
      || Number(edge.importerStatementEndLine) < Number(edge.importerStatementStartLine)
      || !isDigest(edge.importerFullContentSha256) || !isDigest(edge.contractFullContentSha256)
      || !Number.isSafeInteger(edge.definitionStartLine) || Number(edge.definitionStartLine) < 1
      || !Number.isSafeInteger(edge.definitionEndLine) || Number(edge.definitionEndLine) < Number(edge.definitionStartLine)
      || !isDigest(edge.definitionSha256) || !isDigest(edge.importStatementDigest) || !isDigest(edge.originRegionDigest)
      || !isDigest(edge.contractId)) return false;
    const { contractId, ...edgeMaterial } = edge;
    return contractId === sha256(canonicalJson(edgeMaterial));
  }
  return false;
}

export function isValidGroundedSourceWindowV1(value: unknown): value is GroundedSourceWindowV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const window = value as Record<string, unknown>;
  const keys = ['version', 'id', 'repository', 'path', 'side', 'role', 'revisionSha', 'headSha', 'baseSha',
    'fullContentSha256', 'startLine', 'endLine', 'windowSha256', 'byteLength', 'regionDigest', 'mapping', 'exhaustive'];
  if (Object.keys(window).some((key) => !keys.includes(key)) || Object.keys(window).length !== keys.length
    || window.version !== GROUNDED_SOURCE_WINDOW_VERSION || typeof window.id !== 'string' || !/^[a-f0-9]{64}$/u.test(window.id)
    || typeof window.repository !== 'string' || !window.repository.includes('/')
    || typeof window.path !== 'string' || window.path.length === 0 || !['head', 'base'].includes(String(window.side))
    || !['candidate', 'mapped-base', 'mapped-head', 'dependency-contract', 'dependency-caller'].includes(String(window.role))
    || !isCommitSha(window.revisionSha) || !isCommitSha(window.headSha) || !isCommitSha(window.baseSha)
    || !isDigest(window.fullContentSha256) || !isDigest(window.windowSha256) || !isDigest(window.regionDigest)
    || !Number.isSafeInteger(window.startLine) || !Number.isSafeInteger(window.endLine)
    || !Number.isSafeInteger(window.byteLength) || Number(window.byteLength) < 0
    || Number(window.byteLength) > 24_000 || typeof window.exhaustive !== 'boolean') return false;
  const range = { start: Number(window.startLine), end: Number(window.endLine) };
  const emptySourceRange = range.start === 1 && range.end === 0 && window.byteLength === 0 && window.exhaustive === true;
  if (!emptySourceRange && (range.start < 1 || range.end < range.start)) return false;
  const role = window.role;
  if (!validWindowMapping(window.mapping, window.side as 'head' | 'base', range)) return false;
  const mapping = window.mapping as Record<string, unknown>;
  if ((role === 'dependency-contract' || role === 'dependency-caller') && mapping.kind !== 'dependency-contract'
    || role !== 'dependency-contract' && role !== 'dependency-caller' && mapping.kind !== 'changed-hunk') return false;
  if (role === 'dependency-contract' || role === 'dependency-caller') {
    const edge = mapping.edge as Record<string, unknown>;
    const windowStart = Number(window.startLine);
    const windowEnd = Number(window.endLine);
    if (window.regionDigest !== edge.contractId) return false;
    if (role === 'dependency-contract') {
      if (edge.importerSide !== window.side || edge.resolvedPath !== window.path
        || edge.contractFullContentSha256 !== window.fullContentSha256
        || range.start > Number(edge.definitionStartLine) || range.end < Number(edge.definitionEndLine)
        || windowStart > Number(edge.definitionStartLine) || windowEnd < Number(edge.definitionEndLine)) return false;
    } else if (edge.importerPath !== window.path || edge.importerSide !== window.side
      || edge.importerFullContentSha256 !== window.fullContentSha256
      || range.start > Number(edge.importerStatementStartLine) || range.end < Number(edge.importerStatementEndLine)
      || windowStart > Number(edge.importerStatementStartLine) || windowEnd < Number(edge.importerStatementEndLine)) return false;
  }
  if (role === 'candidate' && (!window.mapping || (window.mapping as Record<string, unknown>).kind !== 'changed-hunk'
    || (window.mapping as unknown as GroundedWindowMappingV1 & { candidateSide: string }).candidateSide !== window.side)) return false;
  if (role === 'mapped-base' && window.side !== 'base' || role === 'mapped-head' && window.side !== 'head') return false;
  if (window.revisionSha !== (window.side === 'head' ? window.headSha : window.baseSha)) return false;
  const { id, ...material } = window as unknown as GroundedSourceWindowV1;
  return id === groundedSourceWindowId(material);
}

export function isValidGroundedCitationV2(value: unknown): value is GroundedCitationV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const citation = value as Record<string, unknown>;
  const allowed = ['id', 'path', 'repository', 'side', 'revisionSha', 'headSha', 'baseSha', 'sourceDigest',
    'presence', 'window', 'regionDigest'];
  if (Object.keys(citation).some((key) => !allowed.includes(key))
    || typeof citation.id !== 'string' || typeof citation.path !== 'string' || citation.path.length === 0
    || typeof citation.repository !== 'string' || !citation.repository.includes('/')
    || !['head', 'base', 'diff'].includes(String(citation.side))
    || !isCommitSha(citation.revisionSha) || !isCommitSha(citation.headSha) || !isCommitSha(citation.baseSha)
    || !isDigest(citation.sourceDigest)) return false;
  if (citation.side === 'diff') {
    return citation.window === undefined && citation.presence === undefined && isDigest(citation.regionDigest)
      && citation.revisionSha === citation.headSha
      && citation.id === `diff:${citation.path}:${citation.regionDigest}`;
  }
  if (citation.presence === 'absent') {
    return citation.window === undefined && citation.regionDigest === undefined
      && citation.revisionSha === (citation.side === 'head' ? citation.headSha : citation.baseSha)
      && citation.id === `absence:${citation.side}:${citation.path}`;
  }
  if (citation.presence !== undefined || !isValidGroundedSourceWindowV1(citation.window)) return false;
  const window = citation.window;
  return citation.id === `window:${window.id}` && citation.path === window.path && citation.repository === window.repository
    && citation.side === window.side && citation.revisionSha === window.revisionSha
    && citation.headSha === window.headSha && citation.baseSha === window.baseSha
    && citation.sourceDigest === window.windowSha256 && citation.regionDigest === window.regionDigest;
}

function citationMaterial(citation: GroundedCitationV2): Record<string, unknown> {
  return {
    id: citation.id,
    path: citation.path,
    repository: citation.repository,
    side: citation.side,
    revisionSha: citation.revisionSha,
    headSha: citation.headSha,
    baseSha: citation.baseSha,
    sourceDigest: citation.sourceDigest,
    ...(citation.presence === undefined ? {} : { presence: citation.presence }),
    ...(citation.window === undefined ? {} : { window: citation.window }),
    ...(citation.regionDigest === undefined ? {} : { regionDigest: citation.regionDigest }),
  };
}

/**
 * Hashes the complete sorted allow-list, including each selected window's full-source digest,
 * exact excerpt digest, line mapping, revision identity, and causal region. Callers must still
 * reject duplicate IDs and validate the strict citation schema before trusting the digest.
 */
export function groundedCitationManifestDigest(citations: readonly GroundedCitationV2[]): string {
  const ordered = [...citations].sort((left, right) => compareCodePoint(left.id, right.id))
    .map(citationMaterial);
  return sha256(canonicalJson({ version: GROUNDED_SOURCE_WINDOW_MANIFEST_VERSION, citations: ordered }));
}
