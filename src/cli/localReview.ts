import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { minimatch } from 'minimatch';
import { ChangedFile, filterDiffHunks } from '../pipeline/hunkFilter';
import type { ReviewModelClient } from '../gateway/openRouterClient';
import {
  DetectionMode,
  meetsMinimumSeverity,
  MinimumSeverity,
  resolveDetectionModeSettings,
} from '../config/schema';
import {
  loadReviewYetiDirectoryFromFs,
  ReviewYetiDirectoryConfig,
} from '../config/reviewYetiDirLoader';
import {
  evaluateExitCode,
  evaluateWithFlashModel,
  findGitRoot,
  formatVerdict,
  getStagedDiff,
  parseUnifiedDiff,
  PreCommitFinding,
  scanChangedFilesForCredentials,
} from './preCommit';

export interface LocalReviewOptions {
  mode?: DetectionMode;
  minSeverity?: MinimumSeverity;
  base?: string;
  head?: string;
  isolate?: boolean;
  raw?: boolean;
  json?: boolean;
  strict?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  diff?: string;
  files?: ChangedFile[];
  model?: string;
  modelClient?: ReviewModelClient;
  cwd?: string;
}

export interface LocalReviewResult {
  exitCode: number;
  mode: DetectionMode;
  minSeverity: MinimumSeverity;
  isolatedWorktree: boolean;
  findings: PreCommitFinding[];
  scannedFilesCount: number;
  ignoredFilesCount: number;
  customChecksCount: number;
  durationMs: number;
  clean: boolean;
}

/**
 * Extracts git diff between base/head refs or working tree changes.
 */
