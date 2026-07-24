import crypto from 'crypto';

export interface HunkInput {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  hunkContent: string;
}

export interface FindingInput {
  filePath: string;
  persona: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  codeSnippet: string;
  comment: string;
  ruleId?: string;
  findingId?: string;
  startLine?: number;
  endLine?: number;
  lineNumber?: number;
}

export interface DiffHashUtil {
  computeHunkHash(input: HunkInput): string;
  computeFindingHash(input: FindingInput): string;
  normalizeSnippet(snippet: string): string;
  normalizeComment(comment: string): string;
}

export function normalizeSnippet(snippet: string): string {
  if (!snippet) return '';
  return snippet
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

export function normalizeComment(comment: string): string {
  if (!comment) return '';
  return comment
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeHunkHash(input: HunkInput): string {
  const normalizedContent = (input.hunkContent || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n');

  const rawString = `${input.filePath}\n${normalizedContent}`;
  return crypto.createHash('sha256').update(rawString, 'utf8').digest('hex');
}

export function computeFindingHash(input: FindingInput): string {
  const normalizedCode = normalizeSnippet(input.codeSnippet);

  const keyId = input.findingId || input.ruleId;
  const normalizedSummary = keyId
    ? normalizeComment(keyId)
    : normalizeComment(input.comment);

  const rawString = `${input.filePath}|${input.persona.toLowerCase()}|${normalizedCode}|${normalizedSummary}`;
  return crypto.createHash('sha256').update(rawString, 'utf8').digest('hex');
}

export const diffHashUtil: DiffHashUtil = {
  computeHunkHash,
  computeFindingHash,
  normalizeSnippet,
  normalizeComment
};
