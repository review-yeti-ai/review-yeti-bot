import fs from 'node:fs';
import path from 'node:path';
import { PreChecksAnalyzersConfig } from '../config/schema';
import { SandboxRunner, SandboxCommandResult } from '../fix/sandboxRunner';

// ============================================================================
// Data Contracts (per PROJECT.md & SYNTHESIS_M4.md)
// ============================================================================

export type AnalyzerName =
  | 'eslint'
  | 'semgrep'
  | 'gitleaks'
  | 'credo'
  | 'sobelow'
  | 'govet'
  | string;

export type AnalyzerCategory = 'linter' | 'security' | 'secrets';
export type AnalyzerSeverity = 'info' | 'warning' | 'error' | 'critical';
export type AnalyzerConfidence = 'low' | 'medium' | 'high';

export interface CandidateHypothesis {
  /** Unique deterministic identifier: hyp:<analyzer>:<ruleId>:<path>:<line> */
  id: string;
  analyzer: AnalyzerName;
  category: AnalyzerCategory;
  ruleId: string;
  path: string;
  line: number;
  endLine?: number;
  column?: number;
  message: string;
  severity: AnalyzerSeverity;
  confidence: AnalyzerConfidence;
  snippet?: string;
  rawDetails?: string | Record<string, unknown>;
}

export interface PreCheckAnalyzerReceipt {
  tool: string;
  category: AnalyzerCategory;
  available: boolean;
  exitStatus: number | 'timeout' | 'error' | 'not_installed';
  durationMs: number;
  hypotheses: CandidateHypothesis[];
  error?: string;
  filesScanned?: number;
  hypothesesCount?: number;
  command?: string;
}

export interface PreCheckSummary {
  enabled: boolean;
  analyzersExecuted: number;
  hypothesesCount: number;
  receipts: PreCheckAnalyzerReceipt[];
  hypotheses: CandidateHypothesis[];
  status?: 'ok' | 'unavailable' | 'disabled' | 'clean' | 'error';
  reason?: string;
  durationMs?: number;
}

export type AnalyzersPreCheckResult = PreCheckSummary;
export type PreCheckAnalyzersResult = PreCheckSummary;

export interface CommandExecutionResult {
  command: string;
  args: string[];
  exitStatus: number | 'timeout' | 'error' | 'not_installed';
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface AnalyzerExecutionOptions {
  workspaceRoot: string;
  timeoutMs?: number;
  maxBytes?: number;
  sandboxRunner?: SandboxRunner;
  spawnImpl?: any;
  customExecutable?: string;
  signal?: AbortSignal;
}

export interface AnalyzerRunnerOptions {
  workspaceRoot: string;
  changedFiles: Array<{ path: string; patch?: string; content?: string; status?: string }> | string[];
  config?: PreChecksAnalyzersConfig | Partial<PreChecksAnalyzersConfig>;
  sandboxRunner?: SandboxRunner;
  spawnImpl?: any;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  customExecutables?: Partial<Record<string, string>>;
}

export type RunPreCheckAnalyzersOptions = AnalyzerRunnerOptions;

// ============================================================================
// Ecosystem & File Scoping Rules
// ============================================================================

export function normalizeRepoPath(filePath: string, workspaceRoot: string = ''): string {
  if (!filePath || typeof filePath !== 'string') return '';
  let p = filePath.replace(/\\/g, '/');
  if (workspaceRoot) {
    const normRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.startsWith(normRoot + '/')) {
      p = p.slice(normRoot.length + 1);
    } else if (p === normRoot) {
      p = '';
    }
  }
  return p.replace(/^\.?\/+/, '');
}

