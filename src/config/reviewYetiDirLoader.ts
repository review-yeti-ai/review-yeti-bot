import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { DetectionMode, MinimumSeverity } from './schema';

export interface ScopedInstructionRule {
  path: string;
  exclude?: string[];
  instructions: string;
  sourceFile?: string;
}

export interface CustomCheckDefinition {
  id: string;
  name: string;
  rule: string;
  scope: string[];
  exclude?: string[];
  severity: 'P0' | 'P1' | 'P2';
  action: 'comment' | 'request_changes';
  sourceFile?: string;
}

export interface ReviewYetiDirectoryConfig {
  mode?: DetectionMode;
  minSeverity?: MinimumSeverity;
  ignorePatterns: string[];
  ignoreTests: boolean;
  globalInstructions: string[];
  scopedInstructions: ScopedInstructionRule[];
  checks: CustomCheckDefinition[];
}

const DEFAULT_TEST_IGNORE_PATTERNS = [
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/*_spec.*',
];

/**
 * Parses an optional YAML front-matter block (`--- ... ---`) at the top of a Markdown file.
 */
export function parseMarkdownWithFrontMatter(raw: string): {
  attributes: Record<string, any>;
  body: string;
} {
  if (!raw || typeof raw !== 'string') {
    return { attributes: {}, body: '' };
  }
  const trimmed = raw.replace(/^\uFEFF/, '');
  const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { attributes: {}, body: trimmed.trim() };
  }
  let attributes: Record<string, any> = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      attributes = parsed as Record<string, any>;
    }
  } catch {
    attributes = {};
  }
  return {
    attributes,
    body: (match[2] || '').trim(),
  };
}

