import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { filterDiffHunks, ChangedFile } from '../pipeline/hunkFilter';
import type { ReviewModelClient } from '../gateway/openRouterClient';

export type PreCommitSeverity = 'P0' | 'P1' | 'P2';

export interface PreCommitFinding {
  severity: PreCommitSeverity;
  rule: string;
  filePath: string;
  lineNumber?: number;
  match?: string;
  message: string;
  suggestion?: string;
}

export interface PreCommitResult {
  exitCode: number;
  findings: PreCommitFinding[];
  scannedFilesCount: number;
  ignoredFilesCount: number;
  durationMs: number;
  clean: boolean;
}

export interface PreCommitOptions {
  diff?: string;
  files?: ChangedFile[];
  strict?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  json?: boolean;
  model?: string;
  modelClient?: ReviewModelClient;
  cwd?: string;
  gitConfigGlobalDevNull?: boolean;
}

export interface InstallHookOptions {
  repoRoot?: string;
  husky?: boolean;
  hookPath?: string;
}

export interface InstallHookResult {
  success: boolean;
  hookPath: string;
  message: string;
}

export interface SecretPattern {
  name: string;
  regex: RegExp;
  description: string;
  suggestion?: string;
}

/**
 * High-speed regex patterns for detecting leaked credentials.
 * Pre-compiled for sub-10ms static scanning.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'AWS Access Key',
    // Must match valid AKIA keys but reject all-zeros mocks
    regex: /AKIA(?!0{16})[0-9A-Z]{16}/,
    description: 'AWS Access Key ID detected in staged changes',
    suggestion: 'Use environment variables (AWS_ACCESS_KEY_ID) or AWS IAM roles instead of hardcoding credentials.',
  },
  {
    name: 'GitHub Token',
    regex: /(?:ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})/,
    description: 'GitHub Personal Access Token detected in staged changes',
    suggestion: 'Use GITHUB_TOKEN environment variable or secrets manager.',
  },
  {
    name: 'RSA Private Key',
    regex: /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
    description: 'Private encryption key detected in staged changes',
    suggestion: 'Never commit private keys. Store in secure secret management or vault.',
  },
  {
    name: 'Generic Private Key',
    regex: /-----BEGIN (?:OPENSSH|EC|DSA) PRIVATE KEY-----/,
    description: 'Cryptographic private key detected in staged changes',
    suggestion: 'Remove private keys from source control immediately.',
  },
  {
    name: 'Slack Token',
    regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/,
    description: 'Slack API Token detected in staged changes',
    suggestion: 'Store Slack credentials in environment variables.',
  },
  {
    name: 'OpenAI API Key',
    regex: /sk-[a-zA-Z0-9]{32,48}/,
    description: 'OpenAI API Key detected in staged changes',
    suggestion: 'Store API keys in .env or secrets manager.',
  },
];

/**
 * Format verdict with terminal ANSI styling. Respects NO_COLOR.
 */
export function formatVerdict(severity: PreCommitSeverity, message: string, useColor = true): string {
  if (!useColor) return `[${severity}] ${message}`;
  const colors: Record<PreCommitSeverity, string> = {
    P0: '\x1b[1;31m', // Bold Red
    P1: '\x1b[1;33m', // Bold Yellow
    P2: '\x1b[36m',   // Cyan
  };
  const reset = '\x1b[0m';
  return `${colors[severity]}[${severity}]${reset} ${message}`;
}

/**
 * Evaluates the exit code based on findings and strict mode flag.
 * Blocking P0 always yields 1.
 * P1 yields 1 only if strict is true.
 */
export function evaluateExitCode(findings: Array<{ severity: string }>, strict = false): number {
  const hasP0 = findings.some((f) => f.severity === 'P0');
  if (hasP0) return 1;
  const hasP1 = findings.some((f) => f.severity === 'P1');
  if (hasP1 && strict) return 1;
  return 0;
}

/**
 * Parses unified git diff text into structured ChangedFile items.
 */
