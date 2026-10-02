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

type PreflightSqlToken = {
  kind: 'string' | 'regex' | 'identifier' | 'number' | 'punctuation';
  text: string;
  value?: string;
  interpolated?: boolean;
  closed?: boolean;
  templateExpressions?: PreflightTemplateExpression[];
};

type PreflightTemplateExpression = {
  tokens: PreflightSqlToken[];
  closed: boolean;
};

type PreflightSourceLanguage = 'javascript' | 'python' | 'ruby' | 'elixir' | 'php' | 'sql' | 'other';

const SQL_SELECT_FROM_PATTERN = /\bSELECT\b[\s\S]*?\bFROM\b/i;
const STATIC_SQL_IDENTIFIERS = new Set(['false', 'none', 'null', 'true', 'undefined']);
const PREFLIGHT_IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const PREFLIGHT_NUMBER_PATTERN = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?n?/y;

function preflightSourceLanguage(filePath: string): PreflightSourceLanguage {
  const extension = /\.[^.\/]+$/.exec(filePath)?.[0]?.toLowerCase();
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(extension || '')) return 'javascript';
  if (['.py', '.pyw'].includes(extension || '')) return 'python';
  if (['.rb', '.rake', '.gemspec'].includes(extension || '')) return 'ruby';
  if (['.ex', '.exs'].includes(extension || '')) return 'elixir';
  if (['.php', '.phtml', '.php5'].includes(extension || '')) return 'php';
  if (extension === '.sql') return 'sql';
  return 'other';
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
]);
const REGEX_CONTROL_CONDITION_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);

function followsJavascriptControlCondition(tokens: PreflightSqlToken[]): boolean {
  if (tokens[tokens.length - 1]?.text !== ')') return false;
  let nesting = 0;
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (tokens[index].text === ')') nesting++;
    if (tokens[index].text === '(' && --nesting === 0) {
      const conditionOwner = tokens[index - 1];
      return conditionOwner?.kind === 'identifier' &&
        tokens[index - 2]?.text !== '.' &&
        REGEX_CONTROL_CONDITION_KEYWORDS.has(conditionOwner.text);
    }
  }
  return false;
}

function matchingOpeningBrace(tokens: PreflightSqlToken[], closingIndex: number): number | undefined {
  let nested = 0;
  for (let index = closingIndex; index >= 0; index--) {
    if (tokens[index].text === '}') nested++;
    if (tokens[index].text === '{' && --nested === 0) return index;
  }
  return undefined;
}

function closesJavascriptBlock(tokens: PreflightSqlToken[]): boolean {
  if (tokens[tokens.length - 1]?.text !== '}') return false;
  const openIndex = matchingOpeningBrace(tokens, tokens.length - 1);
  if (openIndex === undefined) return false;

  const beforeOpen = tokens[openIndex - 1];
  if (beforeOpen?.text === ')' && followsJavascriptControlCondition(tokens.slice(0, openIndex))) return true;
  if (beforeOpen?.kind === 'identifier' && ['catch', 'else', 'try', 'finally', 'do'].includes(beforeOpen.text)) return true;
  return beforeOpen?.text === '>' && tokens[openIndex - 2]?.text === '=';
}

function canEndJavascriptExpression(token: PreflightSqlToken | undefined): boolean {
  return Boolean(token && (
    ['identifier', 'number', 'string', 'regex'].includes(token.kind) ||
    [')', ']', '}'].includes(token.text)
  ));
}