export function maskSecret(secret?: string): string {
  if (!secret || typeof secret !== 'string') return '***';
  const trimmed = secret.trim();
  if (trimmed.length <= 6) return '***';
  if (trimmed.length <= 12) return `${trimmed.slice(0, 2)}****${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp', '.tiff',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.iso',
  '.pyc', '.pyo', '.class', '.o', '.a',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.wasm',
]);

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ELIXIR_EXTENSIONS = new Set(['.ex', '.exs']);
const GO_EXTENSIONS = new Set(['.go']);

export function getApplicableAnalyzers(
  filePath: string,
  config?: Partial<PreChecksAnalyzersConfig> & { heavy_compilers?: boolean }
): string[] {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return [];

  const linters = config?.linters !== false;
  const security = config?.security !== false;
  const secrets = config?.secrets !== false;
  const heavyCompilers = (config as any)?.heavy_compilers === true;

  const tools: string[] = [];

  if (heavyCompilers) {
    // Heavy compiler mode: requires compilation toolchains and dependency graphs
    if (TS_JS_EXTENSIONS.has(ext)) {
      if (linters) tools.push('eslint');
      if (security) tools.push('semgrep');
    } else if (ELIXIR_EXTENSIONS.has(ext)) {
      if (linters) tools.push('credo');
      if (security) tools.push('sobelow');
    } else if (GO_EXTENSIONS.has(ext)) {
      if (linters) tools.push('govet');
      if (security) tools.push('semgrep');
    }
  } else {
    // Zero-Compilation Pattern (Default):
    // Fast AST & structural pattern matching (semgrep, gitleaks, eslint) without
    // running compilers (`go vet`, `mix credo`, `mix sobelow`) in cold review containers.
    if (TS_JS_EXTENSIONS.has(ext)) {
      if (linters) tools.push('eslint');
      if (security) tools.push('semgrep');
    } else if (ELIXIR_EXTENSIONS.has(ext)) {
      if (security) tools.push('semgrep');
    } else if (GO_EXTENSIONS.has(ext)) {
      if (security) tools.push('semgrep');
    } else if (['.py', '.rs', '.rb', '.java', '.c', '.cpp', '.cs', '.php'].includes(ext)) {
      if (security) tools.push('semgrep');
    }
  }

  if (secrets) {
    tools.push('gitleaks');
  }

  return tools;
}

// ============================================================================
// Low-Level Process & Sandbox Execution
// ============================================================================

const SANDBOX_ENV_ALLOWLIST = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HOME',
  'USERPROFILE',
  'XDG_RUNTIME_DIR',
] as const;

function createSandboxEnvironment(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    CI: '1',
    CT_REVIEW_SANDBOX: '1',
    NODE_ENV: 'production',
  };
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return env as NodeJS.ProcessEnv;
}

function terminateProcessGroup(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  try {
    child.kill(signal);
  } catch {}
}

export class DefaultSandboxRunner implements SandboxRunner {
  async run(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number; maxBytes?: number } = {}
  ): Promise<SandboxCommandResult> {
    const { spawn } = await import('node:child_process');
    const maxBytes = options.maxBytes ?? 500_000;
    const timeoutMs = options.timeoutMs ?? 15_000;

    return new Promise((resolve) => {
      let child: any;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          shell: false,
          detached: process.platform !== 'win32',
          env: createSandboxEnvironment(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        return resolve({
          command,
          exitStatus: 'error',
          stdout: '',
          stderr: String(err?.message || err),
        });
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const finish = (exitStatus: number | 'timeout' | 'error'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve({ command, exitStatus, stdout, stderr });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup(child, 'SIGTERM');
        forceKillTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 250);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < maxBytes) {
          stdout += chunk.toString('utf8').slice(0, maxBytes - stdout.length);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < maxBytes) {
          stderr += chunk.toString('utf8').slice(0, maxBytes - stderr.length);
        }
      });

      child.on('close', (code: number | null) => finish(timedOut ? 'timeout' : (code ?? 1)));
      child.on('error', (err: any) => {
        if (err?.code === 'ENOENT' || String(err?.message).includes('ENOENT')) {
          stderr = `spawn ${command} ENOENT: binary not found in PATH`;
        }
        finish('error');
      });
    });
  }
}

export async function executeSandboxedCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    maxBytes?: number;
    sandboxRunner?: SandboxRunner;
    spawnImpl?: any;
    signal?: AbortSignal;
  }
): Promise<CommandExecutionResult> {
  const runner = options.sandboxRunner || new DefaultSandboxRunner();
  const startTime = Date.now();

  const res = await runner.run(command, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 15_000,
    maxBytes: options.maxBytes ?? 500_000,
  });

  const durationMs = Date.now() - startTime;
  let exitStatus: number | 'timeout' | 'error' | 'not_installed' = res.exitStatus;

  const combinedOutput = `${res.stderr} ${res.stdout}`;
  if (res.exitStatus === 'error' && /ENOENT|not found in PATH/i.test(combinedOutput)) {
    exitStatus = 'not_installed';
  }

  return {
    command,
    args,
    exitStatus,
    stdout: res.stdout,
    stderr: res.stderr,
    durationMs,
    error: exitStatus === 'not_installed' || exitStatus === 'error' ? (res.stderr || 'Execution failed') : undefined,
  };
}

// ============================================================================
// Output Parsers for Analyzers
// ============================================================================

export function parseEslintOutput(rawOutput: string | unknown, workspaceRoot: string = ''): CandidateHypothesis[] {
  let data: any;
  try {
    data = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput;
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const hypotheses: CandidateHypothesis[] = [];
  for (const fileReport of data) {
    if (!fileReport || !Array.isArray(fileReport.messages)) continue;
    const relPath = normalizeRepoPath(fileReport.filePath || '', workspaceRoot);

    for (const msg of fileReport.messages) {
      if (!msg) continue;
      const ruleId = msg.ruleId || 'eslint';
      const line = Math.max(1, Number(msg.line) || 1);
      const column = msg.column !== undefined && msg.column !== null ? Number(msg.column) : undefined;
      const endLine = msg.endLine !== undefined && msg.endLine !== null ? Number(msg.endLine) : undefined;
      const severity: AnalyzerSeverity = msg.severity === 2 ? 'error' : 'warning';

      const hyp: CandidateHypothesis = {
        id: `hyp:eslint:${ruleId}:${relPath}:${line}`,
        analyzer: 'eslint',
        category: 'linter',
        ruleId,
        path: relPath,
        line,
        message: msg.message || 'ESLint violation',
        severity,
        confidence: 'high',
      };
      if (endLine !== undefined) hyp.endLine = endLine;
      if (column !== undefined) hyp.column = column;
      if (msg.source) hyp.snippet = String(msg.source).trim();
      hypotheses.push(hyp);
    }
  }
  return hypotheses;
}

export function parseSemgrepOutput(rawOutput: string | unknown, workspaceRoot: string = ''): CandidateHypothesis[] {
  let data: any;
  try {
    data = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput;
  } catch {
    return [];
  }
  const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
  const hypotheses: CandidateHypothesis[] = [];

  const SECURITY_REGEX = /security|audit|vuln|cwe|owasp|injection|xss|csrf|crypto|auth|ssrf|rce|cors|traversal|sqli/i;

  for (const item of results) {
    if (!item) continue;
    const ruleId = item.check_id || 'semgrep';
    const relPath = normalizeRepoPath(item.path || '', workspaceRoot);
    const line = Math.max(1, Number(item.start?.line) || 1);
    const endLine = item.end?.line !== undefined ? Number(item.end.line) : undefined;
    const column = item.start?.col !== undefined ? Number(item.start.col) : undefined;

    const isSecurity = Boolean(
      item.extra?.metadata?.owasp ||
      item.extra?.metadata?.cwe ||
      item.extra?.metadata?.category === 'security' ||
      SECURITY_REGEX.test(ruleId)
    );

    const rawSev = String(item.extra?.severity || 'WARNING').toUpperCase();
    let severity: AnalyzerSeverity = 'warning';
    if (rawSev === 'ERROR') {
      severity = 'error';
    } else if (rawSev === 'INFO') {
      severity = 'info';
    }

    const rawConf = String(item.extra?.metadata?.confidence || 'MEDIUM').toUpperCase();
    let confidence: AnalyzerConfidence = 'medium';
    if (rawConf === 'HIGH') confidence = 'high';
    else if (rawConf === 'LOW') confidence = 'low';

    const hyp: CandidateHypothesis = {
      id: `hyp:semgrep:${ruleId}:${relPath}:${line}`,
      analyzer: 'semgrep',
      category: isSecurity ? 'security' : 'linter',
      ruleId,
      path: relPath,
      line,
      message: item.extra?.message || ruleId,
      severity,
      confidence,
    };
    if (endLine !== undefined) hyp.endLine = endLine;
    if (column !== undefined) hyp.column = column;
    if (item.extra?.lines) hyp.snippet = String(item.extra.lines).trim();
    hypotheses.push(hyp);
  }
  return hypotheses;
}

export function parseCredoOutput(rawOutput: string | unknown, workspaceRoot: string = ''): CandidateHypothesis[] {
  let data: any;
  try {
    data = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput;
  } catch {
    return [];
  }
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const hypotheses: CandidateHypothesis[] = [];

  for (const issue of issues) {
    if (!issue) continue;
    const ruleId = String(issue.check || 'Credo.Check.General');
    const relPath = normalizeRepoPath(issue.filename || '', workspaceRoot);
    const line = Math.max(1, Number(issue.line_no) || 1);
    const column = issue.column !== undefined && issue.column !== null ? Number(issue.column) : undefined;

    let severity: AnalyzerSeverity = 'warning';
    const cat = String(issue.category || '').toLowerCase();
    if (cat === 'warning') {
      severity = 'warning';
    } else if (cat === 'refactor' || cat === 'readability' || cat === 'design' || cat === 'consistency') {
      severity = 'info';
    } else if (cat === 'error') {
      severity = 'error';
    }

    const hyp: CandidateHypothesis = {
      id: `hyp:credo:${ruleId}:${relPath}:${line}`,
      analyzer: 'credo',
      category: 'linter',
      ruleId,
      path: relPath,
      line,
      message: issue.message || ruleId,
      severity,
      confidence: 'medium',
    };
    if (column !== undefined) hyp.column = column;
    if (issue.trigger) hyp.snippet = String(issue.trigger).trim();
    hypotheses.push(hyp);
  }
  return hypotheses;
}

export function parseSobelowOutput(rawOutput: string | unknown, workspaceRoot: string = ''): CandidateHypothesis[] {
  let data: any;
  try {
    data = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput;
  } catch {
    return [];
  }
  const findingsMap =
    data?.findings && typeof data.findings === 'object'
      ? data.findings
      : data && typeof data === 'object'
      ? data
      : {};
  const hypotheses: CandidateHypothesis[] = [];

  for (const [categoryKey, findings] of Object.entries(findingsMap)) {
    if (!Array.isArray(findings)) continue;
    for (const item of findings) {
      if (!item) continue;
      const vulnType = String(item.vuln_type || categoryKey || 'sobelow_finding');
      const ruleId = vulnType;
      const relPath = normalizeRepoPath(item.file || item.filename || '', workspaceRoot);
      const line = Math.max(1, Number(item.line) || 1);

      let message = item.type || `Sobelow ${vulnType} vulnerability detected`;
      if (item.fun_name && item.variable) {
        message = `${item.type} in ${item.fun_name} (${item.variable})`;
      } else if (item.fun_name) {
        message = `${item.type} in ${item.fun_name}`;
      } else if (item.variable) {
        message = `${item.type} (${item.variable})`;
      }

      const rawConf = String(item.confidence || 'medium').toLowerCase();
      let confidence: AnalyzerConfidence = 'medium';
      if (rawConf === 'high') confidence = 'high';
      else if (rawConf === 'low') confidence = 'low';

      const hyp: CandidateHypothesis = {
        id: `hyp:sobelow:${ruleId}:${relPath}:${line}`,
        analyzer: 'sobelow',
        category: 'security',
        ruleId,
        path: relPath,
        line,
        message,
        severity: 'error',
        confidence,
      };
      if (item.column !== undefined) hyp.column = Number(item.column);
      hypotheses.push(hyp);
    }
  }
  return hypotheses;
}

export function extractTopLevelJsonObjects(text: string): any[] {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch {
      // Fall through to balanced brace scanner if direct parse fails (e.g. concatenated objects)
    }
  }

  const results: any[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let startIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (char === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          const candidate = text.slice(startIndex, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') {
              results.push(parsed);
            }
          } catch {
            // Ignore invalid JSON slices
          }
          startIndex = -1;
        }
      }
    }
  }

  return results;
}

export function parseGovetOutput(
  rawInput: string | { stdout?: string; stderr?: string } | unknown,
  workspaceRoot: string = ''
): CandidateHypothesis[] {
  const jsonObjects: any[] = [];

  if (typeof rawInput === 'object' && rawInput !== null && ('stderr' in rawInput || 'stdout' in rawInput)) {
    const composite = rawInput as { stdout?: string; stderr?: string };
    if (composite.stderr && typeof composite.stderr === 'string') {
      jsonObjects.push(...extractTopLevelJsonObjects(composite.stderr));
    }
    if (composite.stdout && typeof composite.stdout === 'string') {
      jsonObjects.push(...extractTopLevelJsonObjects(composite.stdout));
    }
  } else if (typeof rawInput === 'string') {
    jsonObjects.push(...extractTopLevelJsonObjects(rawInput));
  } else if (rawInput && typeof rawInput === 'object') {
    if (Array.isArray(rawInput)) {
      jsonObjects.push(...rawInput);
    } else {
      jsonObjects.push(rawInput);
    }
  }

  if (jsonObjects.length === 0) return [];

  const hypotheses: CandidateHypothesis[] = [];
  const seenIds = new Set<string>();

  for (const data of jsonObjects) {
    if (!data || typeof data !== 'object') continue;

    for (const [pkgName, analyzerGroup] of Object.entries(data)) {
      if (!analyzerGroup || typeof analyzerGroup !== 'object') continue;

      for (const [analyzerName, diagList] of Object.entries(analyzerGroup as Record<string, unknown>)) {
        if (!Array.isArray(diagList)) continue;

        for (const diag of diagList) {
          if (!diag || !diag.posn) continue;

          const posnMatch = String(diag.posn).match(/^(.*?):(\d+)(?::(\d+))?$/);
          if (!posnMatch) continue;

          const rawFilePath = posnMatch[1];
          const line = Math.max(1, parseInt(posnMatch[2], 10));
          const column = posnMatch[3] ? parseInt(posnMatch[3], 10) : undefined;
          const relPath = normalizeRepoPath(rawFilePath, workspaceRoot);
          const ruleId = analyzerName;

          const id = `hyp:govet:${ruleId}:${relPath}:${line}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);

          const hyp: CandidateHypothesis = {
            id,
            analyzer: 'govet',
            category: 'linter',
            ruleId,
            path: relPath,
            line,
            message: diag.message || `go vet ${ruleId} diagnostic`,
            severity: 'warning',
            confidence: 'high',
          };
          if (column !== undefined) hyp.column = column;
          hypotheses.push(hyp);
        }
      }
    }
  }
  return hypotheses;
}

