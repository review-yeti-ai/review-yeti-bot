import fs from 'fs';
import path from 'path';
import { calculateSafeDiffCapacity } from '../gateway/openRouterClient';
import {
  compactUnifiedDiff,
  compactFileListDiffs,
  DiffCompactionOptions,
} from '../pipeline/diffCompactor';
import {
  TurnHistoryManager,
  TurnHistoryManagerOptions,
} from '../pipeline/turnHistoryManager';

// =========================================================================
// INTERFACE DEFINITIONS & TYPES
// =========================================================================

export interface PiPluginConfig {
  workspaceRoot: string;
  diffBudgetLimitChars?: number; // default: dynamic model capacity or 410,400
  fileBudgetLimitChars?: number; // default: 128,000 (or Math.min(diffBudgetLimitChars, 128,000))
  model?: string; // target model for dynamic capacity calculation
  maxToolCallsPerTurn?: number; // default: 5
  maxTurnsPerSession?: number; // default: 5
  maxFileReadBytes?: number; // default: 32,768 (hard cap 65,536)
  toolTimeoutMs?: number; // default: 5,000
  sessionTimeoutMs?: number; // default: 60,000
  allowedExtensions?: string[];
  modelCostPer1kPrompt?: number; // default: 0.00015
  modelCostPer1kCompletion?: number; // default: 0.0006
  enableDiffCompaction?: boolean;
  diffCompactionOptions?: DiffCompactionOptions;
}

export interface DiffInputFile {
  path: string;
  patch?: string;
  content?: string;
  status?: 'modified' | 'added' | 'deleted' | 'renamed';
}

export interface DiffBudgetResult {
  budgetLimitChars: number;
  originalTotalChars: number;
  includedTotalChars: number;
  omittedTotalChars: number;
  totalFiles: number;
  includedFilesCount: number;
  truncatedFilesCount: number;
  omittedFilesCount: number;
  formattedDiff: string;
  omissionNoticeHeader?: string;
  truncatedFiles: Array<{
    path: string;
    originalChars: number;
    includedChars: number;
    omittedLines: number;
  }>;
  omittedFiles: Array<{
    path: string;
    originalChars: number;
    reason: 'budget_exhausted' | 'lockfile' | 'generated' | 'path_filtered';
  }>;
}

export interface PiToolReceipt {
  callId: string;
  personaId: string;
  turn: number;
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  endTime: number;
  durationMs: number;
  bytesRead: number;
  filesScanned: number;
  resultCount: number;
  status: 'success' | 'rate_limited' | 'error' | 'timeout';
  error?: string;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
}

export interface PiToolCallRequest {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PiToolCallResponse {
  callId?: string;
  tool: string;
  status: 'success' | 'rate_limited' | 'error' | 'timeout';
  output: string;
  durationMs: number;
  bytesRead: number;
  tokenEstimate: number;
  error?: string;
}

export interface PiSessionMetrics {
  totalToolCalls: number;
  successfulToolCalls: number;
  rateLimitedCalls: number;
  errorCalls: number;
  totalBytesRead: number;
  totalFilesScanned: number;
  totalToolDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUSD: number;
  receipts: PiToolReceipt[];
}

export interface CodeSearchResult {
  path: string;
  line: number;
  match: string;
}

export interface SymbolLookupResult {
  path: string;
  line: number;
  kind: string;
  signature: string;
}

export interface PiWorkspacePlugin {
  getWorkspaceRoot(): string;
  applyDiffBudget(files: DiffInputFile[]): DiffBudgetResult;
  executeTool(
    personaId: string,
    turn: number,
    call: PiToolCallRequest | { name: string; arguments: Record<string, unknown> }
  ): Promise<PiToolCallResponse>;
  executeTurnBatch(
    personaId: string,
    turn: number,
    calls: Array<PiToolCallRequest | { name: string; arguments: Record<string, unknown> }>
  ): Promise<PiToolCallResponse[]>;
  getSessionMetrics(personaId?: string): PiSessionMetrics;
  resetSession(personaId?: string): void;
  resetTurn?(personaId: string): void;
  createTurnHistoryManager?(personaId: string, options?: TurnHistoryManagerOptions): TurnHistoryManager;
}

// =========================================================================
// SECURITY ERROR
// =========================================================================

export class PiVfsSecurityError extends Error {
  public readonly code: string = 'VFS_SECURITY_VIOLATION';