function canStartJavascriptRegex(tokens: PreflightSqlToken[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (!previous) return true;
  if (
    previous.kind === 'identifier' &&
    tokens[tokens.length - 2]?.text !== '.' &&
    REGEX_PREFIX_KEYWORDS.has(previous.text)
  ) return true;
  if (previous.text === ')') return followsJavascriptControlCondition(tokens);
  if (
    previous.kind === 'punctuation' &&
    ['(', '[', '{', ',', ':', ';', '=', '!', '?', '&', '|', '^', '~', '*', '%', '+', '-', '<', '>'].includes(previous.text)
  ) return true;
  if (previous.text === '}' && closesJavascriptBlock(tokens)) return true;
  // In `value / /pattern/`, the first slash is division and the second begins
  // the RHS RegExp literal. A lone slash after an expression cannot start a
  // valid operand, so keep ordinary division unchanged.
  if (previous.text === '/' && canEndJavascriptExpression(tokens[tokens.length - 2])) return true;
  return previous.text === '>' && tokens[tokens.length - 2]?.text === '=';
}

function javascriptRegexLiteralEnd(line: string, start: number): number | undefined {
  let inCharacterClass = false;
  for (let index = start + 1; index < line.length; index++) {
    const character = line[index];
    if (character === '\\') {
      index++;
      continue;
    }
    if (inCharacterClass) {
      if (character === ']') inCharacterClass = false;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === '/') {
      let end = index + 1;
      while (/[A-Za-z]/.test(line[end] || '')) end++;
      return end;
    }
  }
  return undefined;
}

type PreflightLexicalFrame = {
  kind: 'code';
  tokens: PreflightSqlToken[];
  templateExpression: boolean;
  braces: number;
  expression?: PreflightTemplateExpression;
} | {
  kind: 'template';
  token: PreflightSqlToken;
  literalStart: number | undefined;
  literalParts: string[];
};

function tokenizePreflightSourceLine(line: string, language: PreflightSourceLanguage): PreflightSqlToken[][] {
  const tokenScopes: PreflightSqlToken[][] = [[]];
  const frames: PreflightLexicalFrame[] = [
    { kind: 'code', tokens: tokenScopes[0], templateExpression: false, braces: 0 },
  ];
  let index = 0;

  const finishTemplate = (frame: Extract<PreflightLexicalFrame, { kind: 'template' }>) => {
    if (frame.literalStart !== undefined) frame.literalParts.push(line.slice(frame.literalStart, index));
    // Preserve only literal segments here. Executable substitutions have their
    // own token scope, so nested templates do not copy their ancestors' bodies.
    frame.token.value = frame.literalParts.join(' ');
    frame.token.text = `\`${frame.token.value}\``;
  };

  // An explicit stack handles nested templates/objects without recursion or a
  // silent depth/byte cutoff. The existing diff byte bound also bounds frames.
  while (index < line.length) {
    const frame = frames[frames.length - 1];
    if (frame.kind === 'template') {
      if (line[index] === '\\') {
        index += 2;
      } else if (line[index] === '`') {
        finishTemplate(frame);
        frame.token.closed = true;
        frames.pop();
        index++;
      } else if (line.startsWith('${', index)) {
        frame.literalParts.push(line.slice(frame.literalStart!, index));
        frame.literalStart = undefined;
        frame.token.interpolated = true;
        const expressionTokens: PreflightSqlToken[] = [];
        const expression: PreflightTemplateExpression = { tokens: expressionTokens, closed: false };
        (frame.token.templateExpressions ||= []).push(expression);
        tokenScopes.push(expressionTokens);
        frames.push({ kind: 'code', tokens: expressionTokens, templateExpression: true, braces: 0, expression });
        index += 2;
      } else {
        index++;
      }
      continue;
    }

    const tokens = frame.tokens;
    if (frame.templateExpression && line[index] === '}' && frame.braces === 0) {
      if (frame.expression) frame.expression.closed = true;
      frames.pop();
      const template = frames[frames.length - 1];
      if (template.kind === 'template') template.literalStart = index + 1;
      index++;
      continue;
    }
    if (/\s/.test(line[index])) {
      index++;
      continue;
    }
    if (['javascript', 'php', 'other'].includes(language) && line.startsWith('//', index)) break;
    if (['python', 'ruby', 'elixir', 'php', 'sql'].includes(language) && line[index] === '#') break;
    if (language === 'sql' && line.startsWith('--', index)) break;
    if (['javascript', 'php', 'sql', 'other'].includes(language) && line.startsWith('/*', index)) {
      const commentEnd = line.indexOf('*/', index + 2);
      if (commentEnd < 0) break;
      index = commentEnd + 2;
      continue;
    }
    if (language === 'javascript' && line[index] === '/' && canStartJavascriptRegex(tokens)) {
      const regexEnd = javascriptRegexLiteralEnd(line, index);
      if (regexEnd !== undefined) {
        tokens.push({ kind: 'regex', text: line.slice(index, regexEnd) });
        index = regexEnd;
        continue;
      }
    }

    const pythonStringPrefix = language === 'python'
      ? /^(?:f|fr|rf)(?=["'])/i.exec(line.slice(index, index + 3))?.[0]
      : undefined;
    if (pythonStringPrefix) index += pythonStringPrefix.length;
    const quote = line[index];
    if (language === 'javascript' && quote === '`') {
      const token: PreflightSqlToken = { kind: 'string', text: '`', value: '', interpolated: false };
      tokens.push(token);
      frames.push({ kind: 'template', token, literalStart: index + 1, literalParts: [] });
      index++;
      continue;
    }
    if (quote === '"' || quote === "'" || quote === '`') {
      const delimiter = quote !== '`' && line.startsWith(quote.repeat(3), index) ? quote.repeat(3) : quote;
      const contentStart = index + delimiter.length;
      index = contentStart;
      let interpolated = false;
      while (index < line.length && !line.startsWith(delimiter, index)) {
        const char = line[index];
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (pythonStringPrefix && char === '{' && line[index + 1] === '{') {
          index += 2;
          continue;
        }
        if (pythonStringPrefix && char === '{') interpolated = true;
        if (
          quote === '"' &&
          ['ruby', 'elixir'].includes(language) &&
          char === '#' &&
          line[index + 1] === '{'
        ) interpolated = true;
        if (
          quote === '"' && language === 'php' && char === '$' &&
          /[A-Za-z_{]/.test(line[index + 1] || '')
        ) interpolated = true;
        index++;
      }
      const value = line.slice(contentStart, index);
      tokens.push({
        kind: 'string',
        text: line.slice(contentStart - delimiter.length, index),
        value,
        interpolated,
        closed: line.startsWith(delimiter, index),
      });
      if (line.startsWith(delimiter, index)) index += delimiter.length;
      continue;
    }

    PREFLIGHT_IDENTIFIER_PATTERN.lastIndex = index;
    const identifier = PREFLIGHT_IDENTIFIER_PATTERN.exec(line)?.[0];
    if (identifier) {
      tokens.push({ kind: 'identifier', text: identifier });
      index += identifier.length;
      continue;
    }

    PREFLIGHT_NUMBER_PATTERN.lastIndex = index;
    const number = PREFLIGHT_NUMBER_PATTERN.exec(line)?.[0];
    if (number) {
      tokens.push({ kind: 'number', text: number });
      index += number.length;
      continue;
    }

    if (frame.templateExpression) {
      if (line[index] === '{') frame.braces++;
      if (line[index] === '}') frame.braces--;
    }
    // Keep postfix increment/decrement indivisible: their final +/- is not a
    // binary operator that admits a regex operand after a completed value.
    const punctuation = language === 'javascript' && (line.startsWith('++', index) || line.startsWith('--', index))
      ? line.slice(index, index + 2)
      : line[index];
    tokens.push({ kind: 'punctuation', text: punctuation });
    index += punctuation.length;
  }

  // A diff line may end inside a multiline template. Keep all code tokens
  // already observed instead of dropping an unfinished substitution's calls.
  for (const frame of frames) {
    if (frame.kind === 'template') finishTemplate(frame);
  }
  return tokenScopes;
}

function hasSqlSelectFromShape(tokens: PreflightSqlToken[], language: PreflightSourceLanguage): boolean {
  const sourceTokens = language === 'sql' ? tokens : tokens.filter((token) => token.kind === 'string');
  const sourceShape = sourceTokens.map((token) => token.kind === 'string' ? token.value || '' : token.text).join(' ');
  return SQL_SELECT_FROM_PATTERN.test(sourceShape);
}

function matchingParenthesisIndexes(tokens: PreflightSqlToken[]): number[] {
  const matchingIndexes = Array<number>(tokens.length).fill(-1);
  const openIndexes: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text === '(') openIndexes.push(index);
    if (tokens[index].text === ')') {
      const openIndex = openIndexes.pop();
      if (openIndex !== undefined) {
        matchingIndexes[openIndex] = index;
        matchingIndexes[index] = openIndex;
      }
    }
  }
  return matchingIndexes;
}

function isDynamicSqlIdentifier(token: PreflightSqlToken): boolean {
  return token.kind === 'identifier' && !STATIC_SQL_IDENTIFIERS.has(token.text.toLowerCase());
}

function hasDynamicSqlOperand(
  tokens: PreflightSqlToken[],
  matchingIndexes: number[],
  dynamicPrefix: number[],
  index: number,
  direction: -1 | 1
): boolean {
  const token = tokens[index];
  if (!token) return true;
  if (token.kind === 'string') return token.interpolated === true;
  if (token.kind === 'number') return false;
  if (token.kind === 'identifier') return isDynamicSqlIdentifier(token);

  if (token.text === '-' || token.text === '+') {
    const adjacent = tokens[index + direction];
    return !adjacent || adjacent.kind !== 'number';
  }
  if (token.text === '(' && direction === 1) {
    const closeIndex = matchingIndexes[index];
    return closeIndex < 0 || dynamicPrefix[closeIndex] - dynamicPrefix[index + 1] > 0;
  }
  if (token.text === ')' && direction === -1) {
    const openIndex = matchingIndexes[index];
    if (openIndex < 0) return true;
    const callName = tokens[openIndex - 1];
    return Boolean(callName && isDynamicSqlIdentifier(callName)) || dynamicPrefix[index] - dynamicPrefix[openIndex + 1] > 0;
  }

  return true;
}

function tokenNestingDepths(tokens: PreflightSqlToken[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const token of tokens) {
    depths.push(depth);
    if (['(', '[', '{'].includes(token.text)) depth++;
    if ([')', ']', '}'].includes(token.text)) depth = Math.max(0, depth - 1);
  }
  return depths;
}

function hasHoistedRegExpFunctionDeclarationOnLine(tokens: PreflightSqlToken[]): boolean {
  // Token nesting is not binding-scope proof; fail closed on any same-line
  // statement-form declaration rather than exempting from depth coincidence.
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== 'identifier' || tokens[index].text !== 'function') continue;

    let declarationStart = index;
    if (tokens[index - 1]?.text === 'async') declarationStart--;
    const preceding = tokens[declarationStart - 1]?.text;
    if (
      declarationStart !== 0 &&
      ![';', '{', '}', 'export', 'default'].includes(preceding || '')
    ) continue;

    let nameIndex = index + 1;
    if (tokens[nameIndex]?.text === '*') nameIndex++;
    if (tokens[nameIndex]?.kind === 'identifier' && tokens[nameIndex].text === 'RegExp') return true;
  }

  return false;
}

