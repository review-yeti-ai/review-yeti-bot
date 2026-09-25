import { createHash } from 'node:crypto';
import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import {
  PreflightDiffReviewInputSchema,
  type PreflightDiffReviewInput,
  type PreflightDiffReviewOutput,
  type PreflightFinding,
} from './schemas';
import { compareClaims } from '../../../review/claimSimilarity';
import { blocksFastShipByPath, isSecuritySensitivePath } from '../../../review/securitySensitivePaths';
import type { ReviewModelClient } from '../../../gateway/openRouterClient';

export const preflightDiffReviewDefinition: ToolDefinition = {
  name: 'preflight_diff_review',
  description: 'Synchronous local git diff review with AST blast radius analysis before git push.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Optional GitHub repository owner/organization.' },
      diff: { type: 'string', description: 'Unified git diff string (max 512KB).' },
      repo: { type: 'string', description: 'Repository identifier.' },
      target_branch: { type: 'string', default: 'main', description: 'Target merge branch.' },
      model: { type: 'string', description: 'Optional model override.' },
    },
    required: ['diff', 'repo'],
    additionalProperties: false,
  },
};

const SAFE_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdown', '.mkdn',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.svg', '.bmp',
  '.txt',
]);

const SAFE_FILENAMES = new Set([
  'license', 'license.md', 'license.txt',
  'notice', 'notice.md', 'notice.txt',
  '.gitignore', '.gitattributes', '.prettierignore', '.eslintignore', '.editorconfig',
]);


export interface ParsedDiffFile {
  path: string;
  isBinary: boolean;
  addedLines: Array<{ line: number; text: string }>;
  deletedLines: Array<{ line: number; text: string }>;
  modifiedExports: string[];
}

export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  const lines = diff.split('\n');
  let currentFile: ParsedDiffFile | null = null;
  let currentNewLine = 0;
  let currentOldLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const match = /diff --git a\/(.*) b\/(.*)/.exec(line);
      const filePath = match ? match[2] : 'unknown';
      currentFile = {
        path: filePath,
        isBinary: false,
        addedLines: [],
        deletedLines: [],
        modifiedExports: [],
      };
      files.push(currentFile);
      currentNewLine = 0;
      currentOldLine = 0;
      continue;
    }

    if (!currentFile) {
      if (line.startsWith('+++ b/')) {
        currentFile = {
          path: line.slice(6),
          isBinary: false,
          addedLines: [],
          deletedLines: [],
          modifiedExports: [],
        };
        files.push(currentFile);
      }
      continue;
    }

    if (line.includes('Binary files ') || line.startsWith('GIT binary patch')) {
      currentFile.isBinary = true;
      continue;
    }

    if (line.startsWith('@@ ')) {
      const match = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        currentOldLine = parseInt(match[1], 10);
        currentNewLine = parseInt(match[3], 10);
      }
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      currentFile.addedLines.push({ line: currentNewLine, text: content });

      const exportMatch = /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([a-zA-Z0-9_$]+)/.exec(content);
      if (exportMatch && !currentFile.modifiedExports.includes(exportMatch[1])) {
        currentFile.modifiedExports.push(exportMatch[1]);
      }
      currentNewLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      const content = line.slice(1);
      currentFile.deletedLines.push({ line: currentOldLine, text: content });

      const exportMatch = /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([a-zA-Z0-9_$]+)/.exec(content);
      if (exportMatch && !currentFile.modifiedExports.includes(exportMatch[1])) {
        currentFile.modifiedExports.push(exportMatch[1]);
      }
      currentOldLine++;
    } else if (!line.startsWith('\\')) {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      const exportMatch = /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([a-zA-Z0-9_$]+)/.exec(content);
      if (exportMatch && !currentFile.modifiedExports.includes(exportMatch[1])) {
        currentFile.modifiedExports.push(exportMatch[1]);
      }
      currentNewLine++;
      currentOldLine++;
    }
  }

  return files;
}

export const DEFAULT_PREFLIGHT_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const MAX_DIFF_CHARS_FOR_MODEL = 32_000;

export const ADVISORY_TITLE_RE =
  /\b(naming|code style|formatting|documentation|typo|unused import|readability|dry|maintainability)\b/i;

export const UNVERIFIED_PREMISE_PHRASES = [
  'could not confirm',
  'unable to verify',
  'assuming that',
  'if this is',
  'if this still',
  'without seeing the rest',
  'not visible in this diff',
  'cannot verify',
];