export function parseUnifiedDiff(diffText: string): ChangedFile[] {
  if (!diffText || !diffText.trim()) {
    return [];
  }

  const files: ChangedFile[] = [];
  const rawSections = diffText.split(/^diff --git /m);

  for (const section of rawSections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Extract path from diff header
    // e.g. "a/src/file.ts b/src/file.ts"
    const headerLine = trimmed.split('\n')[0] || '';
    let filePath = '';

    const bPathMatch = headerLine.match(/\s+b\/(.+)$/);
    if (bPathMatch) {
      filePath = bPathMatch[1];
    } else {
      const plusMatch = trimmed.match(/^\+\+\+ b\/(.+)$/m);
      if (plusMatch) {
        filePath = plusMatch[1];
      } else {
        const minusMatch = trimmed.match(/^--- a\/(.+)$/m);
        if (minusMatch) {
          filePath = minusMatch[1];
        }
      }
    }

    if (!filePath) {
      continue;
    }

    // Isolate patch content starting from first hunk header @@
    const hunkIndex = trimmed.search(/^@@/m);
    const patch = hunkIndex >= 0 ? trimmed.substring(hunkIndex) : trimmed;

    files.push({
      path: filePath,
      patch,
    });
  }

  return files;
}

/**
 * Extracts staged git changes using `git diff --cached`.
 */
export function getStagedDiff(cwd?: string, gitConfigGlobalDevNull = true): string {
  try {
    const env = { ...process.env };
    if (gitConfigGlobalDevNull) {
      env.GIT_CONFIG_GLOBAL = '/dev/null';
    }

    const output = execSync('git diff --cached --unified=3', {
      cwd: cwd || process.cwd(),
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });

    return output.toString();
  } catch (err: any) {
    // If not a git repository or git fails, return empty or rethrow if fatal
    if (err.stderr && err.stderr.toString().includes('not a git repository')) {
      return '';
    }
    return '';
  }
}

/**
 * Static pre-flight security scanner.
 * Evaluates added lines in diff hunks for leaked credentials in < 10ms.
 */
export function scanDiffForCredentials(diffText: string, filePath = 'staged'): PreCommitFinding[] {
  const findings: PreCommitFinding[] = [];
  if (!diffText) return findings;

  const lines = diffText.split(/\r?\n/);
  let currentNewLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkHeader) {
      currentNewLine = parseInt(hunkHeader[1], 10);
      inHunk = true;
      continue;
    }

    if (inHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const addedContent = line.substring(1);

        for (const pattern of SECRET_PATTERNS) {
          const match = addedContent.match(pattern.regex);
          if (match) {
            findings.push({
              severity: 'P0',
              rule: pattern.name,
              filePath,
              lineNumber: currentNewLine,
              match: match[0],
              message: `Critical credential leak: ${pattern.description}`,
              suggestion: pattern.suggestion,
            });
          }
        }
        currentNewLine++;
      } else if (line.startsWith('-')) {
        // Deletions do not advance new file line counter and are not flagged as added secrets
      } else if (line.startsWith(' ')) {
        currentNewLine++;
      } else if (!line.startsWith('\\')) {
        inHunk = false;
      }
    } else {
      // Fallback: If not unified diff with @@, scan raw added lines or lines
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const addedContent = line.substring(1);
        for (const pattern of SECRET_PATTERNS) {
          const match = addedContent.match(pattern.regex);
          if (match) {
            findings.push({
              severity: 'P0',
              rule: pattern.name,
              filePath,
              match: match[0],
              message: `Critical credential leak: ${pattern.description}`,
              suggestion: pattern.suggestion,
            });
          }
        }
      }
    }
  }

  return findings;
}

/**
 * Scans a list of ChangedFiles for credentials using the static scanner.
 */
export function scanChangedFilesForCredentials(files: ChangedFile[]): PreCommitFinding[] {
  const allFindings: PreCommitFinding[] = [];

  for (const file of files) {
    const diffText = file.patch || file.content || '';
    const fileFindings = scanDiffForCredentials(diffText, file.path);
    allFindings.push(...fileFindings);
  }

  return allFindings;
}

/**
 * Optional fast flash model evaluation for staged changes (< 5s).
 */