  constructor(message: string) {
    super(`PiVfsSecurityError: ${message}`);
    this.name = 'PiVfsSecurityError';
    Object.setPrototypeOf(this, PiVfsSecurityError.prototype);
  }
}

// =========================================================================
// MAIN PLUGIN IMPLEMENTATION
// =========================================================================

export class PiWorkspacePluginImpl implements PiWorkspacePlugin {
  private readonly workspaceRoot: string;
  private readonly canonicalWorkspaceRoot: string;
  private readonly diffBudgetLimitChars: number;
  private readonly fileBudgetLimitChars: number;
  private readonly maxToolCallsPerTurn: number;
  private readonly maxTurnsPerSession: number;
  private readonly maxFileReadBytes: number;
  private readonly toolTimeoutMs: number;
  private readonly sessionTimeoutMs: number;
  private readonly modelCostPer1kPrompt: number;
  private readonly modelCostPer1kCompletion: number;
  private readonly allowedExtensions?: Set<string>;
  private readonly enableDiffCompaction: boolean;
  private readonly diffCompactionOptions: DiffCompactionOptions;

  private personaTurns: Map<
    string,
    {
      currentTurn: number;
      callsInCurrentTurn: number;
      totalCalls: number;
    }
  > = new Map();

  private receipts: PiToolReceipt[] = [];

  constructor(config: PiPluginConfig) {
    if (!config || !config.workspaceRoot) {
      throw new Error('PiWorkspacePlugin: config.workspaceRoot is required');
    }
    this.workspaceRoot = path.resolve(config.workspaceRoot);
    try {
      this.canonicalWorkspaceRoot = fs.realpathSync(this.workspaceRoot);
    } catch {
      this.canonicalWorkspaceRoot = this.workspaceRoot;
    }

    const defaultDiffBudget = config.model
      ? calculateSafeDiffCapacity(config.model).safeDiffChars
      : 410400;
    this.diffBudgetLimitChars = config.diffBudgetLimitChars ?? defaultDiffBudget;
    this.fileBudgetLimitChars = config.fileBudgetLimitChars ?? Math.min(this.diffBudgetLimitChars, 128000);
    this.maxToolCallsPerTurn = config.maxToolCallsPerTurn ?? 5;
    this.maxTurnsPerSession = config.maxTurnsPerSession ?? 5;
    this.maxFileReadBytes = Math.min(config.maxFileReadBytes ?? 32768, 65536);
    this.toolTimeoutMs = config.toolTimeoutMs ?? 5000;
    this.sessionTimeoutMs = config.sessionTimeoutMs ?? 60000;
    this.modelCostPer1kPrompt = config.modelCostPer1kPrompt ?? 0.00015;
    this.modelCostPer1kCompletion = config.modelCostPer1kCompletion ?? 0.0006;
    this.enableDiffCompaction = config.enableDiffCompaction ?? false;
    this.diffCompactionOptions = config.diffCompactionOptions ?? {};

    if (config.allowedExtensions && config.allowedExtensions.length > 0) {
      this.allowedExtensions = new Set(
        config.allowedExtensions.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase()))
      );
    }
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  // =========================================================================
  // 1. DIFF CHARACTER BUDGET ENGINE
  // =========================================================================

