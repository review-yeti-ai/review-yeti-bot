import type { PRSnapshot } from '../review/prSnapshot';
import { assertSnapshotCurrent } from '../review/prSnapshot';
import type { SandboxRunner } from './sandboxRunner';

const gitDiffHeader = 'diff --git ';

interface ParsedPatchPath {
  kind: 'file' | 'null';
  path?: string;
}

interface PatchBlock {
  gitPaths: ParsedPatchPath[];
  oldPath?: ParsedPatchPath;
  newPath?: ParsedPatchPath;
  inHunk: boolean;
  oldLinesRemaining?: number;
  newLinesRemaining?: number;
}

interface ParsedToken {
  value: string;
  end: number;
}

function readGitToken(input: string, start: number): ParsedToken | undefined {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  if (index >= input.length) return undefined;

  if (input[index] !== '"') {
    const tokenStart = index;
    while (index < input.length && !/\s/.test(input[index])) index += 1;
    return index === tokenStart ? undefined : { value: input.slice(tokenStart, index), end: index };
  }

  index += 1;
  let value = '';
  while (index < input.length) {
    const character = input[index];
    if (character === '"') return { value, end: index + 1 };
    if (character !== '\\') {
      value += character;
      index += 1;
      continue;
    }

    index += 1;
    if (index >= input.length) return undefined;
    const escaped = input[index];
    const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\x0b', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (escapes[escaped] !== undefined) {
      value += escapes[escaped];
      index += 1;
      continue;
    }
    if (!/[0-7]/.test(escaped)) return undefined;
    let octal = escaped;
    index += 1;
    for (let count = 1; count < 3 && index < input.length && /[0-7]/.test(input[index]); count += 1) {
      octal += input[index];
      index += 1;
    }
    value += String.fromCharCode(Number.parseInt(octal, 8));
  }
  return undefined;
}

