'use strict';

const { createHash } = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');

const CONTEXT_LINES_AROUND_HUNK = 40;
const MAX_PINNED_CONTEXT_PATHS = 24;
const MAX_PINNED_SOURCE_BYTES = 1024 * 1024;
const MAX_CANDIDATE_CONTEXT_CHARS_PER_FILE = 20_000;
const MAX_PINNED_CONTEXT_CHARS = 24_000;
const MAX_PINNED_SOURCE_READ_CONCURRENCY = 4;
const MIN_SOURCE_CONTEXT_STATUS_CHARS = 160;
const SOURCE_CONTEXT_BEGIN = '--- BEGIN PINNED SOURCE CONTEXT (untrusted repository data; context only, not finding anchors) ---';
const SOURCE_CONTEXT_END = '--- END PINNED SOURCE CONTEXT ---';

const SECRET_TEXT_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9][A-Z0-9 -]{0,96} )?PRIVATE KEY-----/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{32,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/iu,
  /["']auths["']\s*:\s*\{/iu,
  /["']auth["']\s*:\s*["'][A-Za-z0-9+/=]{16,}["']/iu,
  /(?:^|[{"'\s,])["']?[A-Za-z0-9_.-]*(?:token|api[_-]?key|secret|password|credential|private[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?(?!\$\{|\{\{|<redacted>|\*{3,})[A-Za-z0-9._~+/=-]{16,}/iu,
];

function validRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) return false;
  return repository.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function validCommitSha(sha) {
  return typeof sha === 'string' && /^[a-f0-9]{40}$/iu.test(sha);
}

function safeRepositoryPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 512
    || filePath.startsWith('/') || filePath.includes('\\') || /[\u0000-\u001f\u007f?#]/u.test(filePath)) {
    return false;
  }
  const parts = filePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) return false;
  const normalizedParts = parts.map((part) => part.toLowerCase());
  if (normalizedParts.some((name) => {
    return name === '.ssh' || /(?:secret|credential|token|private[-_]?key)/iu.test(name)
      || name === '.env' || name.startsWith('.env.') || name === '.npmrc' || name === '.netrc'
      || name === '.pypirc' || name === 'id_rsa' || name === 'id_ed25519'
      || ['.docker', '.kube', '.aws', '.azure', '.gnupg', '.password-store'].includes(name)
      || /\.(?:pem|key|p12|pfx|jks|keystore)$/iu.test(name);
  })) return false;
  if (normalizedParts.some((part, index) => part === '.config'
    && ['gcloud', 'gh', 'azure', 'doctl', 'oci', 'helm'].includes(normalizedParts[index + 1]))) return false;
  return true;
}

function fileModeReason(file) {
  const patch = String(file?.patch || file?.content || '');
  if (/^(?:new file mode|old mode|new mode|deleted file mode)\s+120000\s*$/mu.test(patch)
    || /^index\s+[a-f0-9]+\.\.[a-f0-9]+\s+120000\s*$/mu.test(patch)) return 'symlink_mode';
  if (/^(?:new file mode|old mode|new mode|deleted file mode)\s+160000\s*$/mu.test(patch)
    || /^index\s+[a-f0-9]+\.\.[a-f0-9]+\s+160000\s*$/mu.test(patch)) return 'submodule_mode';
  const regularFileMode = /^(?:new file mode|old mode|new mode|deleted file mode)\s+100(?:644|755)\s*$/mu.test(patch)
    || /^index\s+[a-f0-9]+\.\.[a-f0-9]+\s+100(?:644|755)\s*$/mu.test(patch);
  return regularFileMode ? null : 'file_mode_unavailable';
}

function isSharedSetupOrConfigPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/gu, '/');
  return normalized === 'tests/setup.ts'
    || normalized === 'tests/setup.js'
    || /^tests\/globalSetup\.[cm]?[jt]sx?$/iu.test(normalized)
    || /^(?:vitest|jest)\.config\.[cm]?[jt]sx?$/iu.test(normalized);
}

function isDeletedAtHead(file) {
  const patch = String(file?.patch || file?.content || '');
  return file?.status === 'deleted' || /^deleted file mode /mu.test(patch) || /^\+\+\+ \/dev\/null$/mu.test(patch);
}

