import { RepositoryIndex, RepositoryIndexEpoch, StaleRepositoryIndexError } from './repositoryIndex';

export interface ContextCitation {
  path: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  indexEpoch: number;
  reason: string;
  snippet: string;
}

export interface ContextQuery {
  text: string;
  owner: string;
  repo: string;
  commitSha: string;
  indexEpoch: number;
  paths?: string[];
  limit?: number;
}

export class ContextRetriever {
  constructor(private readonly repositoryIndex: RepositoryIndex) {}

  retrieve(query: ContextQuery): ContextCitation[] {
    const index = this.repositoryIndex.get(query.owner, query.repo, query.indexEpoch);
    if (!index) throw new StaleRepositoryIndexError(`repository index epoch ${query.indexEpoch} is unavailable`);
    this.repositoryIndex.assertCurrent(index, query.commitSha);
    const terms = query.text.toLowerCase().split(/[^a-z0-9_$.-]+/).filter((term) => term.length >= 2);
    const allowedPaths = query.paths && new Set(query.paths.map((path) => path.replace(/^\.\//, '')));
    const citations: Array<ContextCitation & { score: number }> = [];

    for (const file of index.files) {
      if (allowedPaths && !allowedPaths.has(file.path)) continue;
      const lines = file.content.split(/\r?\n/);
      for (const symbol of file.symbols) {
        const haystack = `${symbol.name} ${symbol.signature || ''} ${symbol.docComment || ''}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        if (score === 0) continue;
        citations.push({
          path: file.path,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          commitSha: index.commitSha,
          indexEpoch: index.epoch,
          reason: `symbol match: ${symbol.name}`,
          snippet: lines.slice(Math.max(0, symbol.startLine - 1), symbol.endLine).join('\n'),
          score,
        });
      }
    }
    return citations
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.startLine - right.startLine)
      .slice(0, query.limit ?? 20)
      .map(({ score: _score, ...citation }) => citation);
  }
}