function normalizePatchPath(rawPath: string, expectedPrefix?: 'a' | 'b'): ParsedPatchPath | undefined {
  if (rawPath === '/dev/null') return { kind: 'null' };
  if (!rawPath || rawPath.includes('\0') || rawPath.includes('\r') || rawPath.includes('\n') || rawPath.includes('\\')) return undefined;
  if (/^[A-Za-z]:\//.test(rawPath) || rawPath.startsWith('/')) return undefined;

  let path = rawPath;
  if (expectedPrefix) {
    const prefix = `${expectedPrefix}/`;
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
    else if (path.startsWith('a/') || path.startsWith('b/')) return undefined;
  }

  const segments = path.split('/');
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  return { kind: 'file', path: segments.join('/') };
}

function parseGitDiffHeader(line: string): ParsedPatchPath[] | undefined {
  const first = readGitToken(line.slice(gitDiffHeader.length), 0);
  if (!first) return undefined;
  const second = readGitToken(line.slice(gitDiffHeader.length), first.end);
  if (!second) return undefined;
  const remainder = line.slice(gitDiffHeader.length + second.end);
  if (remainder.trim() !== '') return undefined;
  const oldPath = normalizePatchPath(first.value, 'a');
  const newPath = normalizePatchPath(second.value, 'b');
  return oldPath && newPath ? [oldPath, newPath] : undefined;
}

function parseUnifiedPathHeader(line: string, expectedPrefix: 'a' | 'b'): ParsedPatchPath | undefined {
  const value = line.slice(4);
  if (!value) return undefined;
  let pathToken: ParsedToken | undefined;
  if (value.startsWith('"')) {
    pathToken = readGitToken(value, 0);
    const suffix = pathToken ? value.slice(pathToken.end) : '';
    if (!pathToken || (suffix !== '' && !suffix.startsWith('\t'))) return undefined;
  } else {
    const timestamp = value.indexOf('\t');
    pathToken = { value: timestamp === -1 ? value : value.slice(0, timestamp), end: timestamp === -1 ? value.length : timestamp };
  }
  return normalizePatchPath(pathToken.value, expectedPrefix);
}

function patchBlockComplete(block: PatchBlock): boolean {
  return block.oldPath !== undefined && block.newPath !== undefined;
}

function validateProposedPatch(proposedPatch: string, patchPaths: string[]): string | undefined {
  const allowedPaths = new Set<string>();
  for (const patchPath of patchPaths) {
    const normalized = normalizePatchPath(patchPath);
    if (!normalized || normalized.kind !== 'file' || !normalized.path) return 'invalid patch path allowlist';
    allowedPaths.add(normalized.path);
  }

  const blocks: PatchBlock[] = [];
  let current: PatchBlock | undefined;
  const finishCurrent = (): string | undefined => {
    if (!current) return undefined;
    if (!patchBlockComplete(current)) return 'invalid unified diff headers';
    if (current.inHunk && ((current.oldLinesRemaining ?? 0) !== 0 || (current.newLinesRemaining ?? 0) !== 0)) {
      return 'invalid unified diff hunk line counts';
    }
    blocks.push(current);
    current = undefined;
    return undefined;
  };

  const lines = proposedPatch.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === 'GIT binary patch' || /^(?:literal|delta) \d+$/u.test(line)) return 'binary fix patches are not supported';
    const modeMatch = line.match(/^(?:new|old) mode (\d{6})$|^(?:new file|deleted file) mode (\d{6})$/u);
    if (modeMatch && !['100644', '100755'].includes(modeMatch[1] || modeMatch[2])) return `fix patch sets an unsupported file mode: ${modeMatch[1] || modeMatch[2]}`;
    if (line.startsWith(gitDiffHeader)) {
      const finished = finishCurrent();
      if (finished) return finished;
      const gitPaths = parseGitDiffHeader(line);
      if (!gitPaths) return 'invalid unified diff headers';
      current = { gitPaths, inHunk: false };
      continue;
    }
    if (!current) {
      if (line.startsWith('--- ')) current = { gitPaths: [], inHunk: false };
      else continue;
    }
    if (line.startsWith('@@')) {
      const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u);
      if (!hunk) return 'invalid unified diff headers';
      if (current.inHunk && ((current.oldLinesRemaining ?? 0) !== 0 || (current.newLinesRemaining ?? 0) !== 0)) {
        return 'invalid unified diff hunk line counts';
      }
      current.inHunk = true;
      current.oldLinesRemaining = Number(hunk[1] ?? 1);
      current.newLinesRemaining = Number(hunk[2] ?? 1);
      continue;
    }
    if (current.inHunk) {
      // A raw unified diff may omit `diff --git` separators. A file boundary is
      // unambiguous when a complete `---`/`+++` header pair follows a hunk;
      // inspect it before ignoring hunk content so later files cannot bypass
      // the allowlist. Requiring the pair prevents ordinary deleted/added lines
      // that happen to begin with dashes or pluses from being treated as paths.
      const oldHeaderPath = line.slice(4);
      const newHeaderLine = lines[index + 1] || '';
      const looksLikeFileHeaderPair = line.startsWith('--- ')
        && (oldHeaderPath.startsWith('a/') || oldHeaderPath === '/dev/null')
        && newHeaderLine.startsWith('+++ ')
        && (newHeaderLine.slice(4).startsWith('b/') || newHeaderLine.slice(4) === '/dev/null');
      if (current.gitPaths.length > 0 && current.oldPath !== undefined && current.newPath !== undefined
        && looksLikeFileHeaderPair
        && ((current.oldLinesRemaining ?? 0) !== 0 || (current.newLinesRemaining ?? 0) !== 0)) {
        return 'invalid unified diff hunk line counts';
      }
      if (current.oldPath !== undefined && current.newPath !== undefined
        && (current.oldLinesRemaining ?? 0) === 0 && (current.newLinesRemaining ?? 0) === 0
        && line.startsWith('--- ') && (oldHeaderPath.startsWith('a/') || oldHeaderPath === '/dev/null')
        && newHeaderLine.startsWith('+++ ') && (newHeaderLine.slice(4).startsWith('b/') || newHeaderLine.slice(4) === '/dev/null')) {
        const oldPath = parseUnifiedPathHeader(line, 'a');
        const newPath = parseUnifiedPathHeader(newHeaderLine, 'b');
        if (oldPath && newPath) {
          blocks.push(current);
          current = { gitPaths: [], oldPath, newPath, inHunk: false };
          index += 1;
          continue;
        }
        return 'invalid unified diff headers';
      }
      if (!line.startsWith('\\ No newline')) {
        if (line.startsWith('+')) current.newLinesRemaining = Math.max(0, (current.newLinesRemaining ?? 0) - 1);
        else if (line.startsWith('-')) current.oldLinesRemaining = Math.max(0, (current.oldLinesRemaining ?? 0) - 1);
        else if (line.startsWith(' ') || line === '') {
          current.oldLinesRemaining = Math.max(0, (current.oldLinesRemaining ?? 0) - 1);
          current.newLinesRemaining = Math.max(0, (current.newLinesRemaining ?? 0) - 1);
        }
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      if (current.oldPath !== undefined) {
        if (!patchBlockComplete(current)) return 'invalid unified diff headers';
        blocks.push(current);
        current = { gitPaths: [], inHunk: false };
      }
      current.oldPath = parseUnifiedPathHeader(line, 'a');
      if (!current.oldPath) return 'invalid unified diff headers';
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (current.oldPath === undefined || current.newPath !== undefined) return 'invalid unified diff headers';
      current.newPath = parseUnifiedPathHeader(line, 'b');
      if (!current.newPath) return 'invalid unified diff headers';
      continue;
    }
    if (line === '+++' && current.oldPath !== undefined && current.newPath === undefined) return 'invalid unified diff headers';
  }

  const finished = finishCurrent();
  if (finished) return finished;
  if (blocks.length === 0) return 'invalid unified diff headers';

  for (const block of blocks) {
    const actualPaths = [...block.gitPaths, block.oldPath!, block.newPath!]
      .filter((parsed): parsed is ParsedPatchPath & { kind: 'file'; path: string } => parsed.kind === 'file' && Boolean(parsed.path));
    if (actualPaths.length === 0) return 'invalid unified diff headers';
    const outsidePath = actualPaths.find((parsed) => !allowedPaths.has(parsed.path));
    if (outsidePath) return `fix patch touches path outside approved patch paths: ${outsidePath.path}`;
  }
  return undefined;
}