function isDirectEvalCall(tokens: PreflightSqlToken[], index: number): boolean {
  return tokens[index]?.kind === 'identifier' && tokens[index].text === 'eval' &&
    tokens[index + 1]?.text === '(' && tokens[index - 1]?.text !== '.';
}

function isExecPropertyAssignment(tokens: PreflightSqlToken[], propertyIndex: number): boolean {
  const property = tokens[propertyIndex];
  if (property?.kind === 'identifier' && property.text === 'exec') {
    return tokens[propertyIndex - 1]?.text === '.' && tokens[propertyIndex + 1]?.text === '=';
  }
  return property?.kind === 'string' && property.value === 'exec' &&
    tokens[propertyIndex - 1]?.text === '[' && tokens[propertyIndex + 1]?.text === ']' &&
    tokens[propertyIndex + 2]?.text === '=';
}

function hasRegexIntrinsicMutationBarrier(
  tokens: PreflightSqlToken[],
  endIndex: number,
  matchingIndexes: number[],
): boolean {
  // Track only explicit same-line aliases of prototype escape expressions;
  // this is not a general binding or taint analysis.
  const prototypeAliases = new Set<string>();
  for (let index = 0; index < endIndex; index++) {
    const token = tokens[index];
    if (
      token.kind === 'identifier' && token.text === 'RegExp' &&
      tokens[index + 1]?.text === '.' && tokens[index + 2]?.text === 'prototype'
    ) return true;
    if (
      token.kind === 'identifier' && ['eval', 'Function'].includes(token.text) &&
      tokens[index + 1]?.text === '('
    ) return true;

    if (
      token.kind === 'identifier' && token.text === '__proto__' &&
      isExecPropertyAssignment(tokens, index + 2)
    ) return true;
    if (
      token.kind === 'identifier' && token.text === 'constructor' &&
      tokens[index + 1]?.text === '.' && tokens[index + 2]?.text === 'prototype' &&
      isExecPropertyAssignment(tokens, index + 4)
    ) return true;

    if (token.kind === 'identifier' && token.text === 'getPrototypeOf' && tokens[index + 1]?.text === '(') {
      const closeIndex = matchingIndexes[index + 1];
      if (closeIndex > index && isExecPropertyAssignment(tokens, closeIndex + 2)) return true;
    }

    if (
      token.kind === 'identifier' && ['const', 'let', 'var'].includes(token.text) &&
      tokens[index + 1]?.kind === 'identifier' && tokens[index + 2]?.text === '=' &&
      (index === 0 || [';', '{', '}'].includes(tokens[index - 1]?.text || ''))
    ) {
      let declarationEnd = index + 3;
      while (declarationEnd < endIndex && tokens[declarationEnd].text !== ';') declarationEnd++;
      const initializer = tokens.slice(index + 3, declarationEnd);
      const escapesPrototype = initializer.some((candidate, candidateIndex) =>
        candidate.kind === 'identifier' && (
          candidate.text === '__proto__' ||
          (candidate.text === 'getPrototypeOf' && initializer[candidateIndex + 1]?.text === '(') ||
          (candidate.text === 'constructor' && initializer[candidateIndex + 1]?.text === '.' &&
            initializer[candidateIndex + 2]?.text === 'prototype')
        )
      );
      if (escapesPrototype) prototypeAliases.add(tokens[index + 1].text);
    }
    if (
      token.kind === 'identifier' && prototypeAliases.has(token.text) &&
      isExecPropertyAssignment(tokens, index + 2)
    ) return true;
  }
  return false;
}