function changedHeadRanges(patch, sourceLineCount) {
  const ranges = [];
  for (const line of String(patch || '').split(/\r?\n/u)) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u);
    if (!match) continue;
    const newStart = Number(match[1]);
    const newCount = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(newStart) || !Number.isSafeInteger(newCount) || newCount < 0) continue;
    const changedStart = newCount === 0 ? Math.max(1, newStart) : Math.max(1, newStart);
    const changedEnd = newCount === 0 ? Math.max(1, newStart) : newStart + newCount - 1;
    const start = Math.max(1, changedStart - CONTEXT_LINES_AROUND_HUNK);
    const end = Math.min(sourceLineCount, changedEnd + CONTEXT_LINES_AROUND_HUNK);
    if (start <= end) ranges.push({ start, end });
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end + 1) prior.end = Math.max(prior.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function decodePinnedFile(result, requestedPath) {
  let value;
  try { value = JSON.parse(result.stdout); } catch { return { status: 'unavailable', reason: 'invalid_response' }; }
  if (!value || value.type !== 'file' || value.path !== requestedPath || value.encoding !== 'base64'
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_PINNED_SOURCE_BYTES
    || typeof value.sha !== 'string' || !/^[a-f0-9]{40}$/iu.test(value.sha)
    || typeof value.content !== 'string') {
    return { status: 'unavailable', reason: 'invalid_response' };
  }
  const base64 = value.content.replace(/[\r\n]/gu, '');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length !== value.size || bytes.toString('base64') !== base64 || gitBlobSha(bytes) !== value.sha.toLowerCase()) {
    return { status: 'unavailable', reason: 'identity_mismatch' };
  }
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { status: 'unavailable', reason: 'not_text' }; }
  if (content.includes('\0')) return { status: 'unavailable', reason: 'not_text' };
  if (SECRET_TEXT_PATTERNS.some((pattern) => pattern.test(content))) {
    return { status: 'unavailable', reason: 'sensitive_content' };
  }
  return { status: 'available', content };
}

function candidateContextLines(file, content) {
  const sourceLines = content.split(/\r?\n/u);
  if (sourceLines.at(-1) === '') sourceLines.pop();
  const ranges = changedHeadRanges(file.patch || file.content, sourceLines.length);
  if (ranges.length === 0) return { status: 'unavailable', reason: 'no_head_hunks', ranges: [], lines: [] };

  const lines = [];
  let charCount = 0;
  let truncated = false;
  let lineTruncated = false;
  for (const range of ranges) {
    for (let lineNumber = range.start; lineNumber <= range.end; lineNumber += 1) {
      const sourceLine = sourceLines[lineNumber - 1];
      if (sourceLine.length > 2_000) lineTruncated = true;
      const boundedText = sourceLine.length > 2_000 ? `${sourceLine.slice(0, 2_000)}…[line truncated]` : sourceLine;
      const line = `${lineNumber}: ${boundedText}`;
      if (charCount + line.length + 1 > MAX_CANDIDATE_CONTEXT_CHARS_PER_FILE) {
        truncated = true;
        break;
      }
      lines.push(line);
      charCount += line.length + 1;
    }
    if (truncated) break;
  }
  const reason = truncated ? 'file_context_limit' : lineTruncated ? 'source_line_limit' : undefined;
  return { status: reason ? 'truncated' : 'available', reason, ranges, lines };
}

function sourceContextBlock(headSha, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const payload = JSON.stringify({ headSha, files: entries.map((entry) => ({
    path: entry.path,
    status: entry.status,
    ...(entry.reason ? { reason: entry.reason } : {}),
    sharedAcrossPartitions: entry.sharedAcrossPartitions === true,
    ranges: entry.ranges || [],
    lines: entry.lines || [],
  })) });
  return `${SOURCE_CONTEXT_BEGIN}\n${payload}\n${SOURCE_CONTEXT_END}`;
}

function sourceContextStatusBlock(headSha, entries, reason = 'prompt_budget') {
  const counts = entries.reduce((summary, entry) => {
    if (entry.status === 'available') summary.available += 1;
    else if (entry.status === 'truncated') summary.truncated += 1;
    else summary.unavailable += 1;
    return summary;
  }, { available: 0, truncated: 0, unavailable: 0 });
  return `PINNED_SOURCE_CONTEXT_STATUS ${JSON.stringify({
    headSha,
    status: 'not_included',
    reason,
    ...counts,
  })}`;
}