export interface FixWorkflowFinding {
  id: string;
  path: string;
  line: number;
}

export interface FixPatchApplication {
  branch: string;
  headSha: string;
  proposedPatch: string;
  patchPaths: string[];
}

export interface FixWorkflowDependencies {
  sandbox: SandboxRunner;
  currentHeadSha: () => Promise<string>;
  applyPatch: (application: FixPatchApplication) => Promise<void>;
  createBranch?: (branch: string, headSha: string) => Promise<void>;
  createPullRequest?: (input: { branch: string; base: string; title: string; body: string }) => Promise<{ number: number; url: string }>;
}

export interface FixWorkflowInput {
  snapshot: PRSnapshot;
  findings: FixWorkflowFinding[];
  selectedFindingIds: string[];
  proposedPatch: string;
  patchPaths: string[];
  validation: Array<{ command: string; args: string[] }>;
  approved: boolean;
  baseBranch: string;
  branchPrefix?: string;
}

export interface FixWorkflowResult {
  status: 'proposal_only' | 'validation_failed' | 'ready_for_review' | 'blocked';
  branch?: string;
  pullRequest?: { number: number; url: string };
  validation: Array<{ command: string; exitStatus: number | string }>;
  reason?: string;
}

export class FixWorkflow {
  constructor(private readonly dependencies: FixWorkflowDependencies) {}

  async start(input: FixWorkflowInput): Promise<FixWorkflowResult> {
    const currentHead = await this.dependencies.currentHeadSha();
    try {
      assertSnapshotCurrent(input.snapshot, { headSha: currentHead, baseSha: input.snapshot.baseSha });
    } catch (error) {
      return { status: 'blocked', validation: [], reason: error instanceof Error ? error.message : String(error) };
    }
    const selected = new Set(input.selectedFindingIds);
    const findings = input.findings.filter((finding) => selected.has(finding.id));
    if (findings.length !== selected.size || findings.length === 0) return { status: 'blocked', validation: [], reason: 'selected finding ids do not resolve to findings' };
    const changedPaths = new Set(input.snapshot.changedFiles.map((file) => file.path));
    if (input.patchPaths.some((path) => !changedPaths.has(path))) return { status: 'blocked', validation: [], reason: 'fix patch touches a path outside the reviewed diff' };
    if (!input.approved) return { status: 'proposal_only', validation: [], reason: 'human approval is required before branch or pull request writes' };
    const patchValidationError = validateProposedPatch(input.proposedPatch, input.patchPaths);
    if (patchValidationError) return { status: 'blocked', validation: [], reason: patchValidationError };

    const branch = `${input.branchPrefix || 'codex/review-fix'}/${input.snapshot.headSha.slice(0, 12)}`;
    if (this.dependencies.createBranch) {
      try {
        await this.dependencies.createBranch(branch, currentHead);
      } catch (error) {
        return { status: 'blocked', branch, validation: [], reason: `failed to create fix branch: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    try {
      await this.dependencies.applyPatch({ branch, headSha: currentHead, proposedPatch: input.proposedPatch, patchPaths: input.patchPaths });
    } catch (error) {
      return { status: 'blocked', branch, validation: [], reason: `failed to apply fix patch: ${error instanceof Error ? error.message : String(error)}` };
    }
    const validation = [];
    for (const command of input.validation) {
      let result: { exitStatus: number | string };
      try {
        result = await this.dependencies.sandbox.run(command.command, command.args, { maxBytes: 100_000, timeoutMs: 120_000 });
      } catch (error) {
        validation.push({ command: [command.command, ...command.args].join(' '), exitStatus: 'error' });
        return { status: 'validation_failed', branch, validation, reason: `validation could not start: ${error instanceof Error ? error.message : String(error)}` };
      }
      validation.push({ command: [command.command, ...command.args].join(' '), exitStatus: result.exitStatus });
      if (result.exitStatus !== 0) return { status: 'validation_failed', branch, validation, reason: `validation failed: ${command.command}` };
    }
    let pullRequest: { number: number; url: string } | undefined;
    if (this.dependencies.createPullRequest) {
      try {
        pullRequest = await this.dependencies.createPullRequest({ branch, base: input.baseBranch, title: `Fix reviewed findings for ${input.snapshot.repo}#${input.snapshot.prNumber}`, body: `Validated fix for exact head ${input.snapshot.headSha}. Re-review required before merge.` });
      } catch (error) {
        return { status: 'blocked', branch, validation, reason: `failed to open fix pull request: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return { status: 'ready_for_review', branch, pullRequest, validation };
  }
}