function regexBindingUseMayMutate(tokens: PreflightSqlToken[], index: number): boolean {
  const next = tokens[index + 1];
  const nextAfterMember = tokens[index + 3];
  if (['=', '++', '--'].includes(next?.text || '') || ['++', '--'].includes(tokens[index - 1]?.text || '')) return true;
  if (next?.text === '+' || next?.text === '-' || next?.text === '*' || next?.text === '/' || next?.text === '%') {
    if (tokens[index + 2]?.text === '=') return true;
  }
  if (next?.text === '.' && nextAfterMember?.text === '=') return true;
  // Only known read/match methods are harmless observations here. Unknown
  // calls, aliases, property writes, and passing the reference elsewhere can
  // change the binding/object and therefore cancel the regex exemption.
  return !(
    next?.text === '.' &&
    ['test', 'exec'].includes(tokens[index + 2]?.text || '') &&
    tokens[index + 3]?.text === '('
  );
}

type PreflightExpressionRange = { start: number; end: number };

function indexPreflightExpressionRanges(
  tokens: PreflightSqlToken[],
  depths: number[],
): PreflightExpressionRange[] {
  const ranges = Array.from({ length: tokens.length }, () => ({ start: 0, end: tokens.length }));
  const startAtDepth: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const depth = depths[index];
    ranges[index].start = startAtDepth[depth] ?? 0;
    if (['(', '[', '{'].includes(tokens[index].text)) startAtDepth[depth + 1] = index + 1;
    if (tokens[index].text === ',') startAtDepth[depth] = index + 1;
  }

  const endAtDepth: number[] = [];
  for (let index = tokens.length - 1; index >= 0; index--) {
    const depth = depths[index];
    ranges[index].end = endAtDepth[depth] ?? tokens.length;
    if (tokens[index].text === ',' || [')', ']', '}'].includes(tokens[index].text)) {
      endAtDepth[depth] = index;
    }
  }
  return ranges;
}