export function calibratePreflightSeverity(
  rawSeverity: string,
  title: string,
  rationale: string
): 'P0' | 'P1' | 'P2' {
  const norm = String(rawSeverity || '').toLowerCase().trim();
  let sev: 'P0' | 'P1' | 'P2' = 'P1';

  if (norm === 'p0' || norm === 'blocking' || norm === 'block' || norm === 'critical') {
    sev = 'P0';
  } else if (norm === 'p1' || norm === 'warning' || norm === 'warn' || norm === 'high') {
    sev = 'P1';
  } else if (norm === 'p2' || norm === 'info' || norm === 'advisory' || norm === 'low') {
    sev = 'P2';
  }

  // Advisory title demotion
  if (sev === 'P1' && ADVISORY_TITLE_RE.test(title)) {
    sev = 'P2';
  }

  // Unverified premise demotion
  const combined = `${title} ${rationale}`.toLowerCase();
  if ((sev === 'P0' || sev === 'P1') && UNVERIFIED_PREMISE_PHRASES.some((phrase) => combined.includes(phrase))) {
    sev = 'P2';
  }

  return sev;
}

export function buildPreflightPersonaPrompt(repo: string, targetBranch: string, diff: string): string {
  const truncatedDiff =
    diff.length > MAX_DIFF_CHARS_FOR_MODEL
      ? `${diff.slice(0, MAX_DIFF_CHARS_FOR_MODEL)}\n\n[... Diff truncated at 32KB for model evaluation SLA ...]`
      : diff;

  return `You are Review Yeti's preflight diff review panel composed of 5 specialized personas:
1. Security Persona: Injection vulnerabilities (SQLi, CMDi, XSS), secrets/tokens, auth bypasses, untrusted inputs.
2. Architecture Persona: Layering/boundary violations, unbounded collections (memory leaks), concurrency issues, lifecycle resource leaks.
3. Correctness Persona: Logic errors, off-by-one, null/undefined dereferences, unhandled error conditions.
4. Contract Persona: Breaking API signature changes, schema drift, invalid protocol messages.
5. Testing Persona: High-risk code or state mutations missing test assertions.

Evaluate this uncommitted local git diff for repository "${repo}" targeting branch "${targetBranch}".

Diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Severity Guidelines:
- "P0" (blocking): Definite exploitable security vulnerabilities, runtime crashes, severe data corruption, or merge blockers.
- "P1" (warning): Substantive correctness bugs, unbounded memory/resource leaks, breaking contract changes, missing critical tests.
- "P2" (info): Advisory improvements, naming, documentation, minor style.

Instructions:
- Only report genuine, high-confidence issues. If the diff is clean and safe, return an empty array: [].
- Assign a confidence score between 0.0 and 1.0. Any speculative finding with confidence < 0.70 must be omitted.
- Respond ONLY with a valid JSON array matching this structure:
[
  {
    "severity": "P0" | "P1" | "P2",
    "category": "Security" | "Architecture" | "Correctness" | "Contract" | "Testing",
    "title": "Concise summary of the defect",
    "file_path": "path/to/file.ts",
    "line": 42,
    "rationale": "Clear explanation of the defect and why it is a problem",
    "suggested_fix": "Concrete guidance or code snippet to resolve the issue",
    "confidence": 0.85
  }
]`;
}

export function parseModelPersonaFindings(rawText: string, repo: string): PreflightFinding[] {
  if (!rawText || typeof rawText !== 'string') return [];
  const trimmed = rawText.trim();
  let parsedJson: any = null;

  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        parsedJson = JSON.parse(arrayMatch[0]);
      } catch {
        // Fall through
      }
    }
    if (!parsedJson) {
      const objMatch = trimmed.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          const obj = JSON.parse(objMatch[0]);
          if (Array.isArray(obj.findings)) {
            parsedJson = obj.findings;
          }
        } catch {
          // Fall through
        }
      }
    }
  }

  if (!Array.isArray(parsedJson)) return [];

  const findings: PreflightFinding[] = [];
  for (const item of parsedJson) {
    if (!item || typeof item !== 'object') continue;
    const rawConf = typeof item.confidence === 'number' ? item.confidence : 0.8;
    if (rawConf < 0.70) {
      continue;
    }

    const title = String(item.title || 'Preflight finding').trim();
    const rationale = String(item.rationale || item.body || item.description || '').trim();
    const severity = calibratePreflightSeverity(String(item.severity || 'P1'), title, rationale);
    const category = String(item.category || 'Architecture').trim();
    const filePath = String(item.file_path || item.path || item.file || 'unknown').trim();
    const line = typeof item.line === 'number' ? item.line : (typeof item.line_start === 'number' ? item.line_start : undefined);
    const suggestedFix = typeof item.suggested_fix === 'string' ? item.suggested_fix : (typeof item.suggestion === 'string' ? item.suggestion : undefined);

    const findingId = item.finding_id || `pref-model-${createHash('sha256').update(`${filePath}:${line}:${title}`).digest('hex').slice(0, 12)}`;

    findings.push({
      finding_id: findingId,
      severity,
      category,
      title,
      file_path: filePath,
      line,
      rationale,
      suggested_fix: suggestedFix,
      confidence: rawConf,
    });
  }

  return findings;
}

