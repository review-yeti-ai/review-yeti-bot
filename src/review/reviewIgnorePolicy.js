'use strict';

const {
  DEFAULT_MAX_FILE_DIFF_CHARS,
  MAX_FILE_DIFF_CHARS_CAP,
  REVIEW_IGNORE_RULES,
} = require('./reviewIgnoreCatalog');

function normalizeReviewPath(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

function globToRegExp(pattern) {
  const normalized = normalizeReviewPath(String(pattern || '')).toLowerCase();
  const hasSlash = normalized.includes('/');
  let expression = '';

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];

    if (character === '*' && next === '*') {
      if (afterNext === '/') {
        expression += '(?:.*\\/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
      continue;
    }

    if (character === '*') {
      expression += '[^/]*';
      continue;
    }

    if (character === '?') {
      expression += '[^/]';
      continue;
    }

    expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  const body = hasSlash ? expression : `(?:.*\\/)?${expression}`;
  return new RegExp(`^${body}$`, 'i');
}

function matchReviewGlob(pattern, targetPath) {
  const normalizedTargetPath = normalizeReviewPath(targetPath);
  if (!pattern || !normalizedTargetPath) return false;
  return globToRegExp(pattern).test(normalizedTargetPath);
}

function measureReviewDiffChars(file) {
  if (typeof file?.patch === 'string') return file.patch.length;
  if (typeof file?.content === 'string') return file.content.length;
  return 0;
}

function findMatchingRule(path, patterns) {
  for (const rule of patterns) {
    if (matchReviewGlob(rule.pattern, path)) return rule;
  }
  return null;
}

function classifyReviewFile(file, extraPatterns = [], maxFileDiffChars = DEFAULT_MAX_FILE_DIFF_CHARS) {
  const path = normalizeReviewPath(file?.path);
  const binaryPatch = typeof file?.patch === 'string' && /(^|\n)Binary files .* differ(?:\n|$)/i.test(file.patch);
  const combinedRules = [
    ...REVIEW_IGNORE_RULES,
    ...(Array.isArray(extraPatterns) ? extraPatterns : [])
      .filter((pattern) => typeof pattern === 'string' && pattern.trim() && !pattern.trim().startsWith('!'))
      .map((pattern) => ({
        pattern: pattern.trim(),
        category: 'configured',
        reason: `Repository review ignore pattern matched (${pattern.trim()}).`,
      })),
  ];
  const restoredPatterns = (Array.isArray(extraPatterns) ? extraPatterns : [])
    .filter((pattern) => typeof pattern === 'string' && pattern.trim().startsWith('!'))
    .map((pattern) => pattern.trim().slice(1))
    .filter(Boolean);

  if (binaryPatch && !restoredPatterns.some((pattern) => matchReviewGlob(pattern, path))) {
    return { kind: 'skipped', category: 'binary', reason: 'Binary files are skipped by default.' };
  }

  const match = findMatchingRule(path, combinedRules);
  const restored = match && restoredPatterns.some((pattern) => matchReviewGlob(pattern, path));
  if (match && !restored) {
    return { kind: 'skipped', category: match.category, reason: match.reason };
  }

  const diffChars = measureReviewDiffChars(file);
  if (diffChars > maxFileDiffChars) {
    return {
      kind: 'oversized',
      category: 'oversized',
      reason: 'File diff exceeds the per-file review limit.',
      diffChars,
    };
  }

  return { kind: 'included' };
}

function parsePositiveInteger(rawValue, label) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const normalized = String(rawValue).trim();
  if (!/^\d+$/u.test(normalized) || normalized === '0') {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  if (parsed > MAX_FILE_DIFF_CHARS_CAP) {
    throw new Error(`${label} must be less than or equal to ${MAX_FILE_DIFF_CHARS_CAP}.`);
  }
  return parsed;
}

function resolveMaxFileDiffChars({ parsed, env } = {}) {
  const envValue = env && Object.prototype.hasOwnProperty.call(env, 'MAX_FILE_DIFF_CHARS')
    ? env.MAX_FILE_DIFF_CHARS
    : undefined;
  const parsedValue = parsed && parsed.limits && Object.prototype.hasOwnProperty.call(parsed.limits, 'max_file_diff_chars')
    ? parsed.limits.max_file_diff_chars
    : undefined;

  const chosen = envValue !== undefined && envValue !== null && String(envValue) !== ''
    ? parsePositiveInteger(envValue, 'MAX_FILE_DIFF_CHARS')
    : parsePositiveInteger(parsedValue, 'limits.max_file_diff_chars');

  return chosen ?? DEFAULT_MAX_FILE_DIFF_CHARS;
}

module.exports = {
  matchReviewGlob,
  classifyReviewFile,
  resolveMaxFileDiffChars,
  measureReviewDiffChars,
};