function hasUnsafeSqlConstruction(tokens: PreflightSqlToken[], language: PreflightSourceLanguage): boolean {
  let statement: PreflightSqlToken[] = [];

  const statementHasUnsafeConstruction = (parts: PreflightSqlToken[]): boolean => {
    if (!hasSqlSelectFromShape(parts, language)) return false;

    const hasDynamicSqlExecution = language === 'sql' && parts.some(
      (token) => token.kind === 'identifier' && ['exec', 'execute', 'prepare'].includes(token.text.toLowerCase()),
    );

    const matchingIndexes = matchingParenthesisIndexes(parts);
    const nestingDepths = tokenNestingDepths(parts);
    const expressionRanges = indexPreflightExpressionRanges(parts, nestingDepths);
    const expressionShapeCache = new Map<string, boolean>();
    const expressionHasSqlShape = (tokenIndex: number): boolean => {
      const range = expressionRanges[tokenIndex];
      const key = `${range.start}:${range.end}`;
      if (expressionShapeCache.has(key)) return expressionShapeCache.get(key)!;
      const matches = hasSqlSelectFromShape(parts.slice(range.start, range.end), language);
      expressionShapeCache.set(key, matches);
      return matches;
    };

    for (let index = 0; index < parts.length; index++) {
      if (parts[index].kind !== 'string' || !parts[index].interpolated) continue;
      if (expressionHasSqlShape(index)) return true;
    }

    const dynamicPrefix = [0];
    for (const token of parts) {
      dynamicPrefix.push(dynamicPrefix[dynamicPrefix.length - 1] + Number(isDynamicSqlIdentifier(token) || token.interpolated === true));
    }

    for (let index = 0; index < parts.length; index++) {
      if (parts[index].text !== '+') continue;
      if (language === 'sql' && !hasDynamicSqlExecution) continue;
      if (!expressionHasSqlShape(index)) continue;
      if (
        hasDynamicSqlOperand(parts, matchingIndexes, dynamicPrefix, index - 1, -1) ||
        hasDynamicSqlOperand(parts, matchingIndexes, dynamicPrefix, index + 1, 1)
      ) return true;
    }

    for (let index = 0; index < parts.length - 1; index++) {
      if (parts[index].kind !== 'identifier' || parts[index].text.toLowerCase() !== 'concat' || parts[index + 1].text !== '(') {
        continue;
      }
      if (language === 'sql' && !hasDynamicSqlExecution) continue;
      const close = matchingIndexes[index + 1];
      if (close > index + 2) {
        const argumentsTokens = parts.slice(index + 2, close);
        const methodReceiverCall = parts[index - 1]?.text === '.';
        // A method receiver is part of the containing expression; function-style
        // concat must prove SQL shape from its own arguments.
        const hasQueryShape = methodReceiverCall
          ? expressionHasSqlShape(index)
          : hasSqlSelectFromShape(argumentsTokens, language);
        if (
          hasQueryShape &&
          dynamicPrefix[close] - dynamicPrefix[index + 2] > 0
        ) return true;
      }
    }

    return false;
  };

  for (const token of tokens) {
    if (token.text === ';') {
      if (statementHasUnsafeConstruction(statement)) return true;
      statement = [];
    } else {
      statement.push(token);
    }
  }

  return statementHasUnsafeConstruction(statement);
}

