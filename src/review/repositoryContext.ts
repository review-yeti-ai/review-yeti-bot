import { PRSnapshot } from './prSnapshot';
import { resolveSubmoduleDecision, SubmodulePolicy, SubmoduleReviewDecision } from './submodulePolicy';
import { ContextCitation, ContextRetriever } from '../indexer/contextRetriever';
import { RepositoryIndex, RepositoryIndexEpoch, RepositorySnapshotInput } from '../indexer/repositoryIndex';

export interface RepositoryContextPolicy extends SubmodulePolicy {
  maxFiles?: number;
  maxBytes?: number;
  packageRoots?: string[];
  codeowners?: string;
}

export interface RepositoryContextResult {
  index: RepositoryIndexEpoch;
  changedPaths: string[];
  changedSymbols: ContextCitation[];
  packageOwners: Record<string, string[]>;
  submodules: SubmoduleReviewDecision[];
  incompleteReasons: string[];
}

export interface RepositoryContextInput {
  snapshot: PRSnapshot;
  files: RepositorySnapshotInput['files'];
  policy: RepositoryContextPolicy;
}

function packageFor(path: string, roots: string[]): string {
  const normalized = path.replace(/^\.\//, '');
  return roots.find((root) => normalized === root || normalized.startsWith(`${root}/`)) || normalized.split('/')[0] || '.';
}

function parseCodeowners(value: string | undefined): Array<{ pattern: string; owners: string[] }> {
  return (value || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const [pattern, ...owners] = line.split(/\s+/);
    return { pattern, owners };
  });
}

function codeownersPatternMatches(path: string, pattern: string): boolean {
  let normalizedPath = path.replace(/^\/+/, '');
  let normalizedPattern = pattern.replace(/^\/+/, '');
  if (normalizedPattern.endsWith('/')) normalizedPattern += '**';
  const hasSlash = normalizedPattern.includes('/');
  let expression = '';
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === '*' && normalizedPattern[index + 1] === '*') {
      if (normalizedPattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  if (!hasSlash) expression = `(?:.*/)?${expression}`;
  return new RegExp(`^${expression}$`).test(normalizedPath);
}

function ownersFor(path: string, rules: Array<{ pattern: string; owners: string[] }>): string[] {
  const matching = rules.filter((rule) => codeownersPatternMatches(path, rule.pattern));
  return matching.length ? matching[matching.length - 1].owners : [];
}

export class RepositoryContext {
  constructor(private readonly repositoryIndex: RepositoryIndex) {}

  resolve(input: RepositoryContextInput): RepositoryContextResult {
    const changedPaths = input.snapshot.changedFiles.map((file) => file.path);
    const maxFiles = input.policy.maxFiles ?? 10_000;
    const maxBytes = input.policy.maxBytes ?? 25_000_000;
    const totalBytes = input.files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0);
    const incompleteReasons: string[] = [];
    if (input.files.length > maxFiles) incompleteReasons.push(`repository exceeds ${maxFiles} file limit`);
    if (totalBytes > maxBytes) incompleteReasons.push(`repository exceeds ${maxBytes} byte limit`);

    const index = this.repositoryIndex.build({
      owner: input.snapshot.owner,
      repo: input.snapshot.repo,
      commitSha: input.snapshot.headSha,
      files: input.files.slice(0, maxFiles),
    });
    const retriever = new ContextRetriever(this.repositoryIndex);
    const changedSymbols = changedPaths.flatMap((path) => retriever.retrieve({
      text: (path.split('/').pop() || path).replace(/\.[^.]+$/, ''),
      owner: index.owner,
      repo: index.repo,
      commitSha: index.commitSha,
      indexEpoch: index.epoch,
      paths: [path],
      limit: 20,
    }));
    const rules = parseCodeowners(input.policy.codeowners);
    const roots = input.policy.packageRoots || ['packages', 'apps', 'src'];
    const packageOwners: Record<string, string[]> = {};
    for (const path of changedPaths) {
      packageOwners[packageFor(path, roots)] = ownersFor(path, rules);
    }
    const submodules = input.snapshot.changedFiles.filter((file) => file.isSubmodule || file.submoduleCandidate || [file.mode, file.oldMode, file.newMode, file.old_mode, file.new_mode].includes('160000')).map((file) => resolveSubmoduleDecision(file, input.policy));
    if (submodules.some((decision) => decision.decision === 'INCOMPLETE_REVIEW' || decision.decision === 'BLOCK')) {
      incompleteReasons.push(...submodules.filter((decision) => decision.decision === 'INCOMPLETE_REVIEW' || decision.decision === 'BLOCK').map((decision) => `${decision.path}: ${decision.reason}`));
    }
    return { index, changedPaths, changedSymbols, packageOwners, submodules, incompleteReasons };
  }
}
