import { ASTParser, ASTSymbol } from './astParser';
import { canonicalJson, sha256 } from '../review/reviewCore';

export interface RepositoryIndexFile {
  path: string;
  content: string;
  symbols: ASTSymbol[];
}

export interface RepositorySnapshotInput {
  owner: string;
  repo: string;
  commitSha: string;
  files: Array<{ path: string; content: string }>;
}

export interface RepositoryIndexEpoch {
  owner: string;
  repo: string;
  epoch: number;
  commitSha: string;
  digest: string;
  stats: { files: number; lines: number; symbols: number };
  files: ReadonlyArray<RepositoryIndexFile>;
}

export class StaleRepositoryIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleRepositoryIndexError';
  }
}

function repositoryKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => freeze(child));
    Object.freeze(value);
  }
  return value;
}

/** Content-addressed, immutable repository epochs for review-time retrieval. */
export class RepositoryIndex {
  private readonly epochs = new Map<string, RepositoryIndexEpoch[]>();
  private readonly nextEpochByRepository = new Map<string, number>();
  private readonly parser: ASTParser;
  private readonly maxEpochsPerRepository: number;

  constructor(parser = new ASTParser(), options: { maxEpochsPerRepository?: number } = {}) {
    this.parser = parser;
    this.maxEpochsPerRepository = Math.max(1, Math.min(Math.floor(options.maxEpochsPerRepository ?? 5), 100));
  }

  build(input: RepositorySnapshotInput): RepositoryIndexEpoch {
    if (!input.commitSha || !/^[a-f0-9]{7,64}$/i.test(input.commitSha)) {
      throw new Error('repository index requires a commit SHA');
    }
    const key = repositoryKey(input.owner, input.repo);
    const files = [...input.files]
      .map((file) => ({ path: file.path.replace(/^\.\//, ''), content: file.content }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const digest = sha256({ owner: input.owner, repo: input.repo, commitSha: input.commitSha, files });
    const existing = (this.epochs.get(key) || []).find((epoch) => epoch.digest === digest);
    if (existing) return existing;

    const previous = this.epochs.get(key) || [];
    const indexedFiles = files.map((file) => {
      const parsed = this.parser.isSupportedFile(file.path)
        ? this.parser.parseSource(file.path, file.content)
        : { symbols: [] as ASTSymbol[] };
      return freeze({ path: file.path, content: file.content, symbols: parsed.symbols.map((symbol) => ({ ...symbol })) });
    });
    const nextEpoch = (this.nextEpochByRepository.get(key) || previous.at(-1)?.epoch || 0) + 1;
    this.nextEpochByRepository.set(key, nextEpoch);
    const epoch = freeze({
      owner: input.owner,
      repo: input.repo,
      epoch: nextEpoch,
      commitSha: input.commitSha,
      digest,
      stats: {
        files: indexedFiles.length,
        lines: indexedFiles.reduce((total, file) => total + file.content.split(/\r?\n/).length, 0),
        symbols: indexedFiles.reduce((total, file) => total + file.symbols.length, 0),
      },
      files: indexedFiles,
    });
    this.epochs.set(key, [...previous, epoch].slice(-this.maxEpochsPerRepository));
    return epoch;
  }

  get(owner: string, repo: string, epoch: number): RepositoryIndexEpoch | null {
    return (this.epochs.get(repositoryKey(owner, repo)) || []).find((candidate) => candidate.epoch === epoch) || null;
  }

  assertCurrent(index: RepositoryIndexEpoch, commitSha: string): void {
    if (index.commitSha !== commitSha) {
      throw new StaleRepositoryIndexError(`repository index epoch ${index.epoch} is bound to ${index.commitSha}, not ${commitSha}`);
    }
    if (sha256({ owner: index.owner, repo: index.repo, commitSha: index.commitSha, files: index.files.map(({ path, content }) => ({ path, content })) }) !== index.digest) {
      throw new StaleRepositoryIndexError(`repository index epoch ${index.epoch} failed integrity verification`);
    }
  }

  static digest(index: RepositoryIndexEpoch): string {
    return sha256(canonicalJson({
      owner: index.owner,
      repo: index.repo,
      commitSha: index.commitSha,
      files: index.files.map(({ path, content }) => ({ path, content })),
    }));
  }
}
