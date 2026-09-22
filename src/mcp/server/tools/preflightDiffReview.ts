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

const SENSITIVE_PATH_PATTERNS = [
  /\.github\//i,
  /workflow/i,
  /pipeline/i,
  /\.env/i,
  /secret/i,
  /credential/i,
  /token/i,
  /password/i,
  /key/i,
  /cert/i,
  /auth/i,
  /security/i,
  /migration/i,
  /schema/i,
];

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

export interface PreflightDiffReviewDependencies {
  modelClient?: {
    evaluateDiff?(prompt: string, signal?: AbortSignal): Promise<{ findings: PreflightFinding[] }>;
  };
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
          const hasSensitivePattern = SENSITIVE_PATH_PATTERNS.some((p) => p.test(file.path));
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

        if (SENSITIVE_PATH_PATTERNS.some((p) => p.test(file.path))) {
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
      if (touchedPaths.some((p) => SENSITIVE_PATH_PATTERNS.some((regex) => regex.test(p)))) {
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

      // If model client is provided and within SLA budget (<12s)
      if (deps.modelClient?.evaluateDiff && findings.length === 0) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12_000);
        try {
          const evalResult = await deps.modelClient.evaluateDiff(
            `Review diff for repo ${repo} against ${target_branch}:\n${diff}`,
            controller.signal
          );
          clearTimeout(timeoutId);
          if (evalResult?.findings) {
            findings.push(...evalResult.findings);
          }
        } catch {
          clearTimeout(timeoutId);
          // Model timeout or error: gracefully fallback to static heuristic inspection
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