export function getLocalReviewDiff(
  cwd: string,
  options: { base?: string; head?: string } = {}
): string {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  try {
    if (options.base && options.head) {
      return execFileSync(
        'git',
        ['diff', `${options.base}...${options.head}`, '--unified=3'],
        { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }
      );
    }
    if (options.base) {
      return execFileSync(
        'git',
        ['diff', options.base, '--unified=3'],
        { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }
      );
    }
    const workingDiff = execSync('git diff HEAD --unified=3', {
      cwd,
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (workingDiff.trim()) {
      return workingDiff;
    }
    return getStagedDiff(cwd, true);
  } catch {
    return getStagedDiff(cwd, true);
  }
}

/**
 * Runs a function inside a temporary isolated git worktree (`--isolate`),
 * cleaning up the worktree afterward.
 */
export async function withIsolatedGitWorktree<T>(
  cwd: string,
  ref: string | undefined,
  fn: (worktreePath: string) => Promise<T>
): Promise<{ result: T; isolated: boolean }> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return { result: await fn(cwd), isolated: false };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-worktree-'));
  const targetRef = ref || 'HEAD';
  let created = false;

  try {
    execFileSync('git', ['worktree', 'add', '--detach', tmpDir, targetRef], {
      cwd: gitRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    created = true;
    const result = await fn(tmpDir);
    return { result, isolated: true };
  } catch {
    // Degrade gracefully to current working directory if git worktree cannot be created
    const result = await fn(cwd);
    return { result, isolated: false };
  } finally {
    if (created) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', tmpDir], {
          cwd: gitRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // Ignore cleanup errors
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

function shouldIgnoreFileByPatterns(filePath: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => minimatch(filePath, pattern, { dot: true, matchBase: true }));
}

/**
 * Evaluates local git changes with `.reviewyeti/` directory config, detection mode
 * (`fast` | `balanced` | `deep`), optional worktree isolation (`--isolate`),
 * and raw JSONL streaming (`--raw`) for coding agents.
 */
export async function runLocalReview(options: LocalReviewOptions = {}): Promise<LocalReviewResult> {
  const startTime = performance.now();
  const baseCwd = options.cwd || process.cwd();
  const useColor = options.noColor !== true && process.env.NO_COLOR === undefined;

  const executeInDir = async (workingDir: string): Promise<{
    rawFiles: ChangedFile[];
    dirConfig: ReviewYetiDirectoryConfig;
  }> => {
    const dirConfig = loadReviewYetiDirectoryFromFs(workingDir);
    let rawFiles: ChangedFile[] = [];
    if (options.files && options.files.length > 0) {
      rawFiles = options.files;
    } else if (options.diff !== undefined) {
      rawFiles = parseUnifiedDiff(options.diff);
    } else {
      const diffText = getLocalReviewDiff(workingDir, {
        base: options.base,
        head: options.head,
      });
      rawFiles = parseUnifiedDiff(diffText);
    }
    return { rawFiles, dirConfig };
  };

  let rawFiles: ChangedFile[] = [];
  let dirConfig: ReviewYetiDirectoryConfig;
  let isolatedWorktree = false;

  if (options.isolate) {
    const isolatedExec = await withIsolatedGitWorktree(baseCwd, options.head, executeInDir);
    rawFiles = isolatedExec.result.rawFiles;
    dirConfig = isolatedExec.result.dirConfig;
    isolatedWorktree = isolatedExec.isolated;
  } else {
    const directExec = await executeInDir(baseCwd);
    rawFiles = directExec.rawFiles;
    dirConfig = directExec.dirConfig;
  }

  const mode: DetectionMode = options.mode || dirConfig.mode || 'balanced';
  const modeSettings = resolveDetectionModeSettings(mode);
  const minSeverity: MinimumSeverity =
    options.minSeverity ||
    dirConfig.minSeverity ||
    (mode === 'fast' ? 'medium' : 'low');

  const filterResult = filterDiffHunks(rawFiles);
  const afterHunkFilter = filterResult.files
    .filter((f) => f.status === 'included' || f.status === 'truncated')
    .map((f) => ({ path: f.path, patch: f.patch, content: f.content }));

  let dirIgnoredCount = 0;
  const includedFiles = afterHunkFilter.filter((file) => {
    if (shouldIgnoreFileByPatterns(file.path, dirConfig.ignorePatterns)) {
      dirIgnoredCount++;
      return false;
    }
    return true;
  });

  const totalIgnoredCount = filterResult.stats.ignoredFilesCount + dirIgnoredCount;

  // Static credential & secret scan
  const staticFindings = scanChangedFilesForCredentials(includedFiles);

  // Optional model scan
  let modelFindings: PreCommitFinding[] = [];
  if (options.modelClient && includedFiles.length > 0) {
    modelFindings = await evaluateWithFlashModel(
      includedFiles,
      options.model || 'deepseek/deepseek-chat',
      options.modelClient
    );
  }

  const combinedFindings = [...staticFindings, ...modelFindings].filter((f) =>
    meetsMinimumSeverity(f.severity, minSeverity)
  );

  const effectiveStrict = options.strict ?? modeSettings.profile === 'assertive';
  const exitCode = evaluateExitCode(combinedFindings, effectiveStrict);
  const durationMs = performance.now() - startTime;
  const clean = exitCode === 0 && combinedFindings.length === 0;

  if (options.raw) {
    for (const finding of combinedFindings) {
      console.log(
        JSON.stringify({
          type: 'finding',
          mode,
          severity: finding.severity,
          rule: finding.rule,
          filePath: finding.filePath,
          lineNumber: finding.lineNumber,
          message: finding.message,
          suggestion: finding.suggestion,
        })
      );
    }
    console.log(
      JSON.stringify({
        type: 'summary',
        mode,
        minSeverity,
        isolatedWorktree,
        clean,
        exitCode,
        findingsCount: combinedFindings.length,
        scannedFilesCount: includedFiles.length,
        ignoredFilesCount: totalIgnoredCount,
        customChecksCount: dirConfig.checks.length,
        durationMs: Math.round(durationMs),
      })
    );
  } else if (options.json) {
    console.log(
      JSON.stringify(
        {
          exitCode,
          clean,
          mode,
          minSeverity,
          isolatedWorktree,
          findings: combinedFindings,
          stats: {
            scannedFiles: includedFiles.length,
            ignoredFiles: totalIgnoredCount,
            customChecks: dirConfig.checks.length,
            durationMs: Math.round(durationMs),
          },
        },
        null,
        2
      )
    );
  } else if (!options.quiet) {
    if (combinedFindings.length === 0) {
      console.log(
        `✅ Review Yeti (${mode} mode): ${includedFiles.length} file(s) reviewed in ${durationMs.toFixed(1)}ms — no issues found.`
      );
    } else {
      console.log(
        `\n🔍 Review Yeti Local Review (${mode} mode, ${includedFiles.length} file(s) scanned in ${durationMs.toFixed(1)}ms):`
      );
      console.log('--------------------------------------------------------------------------------');
      for (const finding of combinedFindings) {
        const lineInfo = finding.lineNumber ? `:${finding.lineNumber}` : '';
        const location = `${finding.filePath}${lineInfo}`;
        console.log(`\n${formatVerdict(finding.severity, `${finding.rule} at ${location}`, useColor)}`);
        console.log(`  ${finding.message}`);
        if (finding.suggestion) {
          console.log(`  💡 Suggestion: ${finding.suggestion}`);
        }
      }
      console.log('--------------------------------------------------------------------------------');
    }
  }

  return {
    exitCode,
    mode,
    minSeverity,
    isolatedWorktree,
    findings: combinedFindings,
    scannedFilesCount: includedFiles.length,
    ignoredFilesCount: totalIgnoredCount,
    customChecksCount: dirConfig.checks.length,
    durationMs,
    clean,
  };
}