  public applyDiffBudget(files: DiffInputFile[]): DiffBudgetResult {
    if (!files || !Array.isArray(files) || files.length === 0) {
      return {
        budgetLimitChars: this.diffBudgetLimitChars,
        originalTotalChars: 0,
        includedTotalChars: 0,
        omittedTotalChars: 0,
        totalFiles: 0,
        includedFilesCount: 0,
        truncatedFilesCount: 0,
        omittedFilesCount: 0,
        formattedDiff: '',
        truncatedFiles: [],
        omittedFiles: [],
      };
    }

    const truncatedFiles: Array<{
      path: string;
      originalChars: number;
      includedChars: number;
      omittedLines: number;
    }> = [];

    const omittedFiles: Array<{
      path: string;
      originalChars: number;
      reason: 'budget_exhausted' | 'lockfile' | 'generated' | 'path_filtered';
    }> = [];

    let originalTotalChars = 0;
    const preprocessedFiles: Array<{
      file: DiffInputFile;
      rawPatch: string;
      originalChars: number;
      isOmitted: boolean;
      omittedReason?: 'lockfile' | 'generated' | 'path_filtered';
      priority: number;
    }> = [];

    for (const f of files) {
      const rawPatch = f.patch ?? (f.content ? this.synthesizeUnifiedDiff(f.path, f.content) : '');
      const originalChars = rawPatch.length;
      originalTotalChars += originalChars;

      if (this.isLockfile(f.path)) {
        preprocessedFiles.push({
          file: f,
          rawPatch,
          originalChars,
          isOmitted: true,
          omittedReason: 'lockfile',
          priority: 99,
        });
      } else if (this.isGenerated(f.path)) {
        preprocessedFiles.push({
          file: f,
          rawPatch,
          originalChars,
          isOmitted: true,
          omittedReason: 'generated',
          priority: 98,
        });
      } else {
        const priority = this.computeFilePriority(f.path);
        preprocessedFiles.push({
          file: f,
          rawPatch,
          originalChars,
          isOmitted: false,
          priority,
        });
      }
    }

    const activeFiles = preprocessedFiles.filter((p) => !p.isOmitted);
    activeFiles.sort((a, b) => a.priority - b.priority);

    for (const p of preprocessedFiles) {
      if (p.isOmitted && p.omittedReason) {
        omittedFiles.push({
          path: p.file.path,
          originalChars: p.originalChars,
          reason: p.omittedReason,
        });
      }
    }

    let remainingGlobalBudget = this.diffBudgetLimitChars;
    const includedDiffChunks: string[] = [];
    let includedTotalChars = 0;

    for (const item of activeFiles) {
      const filePath = item.file.path;
      const rawPatch = item.rawPatch;

      if (remainingGlobalBudget <= 100) {
        omittedFiles.push({
          path: filePath,
          originalChars: item.originalChars,
          reason: 'budget_exhausted',
        });
        continue;
      }

      const currentFileBudget = Math.min(this.fileBudgetLimitChars, remainingGlobalBudget);

      if (rawPatch.length <= currentFileBudget) {
        includedDiffChunks.push(rawPatch);
        includedTotalChars += rawPatch.length;
        remainingGlobalBudget -= rawPatch.length;
      } else {
        const { truncatedPatch, includedChars, omittedLines } = this.truncateHunks(
          filePath,
          rawPatch,
          currentFileBudget
        );

        if (includedChars > 0 && truncatedPatch.trim().length > 0) {
          includedDiffChunks.push(truncatedPatch);
          includedTotalChars += truncatedPatch.length;
          remainingGlobalBudget -= truncatedPatch.length;

          truncatedFiles.push({
            path: filePath,
            originalChars: item.originalChars,
            includedChars: truncatedPatch.length,
            omittedLines,
          });
        } else {
          omittedFiles.push({
            path: filePath,
            originalChars: item.originalChars,
            reason: 'budget_exhausted',
          });
        }
      }
    }

    let omissionNoticeHeader: string | undefined;
    const hasOmissions = truncatedFiles.length > 0 || omittedFiles.length > 0;

    if (hasOmissions) {
      const parts: string[] = [];
      parts.push(
        `[DIFF_BUDGET_NOTICE]: PR diff was ${originalTotalChars.toLocaleString()} characters (truncated to ${this.diffBudgetLimitChars.toLocaleString()} limit).`
      );
      if (truncatedFiles.length > 0) {
        const truncList = truncatedFiles
          .map((t) => `${t.path} (${t.omittedLines} lines omitted)`)
          .join(', ');
        parts.push(`- ${truncatedFiles.length} file(s) truncated: ${truncList}`);
      }
      if (omittedFiles.length > 0) {
        const omitList = omittedFiles
          .map((o) => `${o.path} (${o.reason.replace(/_/g, ' ')})`)
          .join(', ');
        parts.push(`- ${omittedFiles.length} file(s) omitted: ${omitList}`);
      }
      parts.push(
        'Action: Use sandboxed tools (pi.fs.readFile, pi.code.search, pi.symbol.lookup) to proactively investigate omitted sections and cross-module contracts.'
      );
      omissionNoticeHeader = parts.join('\n');
    }

    let formattedDiff = includedDiffChunks.join('\n\n');
    if (omissionNoticeHeader) {
      formattedDiff = `${omissionNoticeHeader}\n\n${formattedDiff}`;
    }

    const omittedTotalChars = Math.max(0, originalTotalChars - includedTotalChars);

    return {
      budgetLimitChars: this.diffBudgetLimitChars,
      originalTotalChars,
      includedTotalChars,
      omittedTotalChars,
      totalFiles: files.length,
      includedFilesCount: includedDiffChunks.length,
      truncatedFilesCount: truncatedFiles.length,
      omittedFilesCount: omittedFiles.length,
      formattedDiff,
      omissionNoticeHeader,
      truncatedFiles,
      omittedFiles,
    };
  }

  private isLockfile(filePath: string): boolean {
    return /(?:^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|mix\.lock|go\.sum|composer\.lock|poetry\.lock|Gemfile\.lock)$/i.test(
      filePath
    );
  }