export async function evaluateWithFlashModel(
  files: ChangedFile[],
  modelName = 'deepseek/deepseek-chat',
  modelClient?: ReviewModelClient
): Promise<PreCommitFinding[]> {
  if (!modelClient || files.length === 0) {
    return [];
  }

  const prompt = [
    'You are Review Yeti Pre-Commit Guardian. Review the following staged diff.',
    'Identify blocking security vulnerabilities (P0) or high-risk bugs (P1).',
    'Respond ONLY with JSON matching this schema:',
    '[{"severity": "P0" | "P1" | "P2", "rule": string, "filePath": string, "lineNumber": number, "message": string, "suggestion": string}]',
    'If no issues exist, respond with: []',
    '',
    'STAGED DIFFS:',
    ...files.map((f) => `FILE: ${f.path}\n${(f.patch || '').slice(0, 4000)}`),
  ].join('\n');

  try {
    const response = await modelClient.complete({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      timeoutMs: 5000,
      temperature: 0.1,
      maxTokens: 1024,
    });

    const content = (response as any).content || '';
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.map((item: any) => ({
          severity: item.severity === 'P0' ? 'P0' : item.severity === 'P1' ? 'P1' : 'P2',
          rule: item.rule || 'Flash Model Finding',
          filePath: item.filePath || files[0]?.path || 'staged',
          lineNumber: typeof item.lineNumber === 'number' ? item.lineNumber : undefined,
          message: item.message || 'Issue detected by flash model',
          suggestion: item.suggestion,
        }));
      }
    }
  } catch (_err) {
    // If flash model fails or times out, degrade gracefully to static scan
  }

  return [];
}

/**
 * Main pre-commit evaluation runner.
 */
export async function runPreCommit(options: PreCommitOptions = {}): Promise<PreCommitResult> {
  const startTime = performance.now();
  const cwd = options.cwd || process.cwd();
  const useColor = options.noColor !== true && process.env.NO_COLOR === undefined;

  let rawFiles: ChangedFile[] = [];

  if (options.files && options.files.length > 0) {
    rawFiles = options.files;
  } else if (options.diff !== undefined) {
    rawFiles = parseUnifiedDiff(options.diff);
  } else {
    const stagedDiffText = getStagedDiff(cwd, options.gitConfigGlobalDevNull !== false);
    rawFiles = parseUnifiedDiff(stagedDiffText);
  }

  // If no files or diff is empty, exit cleanly (0)
  if (rawFiles.length === 0) {
    const durationMs = performance.now() - startTime;
    if (!options.quiet && !options.json) {
      console.log('✅ Review Yeti: No staged changes found. Clean commit.');
    }
    return {
      exitCode: 0,
      findings: [],
      scannedFilesCount: 0,
      ignoredFilesCount: 0,
      durationMs,
      clean: true,
    };
  }

  // Filter lockfiles and binary noise using Smart Hunk Filter
  const filterResult = filterDiffHunks(rawFiles);
  const includedFiles = filterResult.files
    .filter((f) => f.status === 'included' || f.status === 'truncated')
    .map((f) => ({ path: f.path, patch: f.patch, content: f.content }));

  if (includedFiles.length === 0) {
    const durationMs = performance.now() - startTime;
    if (!options.quiet && !options.json) {
      console.log(`✅ Review Yeti: All staged changes ignored (${filterResult.stats.ignoredFilesCount} lockfile/generated files). Clean commit.`);
    }
    return {
      exitCode: 0,
      findings: [],
      scannedFilesCount: 0,
      ignoredFilesCount: filterResult.stats.ignoredFilesCount,
      durationMs,
      clean: true,
    };
  }

  // Static pre-flight security scanner (< 10ms)
  const staticFindings = scanChangedFilesForCredentials(includedFiles);

  // Optional flash model evaluation
  let flashFindings: PreCommitFinding[] = [];
  if (options.modelClient) {
    flashFindings = await evaluateWithFlashModel(includedFiles, options.model || 'deepseek/deepseek-chat', options.modelClient);
  }

  const allFindings = [...staticFindings, ...flashFindings];
  const exitCode = evaluateExitCode(allFindings, options.strict);
  const durationMs = performance.now() - startTime;
  const isClean = exitCode === 0 && allFindings.length === 0;

  if (options.json) {
    const jsonOutput = JSON.stringify(
      {
        exitCode,
        clean: isClean,
        findings: allFindings,
        stats: {
          scannedFiles: includedFiles.length,
          ignoredFiles: filterResult.stats.ignoredFilesCount,
          durationMs: Math.round(durationMs),
        },
      },
      null,
      2
    );
    console.log(jsonOutput);
    return {
      exitCode,
      findings: allFindings,
      scannedFilesCount: includedFiles.length,
      ignoredFilesCount: filterResult.stats.ignoredFilesCount,
      durationMs,
      clean: isClean,
    };
  }

  if (!options.quiet) {
    if (allFindings.length === 0) {
      console.log(`✅ Review Yeti: Pre-commit checks passed (${includedFiles.length} files scanned in ${durationMs.toFixed(1)}ms).`);
    } else {
      console.log(`\n🔍 Review Yeti Pre-Commit Evaluation (${includedFiles.length} files scanned in ${durationMs.toFixed(1)}ms):`);
      console.log('--------------------------------------------------------------------------------');

      for (const finding of allFindings) {
        const lineInfo = finding.lineNumber ? `:${finding.lineNumber}` : '';
        const location = `${finding.filePath}${lineInfo}`;
        const header = formatVerdict(finding.severity, `${finding.rule} at ${location}`, useColor);
        console.log(`\n${header}`);
        console.log(`  ${finding.message}`);
        if (finding.suggestion) {
          console.log(`  💡 Suggestion: ${finding.suggestion}`);
        }
      }

      console.log('--------------------------------------------------------------------------------');

      if (exitCode === 1) {
        const p0Count = allFindings.filter((f) => f.severity === 'P0').length;
        const p1Count = allFindings.filter((f) => f.severity === 'P1').length;
        if (p0Count > 0) {
          console.log(formatVerdict('P0', `Commit blocked: ${p0Count} blocking P0 issue(s) detected. Fix before committing.`, useColor));
        } else if (options.strict && p1Count > 0) {
          console.log(formatVerdict('P1', `Commit blocked (--strict): ${p1Count} P1 warning(s) detected. Fix before committing.`, useColor));
        }
      } else {
        console.log('⚠️  Non-blocking warnings detected. Commit proceeding.\n');
      }
    }
  }

  return {
    exitCode,
    findings: allFindings,
    scannedFilesCount: includedFiles.length,
    ignoredFilesCount: filterResult.stats.ignoredFilesCount,
    durationMs,
    clean: isClean,
  };
}