const SEV_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

export function deduplicateFindings(
  existingFindings: PreflightFinding[],
  modelFindings: PreflightFinding[]
): PreflightFinding[] {
  const result = [...existingFindings];

  for (const modelF of modelFindings) {
    let merged = false;

    for (let i = 0; i < result.length; i++) {
      const existing = result[i];
      const comparison = compareClaims(
        {
          path: existing.file_path,
          line: existing.line,
          title: existing.title,
          body: existing.rationale,
        },
        {
          path: modelF.file_path,
          line: modelF.line,
          title: modelF.title,
          body: modelF.rationale,
        }
      );

      if (comparison.duplicate) {
        merged = true;
        const existingRank = SEV_ORDER[existing.severity] ?? 1;
        const modelRank = SEV_ORDER[modelF.severity] ?? 1;
        if (modelRank < existingRank) {
          existing.severity = modelF.severity;
        }
        if (modelF.rationale && modelF.rationale.length > existing.rationale.length) {
          existing.rationale = `${existing.rationale}\n\nModel Analysis: ${modelF.rationale}`;
        }
        if (!existing.suggested_fix && modelF.suggested_fix) {
          existing.suggested_fix = modelF.suggested_fix;
        }
        if (modelF.confidence !== undefined) {
          existing.confidence = Math.max(existing.confidence ?? 0.8, modelF.confidence);
        }
        break;
      }
    }

    if (!merged) {
      result.push(modelF);
    }
  }

  return result;
}

export interface PreflightDiffReviewDependencies {
  modelClient?: ReviewModelClient | {
    complete?(request: any): Promise<{ content: string }>;
    evaluateDiff?(prompt: string, signal?: AbortSignal): Promise<{ findings: PreflightFinding[] }>;
  };
  model?: string;
  now?: () => number;
}