function isUnmodifiedTopLevelRegexBinding(
  tokens: PreflightSqlToken[],
  depths: number[],
  receiverIndex: number,
  callNameIndex: number,
  matchingIndexes: number[],
): boolean {
  const receiver = tokens[receiverIndex];
  if (
    receiver?.kind !== 'identifier' ||
    depths[receiverIndex] !== 0 ||
    depths[callNameIndex] !== 0 ||
    ['.', ']', ')'].includes(tokens[receiverIndex - 1]?.text || '')
  ) return false;

  for (let declarationIndex = 0; declarationIndex + 4 < receiverIndex; declarationIndex++) {
    const keyword = tokens[declarationIndex];
    if (
      depths[declarationIndex] !== 0 ||
      keyword.kind !== 'identifier' ||
      !['const', 'let', 'var'].includes(keyword.text) ||
      tokens[declarationIndex + 1]?.text !== receiver.text ||
      tokens[declarationIndex + 2]?.text !== '=' ||
      tokens[declarationIndex + 3]?.kind !== 'regex' ||
      tokens[declarationIndex + 4]?.text !== ';'
    ) continue;

    // Only exempt the first bare use after a simple regex initializer. An
    // intervening substitution executes in a separate token scope and can
    // mutate this binding, so it cannot establish an unmodified receiver.
    const interveningMutation = tokens.some((token, index) =>
      index > declarationIndex + 3 &&
      index < receiverIndex &&
      ((token.kind === 'identifier' && token.text === receiver.text && regexBindingUseMayMutate(tokens, index)) ||
        (token.kind === 'string' && token.interpolated === true))
    );
    return !interveningMutation &&
      !tokens.slice(0, receiverIndex).some((_, index) => isDirectEvalCall(tokens, index)) &&
      !hasRegexIntrinsicMutationBarrier(tokens, receiverIndex, matchingIndexes);
  }
  return false;
}