export function parseGitleaksOutput(rawOutput: string | unknown, workspaceRoot: string = ''): CandidateHypothesis[] {
  let data: any;
  try {
    data = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput;
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const hypotheses: CandidateHypothesis[] = [];
  for (const leak of data) {
    if (!leak) continue;
    const ruleId = leak.RuleID || 'secret';
    const relPath = normalizeRepoPath(leak.File || '', workspaceRoot);
    const line = Math.max(1, Number(leak.StartLine) || 1);
    const endLine = leak.EndLine !== undefined ? Number(leak.EndLine) : undefined;
    const column = leak.StartColumn !== undefined ? Number(leak.StartColumn) : undefined;

    const isGeneric = String(ruleId).toLowerCase().includes('generic');
    const confidence: AnalyzerConfidence = isGeneric ? 'medium' : 'high';

    const hyp: CandidateHypothesis = {
      id: `hyp:gitleaks:${ruleId}:${relPath}:${line}`,
      analyzer: 'gitleaks',
      category: 'secrets',
      ruleId,
      path: relPath,
      line,
      message: leak.Description || `Potential secret leaked matching rule '${ruleId}'`,
      severity: 'critical',
      confidence,
    };
    if (endLine !== undefined) hyp.endLine = endLine;
    if (column !== undefined) hyp.column = column;
    if (leak.Secret || leak.Match) {
      hyp.snippet = `Matched pattern: ${maskSecret(leak.Secret || leak.Match)}`;
    }
    hypotheses.push(hyp);
  }
  return hypotheses;
}

// ============================================================================
// Individual Analyzer Runners
// ============================================================================

export async function runEslint(files: string[], options: AnalyzerExecutionOptions): Promise<PreCheckAnalyzerReceipt> {
  const cmd = options.customExecutable || 'eslint';
  const args = ['--format', 'json', ...files];
  const res = await executeSandboxedCommand(cmd, args, {
    cwd: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    sandboxRunner: options.sandboxRunner,
    spawnImpl: options.spawnImpl,
    signal: options.signal,
  });

  return buildReceipt('eslint', 'linter', res, options.workspaceRoot, files.length, parseEslintOutput);
}

export async function runSemgrep(files: string[], options: AnalyzerExecutionOptions): Promise<PreCheckAnalyzerReceipt> {
  const cmd = options.customExecutable || 'semgrep';
  const args = ['scan', '--json', '--quiet', '--config', 'auto', ...files];
  const res = await executeSandboxedCommand(cmd, args, {
    cwd: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    sandboxRunner: options.sandboxRunner,
    spawnImpl: options.spawnImpl,
    signal: options.signal,
  });

  return buildReceipt('semgrep', 'security', res, options.workspaceRoot, files.length, parseSemgrepOutput);
}

export async function runCredo(files: string[], options: AnalyzerExecutionOptions): Promise<PreCheckAnalyzerReceipt> {
  const cmd = options.customExecutable || 'credo';
  const args = ['--strict', '--format=json', ...files];
  const res = await executeSandboxedCommand(cmd, args, {
    cwd: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    sandboxRunner: options.sandboxRunner,
    spawnImpl: options.spawnImpl,
    signal: options.signal,
  });

  return buildReceipt('credo', 'linter', res, options.workspaceRoot, files.length, parseCredoOutput);
}

export async function runSobelow(files: string[], options: AnalyzerExecutionOptions): Promise<PreCheckAnalyzerReceipt> {
  const cmd = options.customExecutable || 'sobelow';
  const args = ['--dry-run', '--format=json'];
  const res = await executeSandboxedCommand(cmd, args, {
    cwd: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    sandboxRunner: options.sandboxRunner,
    spawnImpl: options.spawnImpl,
    signal: options.signal,
  });

  return buildReceipt('sobelow', 'security', res, options.workspaceRoot, files.length, parseSobelowOutput);
}

export async function runGovet(files: string[], options: AnalyzerExecutionOptions): Promise<PreCheckAnalyzerReceipt> {
  const cmd = options.customExecutable || 'govet';
  const args = ['-json', ...files];
  const res = await executeSandboxedCommand(cmd, args, {
    cwd: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    sandboxRunner: options.sandboxRunner,
    spawnImpl: options.spawnImpl,
    signal: options.signal,
  });

  return buildReceipt('govet', 'linter', res, options.workspaceRoot, files.length, (out, root) =>
    parseGovetOutput({ stdout: res.stdout, stderr: res.stderr }, root)
  );
}

export async function runGitleaks(files: string[], options: AnalyzerExecutionOptions): Promise<PreCheckAnalyzerReceipt> {
  const cmd = options.customExecutable || 'gitleaks';
  const args = files.length === 1
    ? ['detect', '--no-git', '--source', files[0], '-r', '-', '-f', 'json', '--no-banner', '-l', 'error']
    : ['detect', '--no-git', '-r', '-', '-f', 'json', '--no-banner', '-l', 'error', ...files];
  const res = await executeSandboxedCommand(cmd, args, {
    cwd: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    sandboxRunner: options.sandboxRunner,
    spawnImpl: options.spawnImpl,
    signal: options.signal,
  });

  return buildReceipt('gitleaks', 'secrets', res, options.workspaceRoot, files.length, parseGitleaksOutput);
}

function buildReceipt(
  tool: string,
  category: AnalyzerCategory,
  res: CommandExecutionResult,
  workspaceRoot: string,
  filesScanned: number,
  parser: (output: string, root?: string) => CandidateHypothesis[]
): PreCheckAnalyzerReceipt {
  let exitStatus = res.exitStatus;
  let available = true;
  let hypotheses: CandidateHypothesis[] = [];
  let error = res.error;

  if (exitStatus === 'not_installed') {
    available = false;
    hypotheses = [];
  } else if (exitStatus === 'timeout') {
    available = true;
    hypotheses = [];
  } else if (exitStatus === 0 || exitStatus === 1) {
    try {
      hypotheses = parser(res.stdout, workspaceRoot);
      if (exitStatus === 1 && hypotheses.length === 0 && res.stderr && !res.stdout) {
        exitStatus = 'error';
        error = res.stderr;
      }
    } catch (err: any) {
      exitStatus = 'error';
      error = err?.message || 'Failed to parse analyzer output';
      hypotheses = [];
    }
  } else {
    exitStatus = 'error';
    error = res.stderr || res.stdout || 'Tool execution failed';
    hypotheses = [];
  }

  return {
    tool,
    category,
    available,
    exitStatus,
    durationMs: res.durationMs,
    filesScanned,
    hypothesesCount: hypotheses.length,
    hypotheses,
    error,
    command: res.command,
  };
}

// ============================================================================
// Main Pre-Check Orchestrator
// ============================================================================

export async function runPreCheckAnalyzers(options: AnalyzerRunnerOptions): Promise<PreCheckSummary> {
  const config = options.config ?? { enabled: true, linters: true, security: true, secrets: true };

  if (config.enabled === false) {
    return {
      enabled: false,
      analyzersExecuted: 0,
      hypothesesCount: 0,
      receipts: [],
      hypotheses: [],
      status: 'disabled',
    };
  }

  const rawFiles = options.changedFiles || [];
  const validFiles: string[] = [];

  for (const item of rawFiles) {
    let filePath = '';
    let isDeleted = false;
    if (typeof item === 'string') {
      filePath = item.trim();
    } else if (item && typeof item === 'object') {
      filePath = (item.path || '').trim();
      isDeleted = item.status === 'deleted';
    }
    if (!filePath || isDeleted) continue;

    // In live execution (no mock runner injected), verify file actually exists on disk
    if (!options.sandboxRunner && !options.spawnImpl) {
      const fullPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(options.workspaceRoot || process.cwd(), filePath);
      try {
        if (!fs.existsSync(fullPath)) {
          continue;
        }
      } catch {
        continue;
      }
    }

    validFiles.push(filePath);
  }

  if (validFiles.length === 0) {
    return {
      enabled: true,
      analyzersExecuted: 0,
      hypothesesCount: 0,
      receipts: [],
      hypotheses: [],
      status: 'clean',
    };
  }

  const startTime = Date.now();
  const fileMap = new Map<string, string[]>();
  for (const file of validFiles) {
    const applicable = getApplicableAnalyzers(file, config);
    for (const tool of applicable) {
      const list = fileMap.get(tool) || [];
      list.push(file);
      fileMap.set(tool, list);
    }
  }

  const receipts: PreCheckAnalyzerReceipt[] = [];
  const execOptions: AnalyzerExecutionOptions = {
    workspaceRoot: options.workspaceRoot,
    timeoutMs: options.timeoutMs ?? 15_000,
    maxBytes: options.maxBytes ?? 500_000,
    sandboxRunner: options.sandboxRunner,
    spawnImpl: options.spawnImpl,
    signal: options.signal,
  };

  // Run applicable tools sequentially inside review sandbox to protect memory bounds.
  if (fileMap.has('eslint')) {
    const files = fileMap.get('eslint')!;
    receipts.push(await runEslint(files, { ...execOptions, customExecutable: options.customExecutables?.eslint }));
  }
  if (fileMap.has('semgrep')) {
    const files = fileMap.get('semgrep')!;
    receipts.push(await runSemgrep(files, { ...execOptions, customExecutable: options.customExecutables?.semgrep }));
  }
  if (fileMap.has('credo')) {
    const files = fileMap.get('credo')!;
    receipts.push(await runCredo(files, { ...execOptions, customExecutable: options.customExecutables?.credo }));
  }
  if (fileMap.has('sobelow')) {
    const files = fileMap.get('sobelow')!;
    receipts.push(await runSobelow(files, { ...execOptions, customExecutable: options.customExecutables?.sobelow }));
  }
  if (fileMap.has('govet')) {
    const files = fileMap.get('govet')!;
    receipts.push(await runGovet(files, { ...execOptions, customExecutable: options.customExecutables?.govet }));
  }
  if (fileMap.has('gitleaks')) {
    const files = fileMap.get('gitleaks')!;
    receipts.push(await runGitleaks(files, { ...execOptions, customExecutable: options.customExecutables?.gitleaks }));
  }

  const allHypotheses = receipts.flatMap((r) => r.hypotheses);
  const totalDuration = Date.now() - startTime;

  return {
    enabled: true,
    analyzersExecuted: receipts.length,
    hypothesesCount: allHypotheses.length,
    receipts,
    hypotheses: allHypotheses,
    status: allHypotheses.length === 0 ? 'clean' : 'ok',
    durationMs: totalDuration,
  };
}

// ============================================================================
// Persona Lane Scoping & Filtering
// ============================================================================

export function filterHypothesesForPersona(options: {
  hypotheses: CandidateHypothesis[];
  personaId: string;
  charter: string;
  scopedFiles: Array<{ path: string; [key: string]: any }>;
}): CandidateHypothesis[] {
  const { hypotheses, personaId, charter, scopedFiles } = options;
  if (!hypotheses || hypotheses.length === 0 || scopedFiles.length === 0) {
    return [];
  }

  const pathScoped = hypotheses.filter((h) =>
    scopedFiles.some((f) => {
      const normH = normalizeRepoPath(h.path);
      const normF = normalizeRepoPath(f.path);
      return normH === normF || normH.endsWith('/' + normF) || normF.endsWith('/' + normH);
    })
  );

  const normalizedId = personaId.toLowerCase();
  const normalizedCharter = charter.toLowerCase();

  let laneFiltered: CandidateHypothesis[];

  if (normalizedId === 'sec-lane' || normalizedCharter.includes('security') || normalizedCharter.includes('owasp')) {
    laneFiltered = pathScoped.filter((h) => h.category === 'security' || h.category === 'secrets');
  } else if (normalizedId === 'qual-lane' || normalizedCharter.includes('consistency') || normalizedCharter.includes('code smell') || normalizedCharter.includes('readability')) {
    laneFiltered = pathScoped.filter((h) => h.category === 'linter');
  } else if (normalizedId === 'correctness-lane' || normalizedCharter.includes('correctness') || normalizedCharter.includes('race condition')) {
    laneFiltered = pathScoped.filter((h) => h.category === 'linter');
  } else if (normalizedId === 'db-lane' || normalizedCharter.includes('database') || normalizedCharter.includes('sql')) {
    laneFiltered = pathScoped.filter((h) =>
      h.category === 'security' && (h.ruleId.toLowerCase().includes('sql') || h.message.toLowerCase().includes('sql'))
    );
  } else if (normalizedId === 'devops-lane' || normalizedCharter.includes('devops')) {
    laneFiltered = pathScoped.filter((h) => h.category === 'secrets');
  } else {
    laneFiltered = pathScoped;
  }

  const categoryRank = (cat: AnalyzerCategory) => (cat === 'secrets' ? 0 : cat === 'security' ? 1 : 2);
  const severityRank = (sev: AnalyzerSeverity) => (sev === 'critical' ? 0 : sev === 'error' ? 1 : sev === 'warning' ? 2 : 3);
  const confidenceRank = (conf: AnalyzerConfidence) => (conf === 'high' ? 0 : conf === 'medium' ? 1 : 2);

  laneFiltered.sort((a, b) => {
    const catDiff = categoryRank(a.category) - categoryRank(b.category);
    if (catDiff !== 0) return catDiff;
    const sevDiff = severityRank(a.severity) - severityRank(b.severity);
    if (sevDiff !== 0) return sevDiff;
    const confDiff = confidenceRank(a.confidence) - confidenceRank(b.confidence);
    if (confDiff !== 0) return confDiff;
    return a.id.localeCompare(b.id);
  });

  return laneFiltered.slice(0, 20);
}

// ============================================================================
// Persona Prompt Formatting
// ============================================================================

export function formatCandidateHypothesesPrompt(
  input: CandidateHypothesis[] | PreCheckSummary | AnalyzersPreCheckResult | null | undefined
): string {
  if (!input) return '';

  let hypotheses: CandidateHypothesis[] = [];
  let status: string | undefined;
  let enabled: boolean | undefined;

  if (Array.isArray(input)) {
    hypotheses = input;
  } else if (typeof input === 'object') {
    hypotheses = Array.isArray(input.hypotheses) ? input.hypotheses : [];
    status = (input as any).status;
    enabled = (input as any).enabled;
  }

  if (enabled === false || status === 'disabled') {
    return '';
  }

  if (hypotheses.length === 0) {
    if (status === 'unavailable') {
      return [
        `=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK ===`,
        `[Status: unavailable]`,
        `Deterministic analyzers are unavailable in this environment. Rely on manual diff inspection.`,
      ].join('\n');
    }
    if (status === 'clean') {
      return [
        `=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK ===`,
        `[Status: clean]`,
        `Deterministic static analyzers executed on modified files with 0 candidate hypotheses detected.`,
      ].join('\n');
    }
    return '';
  }

  const lines = [
    `=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES (UNVERIFIED) ===`,
    `The review sandbox executed static analyzers on modified files in your scope.`,
    `Automated tools generated the following candidate hypotheses:`,
    ``,
    `Verify or refute each hypothesis during your review turns:`,
    `- Inspect the surrounding code context to verify if the defect is real.`,
    `- Do NOT publish raw hypotheses directly without verifying them.`,
    `- If verified: Formulate a validated finding citing the exact line, explaining the defect, and providing a replacement fix.`,
    `- If refuted (false positive, test mock, intentional design): Silently discard without posting.`,
    ``,
  ];

  for (const h of hypotheses) {
    lines.push(`- [HYPOTHESIS ${h.id}] (${h.analyzer} | ${h.severity.toUpperCase()} | ${h.confidence} confidence)`);
    lines.push(`  - Target: ${h.path}:${h.line}`);
    lines.push(`  - Rule: ${h.ruleId}`);
    lines.push(`  - Diagnostic: ${h.message}`);
    if (h.snippet) {
      lines.push(`  - Context: ${h.snippet}`);
    }
    lines.push(``);
  }

  return lines.join('\n').trim();
}

export const formatCandidateHypothesesEvidence = formatCandidateHypothesesPrompt;