function normalizeStringArray(val: unknown): string[] {
  if (typeof val === 'string' && val.trim().length > 0) {
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(val)) {
    return val
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Parses `.reviewyeti/ignore`, `.reviewyeti/ignore.md`, or `.reviewyetiignore`.
 * Supports gitignore-style lines as well as YAML front-matter (`ignoreTests: true`, `ignore: [...]`).
 */
export function parseIgnorePatterns(raw: string): {
  patterns: string[];
  ignoreTests: boolean;
} {
  const { attributes, body } = parseMarkdownWithFrontMatter(raw);
  const ignoreTests = Boolean(attributes.ignoreTests || attributes.ignore_tests);
  const frontMatterPatterns = normalizeStringArray(attributes.ignore || attributes.patterns);

  const linePatterns = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('```'));

  const combined = new Set<string>([...frontMatterPatterns, ...linePatterns]);
  if (ignoreTests) {
    for (const pattern of DEFAULT_TEST_IGNORE_PATTERNS) {
      combined.add(pattern);
    }
  }

  return {
    patterns: Array.from(combined),
    ignoreTests,
  };
}

/**
 * Parses a custom instruction Markdown file (`.reviewyeti/instructions.md` or `.reviewyeti/instructions/*.md`).
 */
export function parseCustomInstructionMarkdown(filePath: string, raw: string): {
  globalInstruction?: string;
  scopedRules: ScopedInstructionRule[];
  mode?: DetectionMode;
  minSeverity?: MinimumSeverity;
} {
  const { attributes, body } = parseMarkdownWithFrontMatter(raw);
  const includeGlobs = normalizeStringArray(attributes.include || attributes.paths || attributes.scope || attributes.path);
  const excludeGlobs = normalizeStringArray(attributes.exclude || attributes.ignore);

  const mode = ['fast', 'balanced', 'deep'].includes(String(attributes.mode || '').toLowerCase())
    ? (String(attributes.mode).toLowerCase() as DetectionMode)
    : undefined;
  const minSeverity = ['low', 'medium', 'high', 'critical', 'p0', 'p1', 'p2'].includes(
    String(attributes.min_severity || attributes.minSeverity || '').toLowerCase()
  )
    ? (String(attributes.min_severity || attributes.minSeverity) as MinimumSeverity)
    : undefined;

  if (!body) {
    return { scopedRules: [], mode, minSeverity };
  }

  if (includeGlobs.length === 0) {
    return {
      globalInstruction: body,
      scopedRules: [
        {
          path: '**',
          ...(excludeGlobs.length > 0 ? { exclude: excludeGlobs } : {}),
          instructions: body,
          sourceFile: filePath,
        },
      ],
      mode,
      minSeverity,
    };
  }

  return {
    scopedRules: includeGlobs.map((glob) => ({
      path: glob,
      ...(excludeGlobs.length > 0 ? { exclude: excludeGlobs } : {}),
      instructions: body,
      sourceFile: filePath,
    })),
    mode,
    minSeverity,
  };
}

/**
 * Parses a custom check run Markdown file (`.reviewyeti/checks/*.md`).
 */
export function parseCustomCheckMarkdown(filePath: string, raw: string): CustomCheckDefinition | null {
  const { attributes, body } = parseMarkdownWithFrontMatter(raw);
  if (!body) return null;

  const baseName = path.basename(filePath, path.extname(filePath));
  const id = String(attributes.id || baseName)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'custom-check';
  const name = typeof attributes.name === 'string' && attributes.name.trim()
    ? attributes.name.trim()
    : baseName;

  const rawSeverity = String(attributes.severity || 'P1').toUpperCase();
  let severity: 'P0' | 'P1' | 'P2' = 'P1';
  if (rawSeverity === 'P0' || rawSeverity === 'CRITICAL') severity = 'P0';
  else if (rawSeverity === 'P2' || rawSeverity === 'LOW' || rawSeverity === 'MINOR') severity = 'P2';

  const rawAction = String(attributes.action || '').toLowerCase();
  const action: 'comment' | 'request_changes' =
    rawAction === 'comment' ? 'comment' : severity === 'P2' ? 'comment' : 'request_changes';

  const scope = normalizeStringArray(attributes.include || attributes.scope || attributes.paths);
  const exclude = normalizeStringArray(attributes.exclude || attributes.ignore);

  return {
    id,
    name,
    rule: body,
    scope: scope.length > 0 ? scope : ['**'],
    ...(exclude.length > 0 ? { exclude } : {}),
    severity,
    action,
    sourceFile: filePath,
  };
}

/**
 * Loads `.reviewyeti/` configuration from an in-memory map of relative repository paths to file contents.
 */
export function loadReviewYetiDirectoryFromFiles(
  files: Record<string, string | null | undefined>
): ReviewYetiDirectoryConfig {
  const ignoreSet = new Set<string>();
  let ignoreTests = false;
  const globalInstructions: string[] = [];
  const scopedInstructions: ScopedInstructionRule[] = [];
  const checks: CustomCheckDefinition[] = [];
  let mode: DetectionMode | undefined;
  let minSeverity: MinimumSeverity | undefined;

  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));

  for (const [rawPath, content] of entries) {
    if (typeof content !== 'string' || !content.trim()) continue;
    const relPath = rawPath.replace(/^\.?\//, '');

    if (
      relPath === '.reviewyetiignore' ||
      relPath === '.reviewyeti/ignore' ||
      relPath === '.reviewyeti/ignore.md'
    ) {
      const parsed = parseIgnorePatterns(content);
      for (const p of parsed.patterns) ignoreSet.add(p);
      if (parsed.ignoreTests) ignoreTests = true;
      continue;
    }

    if (
      relPath === '.reviewyeti/instructions.md' ||
      relPath === 'reviewyeti.md' ||
      (relPath.startsWith('.reviewyeti/instructions/') && relPath.endsWith('.md'))
    ) {
      const parsed = parseCustomInstructionMarkdown(relPath, content);
      if (parsed.mode && !mode) mode = parsed.mode;
      if (parsed.minSeverity && !minSeverity) minSeverity = parsed.minSeverity;
      if (parsed.globalInstruction) globalInstructions.push(parsed.globalInstruction);
      scopedInstructions.push(...parsed.scopedRules);
      continue;
    }

    if (relPath.startsWith('.reviewyeti/checks/') && relPath.endsWith('.md')) {
      const check = parseCustomCheckMarkdown(relPath, content);
      if (check) checks.push(check);
    }
  }

  return {
    ...(mode ? { mode } : {}),
    ...(minSeverity ? { minSeverity } : {}),
    ignorePatterns: Array.from(ignoreSet),
    ignoreTests,
    globalInstructions,
    scopedInstructions,
    checks,
  };
}