function isPrimitiveLiteral(token: PreflightSqlToken): boolean {
  return token.kind === 'number' ||
    (token.kind === 'string' && token.closed === true && token.interpolated !== true) ||
    (token.kind === 'identifier' && ['true', 'false', 'null'].includes(token.text));
}

function isSameLinePrimitiveConst(
  name: string,
  tokens: PreflightSqlToken[],
  depths: number[],
  constructorIndex: number,
): boolean {
  if (depths[constructorIndex] !== 0) return false;
  const occurrences: number[] = [];
  for (let index = 0; index < constructorIndex; index++) {
    if (tokens[index].kind === 'identifier' && tokens[index].text === name) occurrences.push(index);
  }
  // A single bare top-level declaration is evidence of a primitive value;
  // parameters, aliases, property reads, type annotations, and later uses
  // cannot substitute for this evidence. Separate executable scopes are
  // fenced by the constructor's preceding-template barrier below.
  if (occurrences.length !== 1) return false;
  const declaration = occurrences[0];
  return depths[declaration] === 0 &&
    tokens[declaration - 1]?.text === 'const' &&
    (declaration === 1 || tokens[declaration - 2]?.text === ';') &&
    tokens[declaration + 1]?.text === '=' &&
    Boolean(tokens[declaration + 2] && isPrimitiveLiteral(tokens[declaration + 2])) &&
    tokens[declaration + 3]?.text === ';';
}

function hasOnlyPrimitiveTemplateExpressions(
  template: PreflightSqlToken,
  tokens: PreflightSqlToken[],
  depths: number[],
  constructorIndex: number,
): boolean {
  const pending = [template];
  // Walk the lexer-owned expression tree iteratively: no reparse, recursive
  // call stack, or clipping of nested executable substitutions.
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.closed !== true || !current.templateExpressions?.length) return false;
    for (const expression of current.templateExpressions) {
      if (!expression.closed || expression.tokens.length !== 1) return false;
      const atom = expression.tokens[0];
      if (isPrimitiveLiteral(atom)) continue;
      if (atom.kind === 'string' && atom.interpolated === true) {
        pending.push(atom);
      } else if (
        atom.kind !== 'identifier' ||
        !isSameLinePrimitiveConst(atom.text, tokens, depths, constructorIndex)
      ) return false;
    }
  }
  return true;
}

function isUnshadowedRegExpConstructorReceiver(
  tokens: PreflightSqlToken[],
  matchingIndexes: number[],
  depths: number[],
  callNameIndex: number,
): boolean {
  const receiverEnd = callNameIndex - 2;
  if (tokens[receiverEnd]?.text !== ')') return false;
  const constructorOpen = matchingIndexes[receiverEnd];
  const constructorName = constructorOpen - 1;
  const newIndex = constructorName - 1;
  if (
    constructorOpen < 0 ||
    tokens[constructorName]?.kind !== 'identifier' ||
    tokens[constructorName]?.text !== 'RegExp' ||
    tokens[newIndex]?.text !== 'new' ||
    tokens[newIndex - 1]?.text === '.'
  ) return false;

  // The line-local heuristic grants this only to the unqualified intrinsic
  // spelling, with no same-line shadow/reassignment, eval, or prototype write
  // before construction. It is not a whole-file binding proof.
  const shadowOrWrite = tokens.slice(0, constructorName).some((token) =>
    token.kind === 'identifier' && token.text === 'RegExp'
  ) || hasHoistedRegExpFunctionDeclarationOnLine(tokens);
  // Constructor arguments execute before `.exec` is looked up; they can
  // mutate the prototype too, so include the complete receiver expression.
  // Prove the COMPLETE argument list, not just substitutions. Support only
  // the two intrinsic parameters as single closed primitive atoms, proven
  // same-line consts, or untagged templates with primitive substitutions.
  // Calls/getters/coercion, tags, spreads, extra arguments, and compound or
  // unclosed expressions remain default-deny; TS types are not evidence.
  let harmlessArguments = true;
  let argumentCount = 0;
  let argumentIndex = constructorOpen + 1;
  while (argumentIndex < receiverEnd) {
    const argument = tokens[argumentIndex++];
    if (++argumentCount > 2 || !(
      isPrimitiveLiteral(argument) ||
      (argument.kind === 'string' && argument.interpolated === true &&
        hasOnlyPrimitiveTemplateExpressions(argument, tokens, depths, newIndex)) ||
      (argument.kind === 'identifier' &&
        isSameLinePrimitiveConst(argument.text, tokens, depths, newIndex))
    )) {
      harmlessArguments = false;
      break;
    }
    if (argumentIndex === receiverEnd) break;
    // No suffix may execute after a proved atom; only an argument separator
    // (including a trailing comma) is admitted. This also rejects tags whose
    // identifier might itself otherwise look like a primitive binding.
    if (tokens[argumentIndex++].text !== ',') {
      harmlessArguments = false;
      break;
    }
  }
  const precedingExecutableTemplate = tokens.slice(0, newIndex).some((token) =>
    token.kind === 'string' && token.interpolated === true
  );
  return !shadowOrWrite && harmlessArguments && !precedingExecutableTemplate &&
    !hasRegexIntrinsicMutationBarrier(tokens, callNameIndex, matchingIndexes);
}