  private isGenerated(filePath: string): boolean {
    return /\.(min\.js|min\.css|map|bundle\.js)$|^(?:dist|build|\.next|\.nuxt|\.output|coverage)\//i.test(
      filePath
    );
  }

  private computeFilePriority(filePath: string): number {
    const lower = filePath.toLowerCase();
    if (
      /auth|security|crypto|permission|signaling|gateway|billing|fsm|dial|sip|rtp|cdr|quota|session|payment|token/i.test(
        lower
      )
    ) {
      return 1;
    }
    if (/\.(ts|tsx|js|jsx|py|go|rs|ex|exs|sql|java|cpp|c|h|rb|php|cs|scala|kt|swift)$/i.test(lower)) {
      return 2;
    }
    if (/package\.json|\.(ya?ml|env|toml|json)$|Makefile|Dockerfile/i.test(lower)) {
      return 3;
    }
    if (/\.(test|spec)\.[a-z]+$|(?:^|\/)(?:tests?|specs?|__tests__)\//i.test(lower)) {
      return 4;
    }
    return 5;
  }

  private synthesizeUnifiedDiff(filePath: string, content: string): string {
    const lines = content.split(/\r?\n/);
    const hunkHeader = `@@ -1,0 +1,${lines.length} @@`;
    const diffLines = lines.map((l) => `+${l}`).join('\n');
    return `--- a/${filePath}\n+++ b/${filePath}\n${hunkHeader}\n${diffLines}`;
  }

  private truncateHunks(
    filePath: string,
    rawPatch: string,
    charBudget: number
  ): { truncatedPatch: string; includedChars: number; omittedLines: number } {
    const lines = rawPatch.split(/\r?\n/);
    if (lines.length === 0) {
      return { truncatedPatch: '', includedChars: 0, omittedLines: 0 };
    }

    const headerLines: string[] = [];
    let idx = 0;

    while (idx < lines.length && !lines[idx].startsWith('@@')) {
      headerLines.push(lines[idx]);
      idx++;
    }

    const headerText = headerLines.length > 0 ? headerLines.join('\n') + '\n' : '';
    let currentBudget = charBudget - headerText.length;

    if (currentBudget <= 100) {
      return { truncatedPatch: '', includedChars: 0, omittedLines: lines.length };
    }

    const includedLines: string[] = [];
    let totalOmittedLines = 0;
    let truncated = false;

    while (idx < lines.length) {
      const line = lines[idx];
      if (line.startsWith('@@')) {
        const hunkLines: string[] = [line];
        idx++;
        while (idx < lines.length && !lines[idx].startsWith('@@')) {
          hunkLines.push(lines[idx]);
          idx++;
        }

        const hunkText = hunkLines.join('\n') + '\n';
        if (!truncated && hunkText.length <= currentBudget) {
          includedLines.push(...hunkLines);
          currentBudget -= hunkText.length;
        } else if (!truncated) {
          truncated = true;
          includedLines.push(hunkLines[0]);
          currentBudget -= hunkLines[0].length + 1;

          for (let h = 1; h < hunkLines.length; h++) {
            const hLine = hunkLines[h];
            if (hLine.length + 1 <= currentBudget - 150) {
              includedLines.push(hLine);
              currentBudget -= hLine.length + 1;
            } else {
              totalOmittedLines += hunkLines.length - h;
              break;
            }
          }

          const omissionMarker = `... [Diff truncated: ${Math.max(totalOmittedLines, 1)} lines omitted. Use pi.fs.readFile("${filePath}", 1, ${lines.length}) to inspect omitted sections] ...`;
          includedLines.push(omissionMarker);
        } else {
          totalOmittedLines += hunkLines.length;
        }
      } else {
        idx++;
      }
    }

    const finalPatch = headerText + includedLines.join('\n');
    return {
      truncatedPatch: finalPatch,
      includedChars: finalPatch.length,
      omittedLines: Math.max(totalOmittedLines, 1),
    };
  }

  // =========================================================================
  // 2. VFS SECURITY LAYER
  // =========================================================================

  public resolveSafePath(relPath: string): string {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      throw new PiVfsSecurityError('Invalid path: path must be a non-empty string');
    }

    // Check for null bytes (poison null byte attack)
    if (relPath.includes('\0') || /\0/.test(relPath)) {
      throw new PiVfsSecurityError('Path contains invalid null bytes');
    }

    // Check for encoded null byte or control chars
    if (/%00|%0a|%0d/i.test(relPath)) {
      throw new PiVfsSecurityError('Path contains encoded control/null characters');
    }

    let decodedPath = relPath;
    try {
      decodedPath = decodeURIComponent(relPath);
    } catch {
      // If URI decode fails, keep original
    }

    if (decodedPath.includes('\0') || /\0/.test(decodedPath)) {
      throw new PiVfsSecurityError('Path contains invalid null bytes after decoding');
    }

    // Normalize forward/backward slashes
    const cleanRel = decodedPath.trim().replace(/\\/g, '/');

    // Resolve target path
    const resolved = path.isAbsolute(cleanRel)
      ? path.resolve(cleanRel)
      : path.resolve(this.workspaceRoot, cleanRel);

    // 1. Path traversal check relative to workspaceRoot
    const relFromRoot = path.relative(this.workspaceRoot, resolved);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      throw new PiVfsSecurityError(`Access denied: path traversal out of workspace root (${relPath})`);
    }

    // 2. Symlink jailbreak check
    if (fs.existsSync(resolved)) {
      try {
        const realTarget = fs.realpathSync(resolved);
        const relFromCanonical = path.relative(this.canonicalWorkspaceRoot, realTarget);
        if (relFromCanonical.startsWith('..') || path.isAbsolute(relFromCanonical)) {
          throw new PiVfsSecurityError(`Access denied: symlink resolves outside workspace root (${relPath})`);
        }
      } catch (err: any) {
        if (err instanceof PiVfsSecurityError) throw err;
        throw new PiVfsSecurityError(`Access denied: failed to canonicalize path (${err.message})`);
      }
    }

    return resolved;
  }

  // =========================================================================
  // 3. SANDBOXED TOOL OPERATIONS
  // =========================================================================

  public async readFile(
    relPath: string,
    startLine?: number,
    endLine?: number,
    maxBytes?: number
  ): Promise<{ output: string; bytesRead: number }> {
    const fullPath = this.resolveSafePath(relPath);

    if (!fs.existsSync(fullPath)) {
      return { output: `Error: File not found in workspace: ${relPath}`, bytesRead: 0 };
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return { output: `Error: Path is a directory, not a file: ${relPath}`, bytesRead: 0 };
    }

    const effectiveMaxBytes = Math.min(maxBytes ?? this.maxFileReadBytes, 65536);
    if (stat.size > 1024 * 1024) {
      return {
        output: `Error: File exceeds maximum allowed size (${stat.size} > 1048576 bytes): ${relPath}`,
        bytesRead: 0,
      };
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const bytesRead = Buffer.byteLength(content, 'utf8');
    const lines = content.split(/\r?\n/);

    let outputLines: string[] = [];

    if (typeof startLine === 'number' || typeof endLine === 'number') {
      const start =
        typeof startLine === 'number' && Number.isFinite(startLine)
          ? Math.max(1, Math.floor(startLine))
          : 1;
      const end =
        typeof endLine === 'number' && Number.isFinite(endLine)
          ? Math.min(lines.length, Math.floor(endLine))
          : lines.length;

      if (start > lines.length) {
        return {
          output: `[Lines ${start}-${end} of ${relPath}: empty (file has ${lines.length} lines)]`,
          bytesRead,
        };
      }

      const slice = lines.slice(start - 1, end);
      outputLines = slice.map((l, i) => `${start + i}: ${l}`);
    } else {
      outputLines = lines.map((l, i) => `${i + 1}: ${l}`);
    }

    let output = outputLines.join('\n');

    if (Buffer.byteLength(output, 'utf8') > effectiveMaxBytes) {
      const truncatedSlice = output.slice(0, effectiveMaxBytes);
      const lastLineBreak = truncatedSlice.lastIndexOf('\n');
      output =
        (lastLineBreak > 0 ? truncatedSlice.slice(0, lastLineBreak) : truncatedSlice) +
        '\n... [Output truncated: exceeds maxBytes limit] ...';
    }

    return { output, bytesRead };
  }

  public async codeSearch(
    query: string,
    dir: string = '.',
    fileGlob?: string,
    maxResults: number = 25,
    caseSensitive: boolean = false
  ): Promise<{ results: CodeSearchResult[]; filesScanned: number; bytesRead: number }> {
    if (!query || typeof query !== 'string') {
      return { results: [], filesScanned: 0, bytesRead: 0 };
    }

    const searchDir = this.resolveSafePath(dir);
    const clampedMaxResults = Math.min(Math.max(1, maxResults), 50);

    let regex: RegExp;
    try {
      regex = new RegExp(query, caseSensitive ? '' : 'i');
    } catch {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, caseSensitive ? '' : 'i');
    }

    const files = this.collectFiles(searchDir, fileGlob);
    const results: CodeSearchResult[] = [];
    let filesScanned = 0;
    let bytesRead = 0;
    const searchStartTime = Date.now();

    for (const filePath of files) {
      if (results.length >= clampedMaxResults) break;
      if (Date.now() - searchStartTime > this.toolTimeoutMs) break;

      filesScanned++;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        bytesRead += Buffer.byteLength(content, 'utf8');
        const lines = content.split(/\r?\n/);
        const relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');

        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i];
          if (regex.test(lineText)) {
            results.push({
              path: relPath,
              line: i + 1,
              match: lineText.trim(),
            });
            if (results.length >= clampedMaxResults) break;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return { results, filesScanned, bytesRead };
  }

  public async symbolLookup(
    symbol: string,
    kindFilter?: string,
    maxResults: number = 25
  ): Promise<{ results: SymbolLookupResult[]; filesScanned: number; bytesRead: number }> {
    if (!symbol || typeof symbol !== 'string') {
      return { results: [], filesScanned: 0, bytesRead: 0 };
    }

    const cleanSymbol = symbol.trim();
    if (!cleanSymbol) {
      return { results: [], filesScanned: 0, bytesRead: 0 };
    }

    const clampedMaxResults = Math.min(Math.max(1, maxResults), 50);
    const files = this.collectFiles(this.workspaceRoot);
    const results: SymbolLookupResult[] = [];
    let filesScanned = 0;
    let bytesRead = 0;

    const escaped = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const patterns: Array<{ kind: string; regex: RegExp }> = [
      { kind: 'class', regex: new RegExp(`\\b(?:class|defmodule)\\s+(${escaped})\\b`) },
      { kind: 'interface', regex: new RegExp(`\\b(?:interface|defprotocol|trait)\\s+(${escaped})\\b`) },
      { kind: 'type', regex: new RegExp(`\\btype\\s+(${escaped})\\b`) },
      { kind: 'enum', regex: new RegExp(`\\benum\\s+(${escaped})\\b`) },
      { kind: 'function', regex: new RegExp(`\\b(?:async\\s+)?function\\s+(\\w+\\.)?(${escaped})\\b|\\bdefp?\\s+(${escaped})\\b|\\bfunc\\s+(?:\\([^)]+\\)\\s+)?(${escaped})\\b|\\bfn\\s+(${escaped})\\b`) },
      { kind: 'variable', regex: new RegExp(`\\b(?:const|let|var)\\s+(${escaped})\\s*[:=]`) },
      { kind: 'method', regex: new RegExp(`(?:public|private|protected|static|async)?\\s*\\b(${escaped})\\s*\\(`) },
    ];

    for (const filePath of files) {
      if (results.length >= clampedMaxResults) break;
      filesScanned++;

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        bytesRead += Buffer.byteLength(content, 'utf8');
        const lines = content.split(/\r?\n/);
        const relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');

        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i];

          for (const p of patterns) {
            if (kindFilter && kindFilter !== 'any' && p.kind !== kindFilter.toLowerCase()) {
              continue;
            }

            if (p.regex.test(lineText)) {
              results.push({
                path: relPath,
                line: i + 1,
                kind: p.kind,
                signature: lineText.trim(),
              });
              break;
            }
          }

          if (results.length >= clampedMaxResults) break;
        }
      } catch {
        // Skip unreadable files
      }
    }

    return { results, filesScanned, bytesRead };
  }

  private collectFiles(dir: string, fileGlob?: string): string[] {
    const files: string[] = [];
    const ignoreDirs = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      '.agents',
      'eval-baselines',
      '.gemini',
      '.next',
      '.turbo',
      'coverage',
      '.cache',
    ]);

    const globRegex = fileGlob ? this.globToRegex(fileGlob) : null;

    const traverse = (currentDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!ignoreDirs.has(entry.name) && !entry.name.startsWith('.')) {
            traverse(path.join(currentDir, entry.name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (this.allowedExtensions && !this.allowedExtensions.has(ext)) {
            continue;
          }

          const fullPath = path.join(currentDir, entry.name);
          const relPath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');

          if (globRegex) {
            if (globRegex.test(relPath) || globRegex.test(entry.name)) {
              files.push(fullPath);
            }
          } else {
            files.push(fullPath);
          }
        }
      }
    };

    traverse(dir);
    return files;
  }

  private globToRegex(glob: string): RegExp {
    let pattern = '';
    let i = 0;
    while (i < glob.length) {
      const char = glob[i];
      if (char === '*') {
        if (glob[i + 1] === '*') {
          pattern += '.*';
          i += 2;
        } else {
          pattern += '.*';
          i += 1;
        }
      } else if (char === '?') {
        pattern += '.';
        i += 1;
      } else if (['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'].includes(char)) {
        pattern += '\\' + char;
        i += 1;
      } else {
        pattern += char;
        i += 1;
      }
    }
    return new RegExp(`^${pattern}$`, 'i');
  }

  // =========================================================================
  // 4. RATE LIMITING & EXECUTION ENGINE
  // =========================================================================

  public async executeTool(
    personaId: string,
    turn: number,
    call: PiToolCallRequest | { name: string; arguments: Record<string, unknown> }
  ): Promise<PiToolCallResponse> {
    const startTime = Date.now();
    const callId = `call_${startTime}_${Math.random().toString(36).slice(2, 8)}`;
    const toolName = call.name || '';
    const args = (call.arguments || {}) as Record<string, any>;

    let session = this.personaTurns.get(personaId);
    if (!session) {
      session = { currentTurn: turn, callsInCurrentTurn: 0, totalCalls: 0 };
      this.personaTurns.set(personaId, session);
    }

    if (turn !== session.currentTurn) {
      session.currentTurn = turn;
      session.callsInCurrentTurn = 0;
    }

    if (session.currentTurn > this.maxTurnsPerSession) {
      const rateLimitOutput = `[RATE_LIMIT_EXCEEDED]: Maximum turns (${this.maxTurnsPerSession}) reached for persona session.`;
      const receipt: PiToolReceipt = {
        callId,
        personaId,
        turn,
        toolName,
        args,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        bytesRead: 0,
        filesScanned: 0,
        resultCount: 0,
        status: 'rate_limited',
        error: 'Max turns exceeded',
        estimatedPromptTokens: this.estimateTokens(JSON.stringify(call)),
        estimatedCompletionTokens: this.estimateTokens(rateLimitOutput),
      };
      this.receipts.push(receipt);
      return {
        callId,
        tool: toolName,
        status: 'rate_limited',
        output: rateLimitOutput,
        durationMs: receipt.durationMs,
        bytesRead: 0,
        tokenEstimate: receipt.estimatedPromptTokens + receipt.estimatedCompletionTokens,
        error: 'Max turns exceeded',
      };
    }

    session.callsInCurrentTurn++;
    session.totalCalls++;

    if (session.callsInCurrentTurn > this.maxToolCallsPerTurn) {
      const rateLimitOutput = `[RATE_LIMIT_EXCEEDED]: Maximum ${this.maxToolCallsPerTurn} tool calls per turn exceeded. Call ${session.callsInCurrentTurn} (${toolName}) was deferred. Review the first ${this.maxToolCallsPerTurn} results and issue further requests in the next turn.`;
      const receipt: PiToolReceipt = {
        callId,
        personaId,
        turn,
        toolName,
        args,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        bytesRead: 0,
        filesScanned: 0,
        resultCount: 0,
        status: 'rate_limited',
        error: 'Rate limit exceeded',
        estimatedPromptTokens: this.estimateTokens(JSON.stringify(call)),
        estimatedCompletionTokens: this.estimateTokens(rateLimitOutput),
      };
      this.receipts.push(receipt);
      return {
        callId,
        tool: toolName,
        status: 'rate_limited',
        output: rateLimitOutput,
        durationMs: receipt.durationMs,
        bytesRead: 0,
        tokenEstimate: receipt.estimatedPromptTokens + receipt.estimatedCompletionTokens,
        error: 'Rate limit exceeded',
      };
    }

    const normTool = toolName.toLowerCase().replace(/[\s-]+/g, '_');
    let output = '';
    let bytesRead = 0;
    let filesScanned = 0;
    let resultCount = 0;
    let status: 'success' | 'rate_limited' | 'error' | 'timeout' = 'success';
    let errorMessage: string | undefined;

    try {
      switch (normTool) {
        case 'pi.fs.readfile':
        case 'file_read':
        case 'read_file':
        case 'view_file':
        case 'readfile': {
          const filePath = args.path || args.filePath || args.file || args.targetFile;
          if (!filePath) {
            output = 'Error: Missing "path" argument for file read tool.';
            status = 'error';
            errorMessage = 'Missing path argument';
            break;
          }
          const startLine = args.startLine ?? args.start_line ?? args.start;
          const endLine = args.endLine ?? args.end_line ?? args.end;
          const maxBytes = args.maxBytes ?? args.max_bytes;

          const res = await this.readFile(
            String(filePath),
            startLine !== undefined ? Number(startLine) : undefined,
            endLine !== undefined ? Number(endLine) : undefined,
            maxBytes !== undefined ? Number(maxBytes) : undefined
          );
          output = res.output;
          bytesRead = res.bytesRead;
          filesScanned = 1;
          resultCount = 1;
          break;
        }

        case 'pi.code.search':
        case 'code_search':
        case 'grep_search':
        case 'search_code':
        case 'search': {
          const query = args.query || args.pattern || args.search || args.q || '';
          if (!query) {
            output = 'Error: Missing "query" argument for code search tool.';
            status = 'error';
            errorMessage = 'Missing query argument';
            break;
          }
          const dir = args.dir || args.directory || args.path || '.';
          const fileGlob = args.fileGlob || args.file_glob || args.glob || args.pathFilter;
          const maxResults = args.maxResults ?? args.max_results ?? 25;
          const caseSensitive = Boolean(args.caseSensitive ?? args.case_sensitive ?? false);

          const res = await this.codeSearch(
            String(query),
            String(dir),
            fileGlob ? String(fileGlob) : undefined,
            Number(maxResults),
            caseSensitive
          );
          bytesRead = res.bytesRead;
          filesScanned = res.filesScanned;
          resultCount = res.results.length;

          if (res.results.length === 0) {
            output = `No matches found for query "${query}" in workspace.`;
          } else {
            output = res.results.map((r) => `${r.path}:${r.line}: ${r.match}`).join('\n');
          }
          break;
        }

        case 'pi.symbol.lookup':
        case 'symbol_lookup':
        case 'symbol_search':
        case 'ast_lookup':
        case 'lookup_symbol': {
          const symbol = args.symbol || args.symbolName || args.symbol_name || args.name || '';
          if (!symbol) {
            output = 'Error: Missing "symbol" argument for symbol lookup tool.';
            status = 'error';
            errorMessage = 'Missing symbol argument';
            break;
          }
          const kind = args.kind || args.type || args.symbolKind;
          const maxResults = args.maxResults ?? args.max_results ?? 25;

          const res = await this.symbolLookup(
            String(symbol),
            kind ? String(kind) : undefined,
            Number(maxResults)
          );
          bytesRead = res.bytesRead;
          filesScanned = res.filesScanned;
          resultCount = res.results.length;

          if (res.results.length === 0) {
            output = `No symbol definitions found for "${symbol}" in workspace.`;
          } else {
            output = res.results
              .map((s) => `${s.path}:${s.line} [${s.kind}] ${s.signature}`)
              .join('\n');
          }
          break;
        }

        default: {
          output = `Error: Unknown tool "${toolName}". Available tools: pi.fs.readFile, pi.code.search, pi.symbol.lookup.`;
          status = 'error';
          errorMessage = `Unknown tool ${toolName}`;
          break;
        }
      }
    } catch (err: any) {
      if (err instanceof PiVfsSecurityError) {
        output = `Security Error: ${err.message}`;
        status = 'error';
        errorMessage = err.message;
      } else {
        output = `Execution Error: ${err.message || String(err)}`;
        status = 'error';
        errorMessage = err.message || String(err);
      }
    }

    const endTime = Date.now();
    const durationMs = Math.max(1, endTime - startTime);
    const estimatedPromptTokens = this.estimateTokens(JSON.stringify(call));
    const estimatedCompletionTokens = this.estimateTokens(output);

    const receipt: PiToolReceipt = {
      callId,
      personaId,
      turn,
      toolName,
      args,
      startTime,
      endTime,
      durationMs,
      bytesRead,
      filesScanned,
      resultCount,
      status,
      error: errorMessage,
      estimatedPromptTokens,
      estimatedCompletionTokens,
    };
    this.receipts.push(receipt);

    return {
      callId,
      tool: toolName,
      status,
      output,
      durationMs,
      bytesRead,
      tokenEstimate: estimatedPromptTokens + estimatedCompletionTokens,
      error: errorMessage,
    };
  }

  public async executeTurnBatch(
    personaId: string,
    turn: number,
    calls: Array<PiToolCallRequest | { name: string; arguments: Record<string, unknown> }>
  ): Promise<PiToolCallResponse[]> {
    const responses: PiToolCallResponse[] = [];
    for (const call of calls) {
      const resp = await this.executeTool(personaId, turn, call);
      responses.push(resp);
    }
    return responses;
  }

  public getSessionMetrics(personaId?: string): PiSessionMetrics {
    const relevantReceipts = personaId
      ? this.receipts.filter((r) => r.personaId === personaId)
      : this.receipts;

    let totalBytesRead = 0;
    let totalFilesScanned = 0;
    let totalToolDurationMs = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let successfulToolCalls = 0;
    let rateLimitedCalls = 0;
    let errorCalls = 0;

    for (const r of relevantReceipts) {
      totalBytesRead += r.bytesRead;
      totalFilesScanned += r.filesScanned;
      totalToolDurationMs += r.durationMs;
      totalPromptTokens += r.estimatedPromptTokens;
      totalCompletionTokens += r.estimatedCompletionTokens;

      if (r.status === 'success') successfulToolCalls++;
      else if (r.status === 'rate_limited') rateLimitedCalls++;
      else if (r.status === 'error' || r.status === 'timeout') errorCalls++;
    }

    const totalCostUSD =
      (totalPromptTokens / 1000) * this.modelCostPer1kPrompt +
      (totalCompletionTokens / 1000) * this.modelCostPer1kCompletion;

    return {
      totalToolCalls: relevantReceipts.length,
      successfulToolCalls,
      rateLimitedCalls,
      errorCalls,
      totalBytesRead,
      totalFilesScanned,
      totalToolDurationMs,
      totalPromptTokens,
      totalCompletionTokens,
      totalCostUSD,
      receipts: [...relevantReceipts],
    };
  }

  public resetSession(personaId?: string): void {
    if (personaId) {
      this.personaTurns.delete(personaId);
      this.receipts = this.receipts.filter((r) => r.personaId !== personaId);
    } else {
      this.personaTurns.clear();
      this.receipts = [];
    }
  }

  public resetTurn(personaId: string): void {
    const session = this.personaTurns.get(personaId);
    if (session) {
      session.callsInCurrentTurn = 0;
    }
  }

  public createTurnHistoryManager(personaId: string, options?: TurnHistoryManagerOptions): TurnHistoryManager {
    return new TurnHistoryManager(options);
  }

  private estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 3.8);
  }
}

// =========================================================================
// FACTORY FUNCTION
// =========================================================================

export function createPiWorkspacePlugin(config: PiPluginConfig): PiWorkspacePlugin {
  return new PiWorkspacePluginImpl(config);
}