/**
 * Loads `.reviewyeti/` configuration directly from a local repository root on disk.
 */
export function loadReviewYetiDirectoryFromFs(repoRoot: string): ReviewYetiDirectoryConfig {
  const fileMap: Record<string, string> = {};

  const tryReadFile = (relPath: string) => {
    const fullPath = path.join(repoRoot, relPath);
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        fileMap[relPath] = fs.readFileSync(fullPath, 'utf-8');
      }
    } catch {
      // Ignore unreadable files
    }
  };

  const tryReadDir = (relDir: string) => {
    const fullDir = path.join(repoRoot, relDir);
    try {
      if (fs.existsSync(fullDir) && fs.statSync(fullDir).isDirectory()) {
        const entries = fs.readdirSync(fullDir).sort();
        for (const entry of entries) {
          if (entry.endsWith('.md')) {
            tryReadFile(path.posix.join(relDir, entry));
          }
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  };

  tryReadFile('.reviewyetiignore');
  tryReadFile('reviewyeti.md');
  tryReadFile('.reviewyeti/ignore');
  tryReadFile('.reviewyeti/ignore.md');
  tryReadFile('.reviewyeti/instructions.md');
  tryReadDir('.reviewyeti/instructions');
  tryReadDir('.reviewyeti/checks');

  return loadReviewYetiDirectoryFromFiles(fileMap);
}

/**
 * Merges a parsed `.reviewyeti/` directory configuration into a raw or resolved ReviewYeti config object.
 */
export function applyReviewYetiDirectoryToConfig<T extends Record<string, any>>(
  baseConfig: T,
  dirConfig: ReviewYetiDirectoryConfig
): T {
  const next: Record<string, any> = { ...baseConfig };

  if (dirConfig.mode && !next.mode) {
    next.mode = dirConfig.mode;
  }
  if (dirConfig.minSeverity && !next.min_severity) {
    next.min_severity = dirConfig.minSeverity;
  }

  if (dirConfig.ignorePatterns.length > 0) {
    const existingFilters = Array.isArray(next.path_filters) ? next.path_filters : [];
    const filterNegations = dirConfig.ignorePatterns.map((p) => (p.startsWith('!') ? p : `!${p}`));
    next.path_filters = Array.from(new Set([...existingFilters, ...filterNegations]));

    const existingAutoIgnore = Array.isArray(next.auto_review?.ignore_patterns)
      ? next.auto_review.ignore_patterns
      : [];
    next.auto_review = {
      ...(next.auto_review || {}),
      ignore_patterns: Array.from(new Set([...existingAutoIgnore, ...dirConfig.ignorePatterns])),
    };
  }

  if (dirConfig.scopedInstructions.length > 0) {
    const existingPathInstructions = Array.isArray(next.path_instructions)
      ? next.path_instructions
      : [];
    const mapped = dirConfig.scopedInstructions.map((rule) => ({
      path: rule.path,
      instructions: rule.instructions,
    }));
    next.path_instructions = [...existingPathInstructions, ...mapped];
    next.reviews = {
      ...(next.reviews || {}),
      ...(dirConfig.mode && !next.reviews?.mode ? { mode: dirConfig.mode } : {}),
      ...(dirConfig.minSeverity && !next.reviews?.min_severity ? { min_severity: dirConfig.minSeverity } : {}),
      path_instructions: [
        ...(Array.isArray(next.reviews?.path_instructions) ? next.reviews.path_instructions : []),
        ...mapped,
      ],
    };
  }

  if (dirConfig.globalInstructions.length > 0) {
    const existingCustom = Array.isArray(next.knowledge_base?.custom_instructions)
      ? next.knowledge_base.custom_instructions
      : [];
    next.knowledge_base = {
      ...(next.knowledge_base || {}),
      custom_instructions: [...existingCustom, ...dirConfig.globalInstructions],
    };
  }

  if (dirConfig.checks.length > 0) {
    const existingRules = Array.isArray(next.rules) ? next.rules : [];
    const mappedChecks = dirConfig.checks.map((c) => ({
      id: c.id,
      rule: c.rule,
      scope: c.scope,
      severity: c.severity,
    }));
    next.rules = [...existingRules, ...mappedChecks];
  }

  return next as T;
}