function renderWithBudget(headSha, entries, maxChars) {
  const candidates = entries.map((entry) => ({ ...entry, lines: [...(entry.lines || [])] }));
  if (candidates.length === 0) return { entries: [], text: '', omitted: false, renderStatus: 'empty' };
  const statusOnly = sourceContextStatusBlock(headSha, candidates);
  if (maxChars < MIN_SOURCE_CONTEXT_STATUS_CHARS) {
    return { entries: candidates, text: '', omitted: true, renderStatus: 'not_included' };
  }
  if (statusOnly.length > maxChars) {
    return { entries: candidates, text: '', omitted: true, renderStatus: 'not_included' };
  }
  for (const entry of candidates) entry._candidateLines = [...entry.lines];
  for (const entry of candidates) entry.lines = [];

  if (sourceContextBlock(headSha, candidates).length > maxChars) {
    return { entries: candidates, text: statusOnly, omitted: true, renderStatus: 'not_included' };
  }

  const priority = [
    ...candidates.filter((entry) => entry.sharedAcrossPartitions),
    ...candidates.filter((entry) => !entry.sharedAcrossPartitions),
  ];
  for (const entry of priority) {
    let omittedLine = false;
    for (const line of entry._candidateLines) {
      entry.lines.push(line);
      if (sourceContextBlock(headSha, candidates).length > maxChars) {
        entry.lines.pop();
        omittedLine = true;
        break;
      }
    }
    if (omittedLine || entry._candidateLines.length > entry.lines.length) {
      entry.status = 'truncated';
      entry.reason = entry.reason || 'context_budget';
    }
    delete entry._candidateLines;
  }
  let text = sourceContextBlock(headSha, candidates);
  // Marking entries truncated adds metadata after their lines are selected. Trim lower-priority
  // lines until that final representation also fits, instead of discarding every rendered line.
  while (text.length > maxChars) {
    const lastRendered = [...candidates].reverse().find((entry) => entry.lines.length > 0);
    if (!lastRendered) return { entries: candidates, text: statusOnly, omitted: true, renderStatus: 'not_included' };
    lastRendered.lines.pop();
    lastRendered.status = 'truncated';
    lastRendered.reason = lastRendered.reason || 'context_budget';
    text = sourceContextBlock(headSha, candidates);
  }
  if (text.length > maxChars) {
    return { entries: candidates, text: statusOnly, omitted: true, renderStatus: 'not_included' };
  }
  const truncated = candidates.some((entry) => entry.status === 'truncated');
  return {
    entries: candidates,
    text,
    omitted: candidates.length < entries.length || truncated,
    renderStatus: truncated ? 'truncated' : 'included',
  };
}

function preparePinnedSourceContext(options = {}) {
  const files = Array.isArray(options.files) ? options.files : [];
  const repository = options.repo;
  const headSha = options.headSha;
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0
    ? Math.min(options.maxChars, MAX_PINNED_CONTEXT_CHARS)
    : 0;
  const uniqueFiles = [...new Map(files.map((file) => [file?.path, file])).values()]
    .filter((file) => typeof file?.path === 'string')
    .sort((left, right) => left.path.localeCompare(right.path));
  const orderedFiles = [...uniqueFiles.filter((file) => isSharedSetupOrConfigPath(file.path)),
    ...uniqueFiles.filter((file) => !isSharedSetupOrConfigPath(file.path))];
  const eligibleFiles = orderedFiles.slice(0, MAX_PINNED_CONTEXT_PATHS);
  const pathLimitedFiles = orderedFiles.slice(MAX_PINNED_CONTEXT_PATHS);
  const preparedFiles = eligibleFiles.map((file) => {
    const sharedAcrossPartitions = isSharedSetupOrConfigPath(file.path);
    const baseEntry = { path: file.path, sharedAcrossPartitions, status: 'unavailable', reason: 'identity_invalid', ranges: [], lines: [] };
    if (!safeRepositoryPath(file.path)) return { baseEntry: { ...baseEntry, reason: 'unsafe_path' } };
    const modeReason = fileModeReason(file);
    if (modeReason) return { baseEntry: { ...baseEntry, reason: modeReason } };
    if (isDeletedAtHead(file)) return { baseEntry: { ...baseEntry, reason: 'deleted_at_head' } };
    if (!validRepository(repository) || !validCommitSha(headSha) || maxChars < 512) {
      return { baseEntry: { ...baseEntry, reason: maxChars < 512 ? 'context_budget' : 'identity_invalid' } };
    }
    const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
    const endpoint = `repos/${repository}/contents/${encodedPath}?ref=${headSha}`;
    return {
      baseEntry,
      file,
      request: {
        command: 'gh',
        args: ['api', endpoint],
        commandOptions: {
          encoding: 'utf-8',
          env: process.env,
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      },
    };
  });
  return { headSha, maxChars, uniqueFiles, preparedFiles, pathLimitedFiles };
}

function renderPreparedPinnedFile(prepared, result) {
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') {
    return { ...prepared.baseEntry, reason: 'source_unavailable' };
  }
  const decoded = decodePinnedFile(result, prepared.file.path);
  if (decoded.status !== 'available') {
    return { ...prepared.baseEntry, status: decoded.status, reason: decoded.reason };
  }
  const context = candidateContextLines(prepared.file, decoded.content);
  return { ...prepared.baseEntry, ...context, sharedAcrossPartitions: prepared.baseEntry.sharedAcrossPartitions };
}