/**
 * Finds the root directory of the current git repository.
 */
export function findGitRoot(startDir = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const gitDir = path.join(current, '.git');
    if (fs.existsSync(gitDir)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * Installs the Review Yeti pre-commit git hook with mode 0o755.
 */
export function installGitHook(options: InstallHookOptions = {}): InstallHookResult {
  const repoRoot = options.repoRoot || findGitRoot() || process.cwd();
  let targetHookPath = options.hookPath;

  if (!targetHookPath) {
    if (options.husky || fs.existsSync(path.join(repoRoot, '.husky'))) {
      const huskyDir = path.join(repoRoot, '.husky');
      if (!fs.existsSync(huskyDir)) {
        fs.mkdirSync(huskyDir, { recursive: true });
      }
      targetHookPath = path.join(huskyDir, 'pre-commit');
    } else {
      const hooksDir = path.join(repoRoot, '.git', 'hooks');
      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }
      targetHookPath = path.join(hooksDir, 'pre-commit');
    }
  }

  const hookScript = [
    '#!/bin/sh',
    '# Review Yeti pre-commit hook',
    '# Evaluates staged changes before committing',
    '',
    'if command -v npx >/dev/null 2>&1; then',
    '  npx review-yeti pre-commit "$@"',
    'elif command -v review-yeti >/dev/null 2>&1; then',
    '  review-yeti pre-commit "$@"',
    'elif command -v git-yeti >/dev/null 2>&1; then',
    '  git-yeti pre-commit "$@"',
    'else',
    '  echo "[review-yeti] Warning: review-yeti CLI not found in PATH. Skipping hook."',
    'fi',
    '',
  ].join('\n');

  try {
    const parentDir = path.dirname(targetHookPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(targetHookPath, hookScript, { mode: 0o755 });
    // Explicitly chmod to ensure 0o755 permissions
    fs.chmodSync(targetHookPath, 0o755);

    return {
      success: true,
      hookPath: targetHookPath,
      message: `Successfully installed Review Yeti pre-commit hook at ${targetHookPath}`,
    };
  } catch (err: any) {
    return {
      success: false,
      hookPath: targetHookPath,
      message: `Failed to install pre-commit hook: ${err.message}`,
    };
  }
}