export function createPreflightDiffReviewTool(deps: PreflightDiffReviewDependencies = {}) {
  const nowFn = deps.now || Date.now;

  return {
    definition: preflightDiffReviewDefinition,
    schema: PreflightDiffReviewInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = PreflightDiffReviewInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { diff, repo, target_branch = 'main' } = parsed.data;

      const parsedFiles = parseUnifiedDiff(diff);

      // 1. Fast-Ship Short Circuit Check
      const allFilesSafe =
        parsedFiles.length > 0 &&
        parsedFiles.every((file) => {
          const lowerPath = file.path.toLowerCase();
          const baseName = lowerPath.split('/').pop() || '';
          const hasSafeName = SAFE_FILENAMES.has(baseName);
          const hasSafeExt = Array.from(SAFE_EXTENSIONS).some((ext) => lowerPath.endsWith(ext));
          const hasSensitivePattern = blocksFastShipByPath(file.path);
          return (hasSafeName || hasSafeExt) && !hasSensitivePattern;
        });

      if (allFilesSafe) {
        return buildToolResultJson({
          eligible_to_ship: true,
          findings: [],
          blast_radius_summary: `Safe non-code modification (documentation / assets / config). Low blast radius across ${parsedFiles.length} files (0 code symbols altered). Eligible for fast-ship.`,
        } satisfies PreflightDiffReviewOutput);
      }

      // 2. Blast Radius Analysis
      let riskTier: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
      const allModifiedExports: string[] = [];
      let totalAdded = 0;
      let totalDeleted = 0;
      const touchedPaths: string[] = [];

      for (const file of parsedFiles) {
        touchedPaths.push(file.path);
        totalAdded += file.addedLines.length;
        totalDeleted += file.deletedLines.length;
        allModifiedExports.push(...file.modifiedExports);

        // Risk tier (not fast-ship): the shared predicate OR the coarse screen.
        if (isSecuritySensitivePath(file.path) || blocksFastShipByPath(file.path)) {
          riskTier = 'CRITICAL';
        } else if (file.modifiedExports.length > 0 && riskTier !== 'CRITICAL') {
          riskTier = 'HIGH';
        } else if (riskTier === 'LOW' && (file.path.endsWith('.ts') || file.path.endsWith('.js') || file.path.endsWith('.py'))) {
          riskTier = 'MEDIUM';
        }
      }

      let blastRadiusSummary = `Blast radius: ${riskTier}. ${parsedFiles.length} files modified (+${totalAdded}/-${totalDeleted} lines).`;
      if (allModifiedExports.length > 0) {
        blastRadiusSummary += ` ${allModifiedExports.length} exported symbol(s) modified (${allModifiedExports.slice(0, 3).join(', ')}${allModifiedExports.length > 3 ? '...' : ''}).`;
      }
      if (touchedPaths.some((p) => isSecuritySensitivePath(p) || blocksFastShipByPath(p))) {
        blastRadiusSummary += ` Touches critical infrastructure or security components.`;
      }

      // 3. Security & Persona Evaluation
      const findings: PreflightFinding[] = [];

      // Static security rules (Secrets, Tokens, SQLi, Shell injection)
      const SECRET_PATTERN = /(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{36}|AIza[0-9A-Za-z-_]{35}|bearer\s+[a-zA-Z0-9._-]{24,})/i;
      const SQLI_PATTERN = /SELECT\s+.*FROM\s+.*(?:\+|concat)\s*(?:req|params|query|body|[a-zA-Z0-9_]+)/i;
      const CMDI_PATTERN = /(?:exec|spawn|execSync)\s*\([^)]*(?:req|query|body|userInput|[a-zA-Z0-9_]+\s*\+|\+\s*[a-zA-Z0-9_]+|\$\{[^}]+\})/i;

      for (const file of parsedFiles) {
        for (const added of file.addedLines) {
          if (SECRET_PATTERN.test(added.text)) {
            findings.push({
              finding_id: `pref-sec-${file.path}-${added.line}`,
              severity: 'P0',
              category: 'Security',
              title: 'Hardcoded secret token or credential detected in diff',
              file_path: file.path,
              line: added.line,
              rationale: 'Diff contains an apparent plaintext secret key or API token violating security policy.',
              suggested_fix: 'Remove secret from source code and load via environment variable or Secret manager.',
            });
          }

          if (SQLI_PATTERN.test(added.text)) {
            findings.push({
              finding_id: `pref-sqli-${file.path}-${added.line}`,
              severity: 'P0',
              category: 'Security',
              title: 'Potential SQL injection vulnerability via string concatenation',
              file_path: file.path,
              line: added.line,
              rationale: 'SQL query constructed via string concatenation with dynamic parameter instead of parameterized query.',
              suggested_fix: 'Use parameterized SQL query placeholders ($1, $2) instead of string concatenation.',
            });
          }

          if (CMDI_PATTERN.test(added.text)) {
            findings.push({
              finding_id: `pref-cmdi-${file.path}-${added.line}`,
              severity: 'P0',
              category: 'Security',
              title: 'Potential Command Injection via unescaped shell execution',
              file_path: file.path,
              line: added.line,
              rationale: 'Command execution invokes system shell with concatenated input.',
              suggested_fix: 'Use execFile or spawn with array arguments without invoking shell interpreter.',
            });
          }
        }
      }

      // 4. Model Persona Evaluation (DeepSeek & Backward Compatible)
      if (deps.modelClient) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12_000);
        const activeModel = parsed.data.model || deps.model || DEFAULT_PREFLIGHT_MODEL;

        try {
          if (typeof (deps.modelClient as any).complete === 'function') {
            const prompt = buildPreflightPersonaPrompt(repo, target_branch, diff);
            const response = await (deps.modelClient as any).complete({
              model: activeModel,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.1,
              maxTokens: 2048,
              timeoutMs: 12_000,
              signal: controller.signal,
            });
            const modelFindings = parseModelPersonaFindings(response.content, repo);
            const deduped = deduplicateFindings(findings, modelFindings);
            findings.length = 0;
            findings.push(...deduped);
          } else if (typeof (deps.modelClient as any).evaluateDiff === 'function') {
            const evalResult = await (deps.modelClient as any).evaluateDiff(
              `Review diff for repo ${repo} against ${target_branch}:\n${diff}`,
              controller.signal
            );
            if (evalResult?.findings && Array.isArray(evalResult.findings)) {
              const processed = evalResult.findings
                .filter((f: PreflightFinding) => f.confidence === undefined || f.confidence >= 0.70)
                .map((f: PreflightFinding) => ({
                  ...f,
                  severity: calibratePreflightSeverity(f.severity, f.title, f.rationale),
                }));
              const deduped = deduplicateFindings(findings, processed);
              findings.length = 0;
              findings.push(...deduped);
            }
          }
        } catch {
          // Model timeout or error: gracefully fallback to static heuristic inspection
        } finally {
          clearTimeout(timeoutId);
        }
      }

      const eligibleToShip = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');

      return buildToolResultJson({
        eligible_to_ship: eligibleToShip,
        findings,
        blast_radius_summary: blastRadiusSummary,
      } satisfies PreflightDiffReviewOutput);
    },
  };
}