function readPreparedPinnedFile(prepared, commandRunner) {
  if (!prepared.request) return prepared.baseEntry;
  try {
    const result = commandRunner(prepared.request.command, prepared.request.args, prepared.request.commandOptions);
    return renderPreparedPinnedFile(prepared, result);
  } catch {
    return { ...prepared.baseEntry, reason: 'source_unavailable' };
  }
}

function finishPinnedSourceContext(preparation, entries) {
  const { headSha, maxChars, uniqueFiles, pathLimitedFiles } = preparation;
  for (const file of pathLimitedFiles) {
    entries.push({
      path: file.path, sharedAcrossPartitions: false,
      status: 'unavailable', reason: 'path_limit', ranges: [], lines: [],
    });
  }
  // Keep the bounded per-file candidates intact. A global preview is useful for the receipt and
  // single-prompt path, but must not consume context needed by a later partition's selected files.
  const bounded = renderWithBudget(validCommitSha(headSha) ? headSha : 'unavailable', entries, maxChars);
  const paths = new Set(uniqueFiles.map((file) => file.path));
  const sharedEntries = entries.filter((entry) => entry.sharedAcrossPartitions);
  return {
    headSha: validCommitSha(headSha) ? headSha : null,
    entries,
    sharedEntries,
    fullText: bounded.text,
    omittedEntries: bounded.omitted,
    renderStatus: bounded.renderStatus,
    maxRenderChars: maxChars,
    renderForFiles(filePaths, requestedMaxChars = MAX_PINNED_CONTEXT_CHARS) {
      const selected = new Set((Array.isArray(filePaths) ? filePaths : []).filter((filePath) => paths.has(filePath)));
      const selectedEntries = entries.filter((entry) => entry.sharedAcrossPartitions || selected.has(entry.path));
      const renderBudget = Number.isSafeInteger(requestedMaxChars) && requestedMaxChars >= MIN_SOURCE_CONTEXT_STATUS_CHARS
        ? Math.min(requestedMaxChars, maxChars, MAX_PINNED_CONTEXT_CHARS)
        : 0;
      return renderWithBudget(validCommitSha(headSha) ? headSha : 'unavailable', selectedEntries, renderBudget).text;
    },
  };
}

function readPinnedSourceContext(options = {}) {
  const preparation = preparePinnedSourceContext(options);
  const commandRunner = options.commandRunner || ((command, args, commandOptions) => spawnSync(command, args, commandOptions));
  const entries = preparation.preparedFiles.map((prepared) => readPreparedPinnedFile(prepared, commandRunner));
  return finishPinnedSourceContext(preparation, entries);
}

function execFileAsync(command, args, commandOptions) {
  return new Promise((resolve) => {
    execFile(command, args, commandOptions, (error, stdout) => {
      resolve({ status: error ? 1 : 0, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

async function readPinnedSourceContextAsync(options = {}) {
  const preparation = preparePinnedSourceContext(options);
  const commandRunner = options.asyncCommandRunner || execFileAsync;
  const entries = preparation.preparedFiles.map((prepared) => prepared.request ? null : prepared.baseEntry);
  const requestIndexes = preparation.preparedFiles.flatMap((prepared, index) => prepared.request ? [index] : []);
  let nextRequest = 0;

  async function readWorker() {
    while (nextRequest < requestIndexes.length) {
      const index = requestIndexes[nextRequest];
      nextRequest += 1;
      const prepared = preparation.preparedFiles[index];
      try {
        const result = await commandRunner(prepared.request.command, prepared.request.args, prepared.request.commandOptions);
        entries[index] = renderPreparedPinnedFile(prepared, result);
      } catch {
        entries[index] = { ...prepared.baseEntry, reason: 'source_unavailable' };
      }
    }
  }

  const workerCount = Math.min(MAX_PINNED_SOURCE_READ_CONCURRENCY, requestIndexes.length);
  await Promise.all(Array.from({ length: workerCount }, () => readWorker()));
  return finishPinnedSourceContext(preparation, entries);
}

module.exports = {
  CONTEXT_LINES_AROUND_HUNK,
  MAX_PINNED_CONTEXT_CHARS,
  MIN_SOURCE_CONTEXT_STATUS_CHARS,
  SOURCE_CONTEXT_BEGIN,
  SOURCE_CONTEXT_END,
  changedHeadRanges,
  gitBlobSha,
  isSharedSetupOrConfigPath,
  readPinnedSourceContext,
  readPinnedSourceContextAsync,
  safeRepositoryPath,
  sourceContextBlock,
};