function isRegexExecMethod(
  tokens: PreflightSqlToken[],
  matchingIndexes: number[],
  depths: number[],
  callNameIndex: number,
): boolean {
  if (tokens[callNameIndex - 1]?.text !== '.') return false;
  let receiverIndex = callNameIndex - 2;
  if (isUnshadowedRegExpConstructorReceiver(tokens, matchingIndexes, depths, callNameIndex)) return true;
  if (tokens[receiverIndex]?.text === ')') {
    const openIndex = matchingIndexes[receiverIndex];
    if (openIndex >= 0 && openIndex + 2 === receiverIndex) receiverIndex = openIndex + 1;
  }
  if (tokens[receiverIndex]?.kind === 'regex') {
    return !hasRegexIntrinsicMutationBarrier(tokens, receiverIndex, matchingIndexes);
  }
  return isUnmodifiedTopLevelRegexBinding(tokens, depths, receiverIndex, callNameIndex, matchingIndexes);
}

function hasUnsafeCommandConstruction(tokens: PreflightSqlToken[]): boolean {
  const matchingIndexes = matchingParenthesisIndexes(tokens);
  const depths = tokenNestingDepths(tokens);
  const commandCalls = new Set(['exec', 'spawn', 'execsync']);

  for (let index = 0; index + 1 < tokens.length; index++) {
    if (tokens[index].kind !== 'identifier' || !commandCalls.has(tokens[index].text.toLowerCase())) continue;
    if (tokens[index + 1].text !== '(') continue;
    if (
      tokens[index].text.toLowerCase() === 'exec' &&
      isRegexExecMethod(tokens, matchingIndexes, depths, index)
    ) continue;

    const close = matchingIndexes[index + 1];
    if (close < index + 2) continue;
    for (let argumentIndex = index + 2; argumentIndex < close; argumentIndex++) {
      const argument = tokens[argumentIndex];
      if (
        argument.kind === 'string' &&
        (argument.interpolated === true || /\$\{[^}]+\}/.test(argument.value || ''))
      ) return true;
      if (argument.kind === 'identifier' && /(?:req|query|body|userInput)/i.test(argument.text)) return true;
      if (argument.text === '+' && (
        tokens[argumentIndex - 1]?.kind === 'identifier' ||
        tokens[argumentIndex + 1]?.kind === 'identifier'
      )) return true;
    }
  }
  return false;
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

      for (const file of parsedFiles) {
        for (const added of file.addedLines) {
          const sourceLanguage = preflightSourceLanguage(file.path);
          const sourceTokenScopes = tokenizePreflightSourceLine(added.text, sourceLanguage);
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

          if (sourceTokenScopes.some((tokens) => hasUnsafeSqlConstruction(tokens, sourceLanguage))) {
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

          if (sourceTokenScopes.some(hasUnsafeCommandConstruction)) {
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
