// @ts-ignore
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ASTParser, ASTSymbol, SymbolReference, ParseResult } from './astParser';
import { VectorEmbedder, ChunkInput } from './vectorEmbedder';
import { LiveStreamBus } from '../live/liveStreamBus';

export interface IndexingStats {
  filesIndexed: number;
  totalLines: number;
  totalLinesIndexed: number;
  symbolsExtracted: number;
  referencesRecorded: number;
  durationMs: number;
}

export interface SymbolQueryOptions {
  includeCallers?: boolean;
  includeCallees?: boolean;
  includeReferences?: boolean;
  limit?: number;
}

export interface SymbolQueryResult {
  symbolName: string;
  definitions: ASTSymbol[];
  references: SymbolReference[];
  callers: ASTSymbol[];
  callees: ASTSymbol[];
  // Allow array compatibility if indexed directly
  length?: number;
}

export interface SemanticSearchResult {
  filePath: string;
  symbolId?: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
}

export class SymbolGraphStore {
  private db: DatabaseSync;
  private parser: ASTParser;
  private embedder: VectorEmbedder;
  private dbPath: string;

  constructor(dbPath?: string) {
    const defaultPath = process.env.NODE_ENV === 'test' ? ':memory:' : path.join(process.env.CT_REVIEW_DATA_DIR || '/tmp/ct-review-bot', 'symbol_graph.db');
    this.dbPath = dbPath || process.env.CT_REVIEW_SYMBOL_DB || defaultPath;

    if (this.dbPath !== ':memory:' && !this.dbPath.startsWith(':memory:')) {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(this.dbPath);
    this.parser = new ASTParser();
    this.embedder = new VectorEmbedder();

    this.initDatabaseSchema();
  }

  private initDatabaseSchema(): void {
    // Enable WAL mode and high performance pragmas
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.db.exec('PRAGMA temp_store = MEMORY;');
    } catch {
      // In-memory databases may ignore WAL mode
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        file_path TEXT PRIMARY KEY,
        language TEXT NOT NULL,
        hash TEXT NOT NULL,
        line_count INTEGER NOT NULL,
        last_indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL,
        end_column INTEGER NOT NULL,
        container_name TEXT,
        signature TEXT,
        doc_comment TEXT,
        exported INTEGER NOT NULL DEFAULT 0,
        callers TEXT,
        callees TEXT,
        FOREIGN KEY (file_path) REFERENCES files(file_path) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

      CREATE TABLE IF NOT EXISTS references_table (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_symbol_id TEXT,
        target_symbol_name TEXT NOT NULL,
        reference_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        column_num INTEGER NOT NULL,
        context_snippet TEXT,
        FOREIGN KEY (file_path) REFERENCES files(file_path) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_refs_target_name ON references_table(target_symbol_name);
      CREATE INDEX IF NOT EXISTS idx_refs_source_id ON references_table(source_symbol_id);

      CREATE TABLE IF NOT EXISTS call_graph (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_symbol_id TEXT NOT NULL,
        callee_symbol_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_call_graph_caller ON call_graph(caller_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_call_graph_callee ON call_graph(callee_symbol_name);

      CREATE TABLE IF NOT EXISTS vector_embeddings (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        symbol_id TEXT,
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        vector TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vectors_file ON vector_embeddings(file_path);
    `);
  }

  public async indexRepository(
    repoPath: string,
    options: { forceReindex?: boolean } = {}
  ): Promise<IndexingStats> {
    const startTime = performance.now();
    const targetFiles = this.discoverFiles(repoPath);

    let filesIndexed = 0;
    let totalLines = 0;
    let symbolsExtracted = 0;
    let referencesRecorded = 0;

    const existingHashes = new Map<string, string>();
    try {
      const stmt = this.db.prepare('SELECT file_path, hash FROM files');
      const rows = stmt.all() as Array<{ file_path: string; hash: string }>;
      for (const row of rows) {
        existingHashes.set(row.file_path, row.hash);
      }
    } catch {
      // Table empty or first run
    }

    const currentRelPaths = new Set<string>();
    const filesToParse: Array<{ relPath: string; absPath: string; content: string; hash: string }> = [];

    for (const absPath of targetFiles) {
      const relPath = path.relative(repoPath, absPath);
      currentRelPaths.add(relPath);
      const content = fs.readFileSync(absPath, 'utf8');
      const linesCount = content.split(/\r?\n/).length;
      totalLines += linesCount;

      const hash = crypto.createHash('md5').update(content).digest('hex');

      if (!options.forceReindex && existingHashes.get(relPath) === hash) {
        continue; // Skip unchanged file
      }

      filesToParse.push({ relPath, absPath, content, hash });
    }

    const deletedFiles: string[] = [];
    for (const indexedRelPath of existingHashes.keys()) {
      if (!currentRelPaths.has(indexedRelPath)) {
        deletedFiles.push(indexedRelPath);
      }
    }

    if (filesToParse.length === 0 && deletedFiles.length === 0) {
      return {
        filesIndexed: 0,
        totalLines,
        totalLinesIndexed: 0,
        symbolsExtracted: 0,
        referencesRecorded: 0,
        durationMs: performance.now() - startTime,
      };
    }

    // Begin single SQLite batch transaction for high performance
    this.db.exec('BEGIN TRANSACTION;');

    try {
      const deleteFileStmt = this.db.prepare('DELETE FROM files WHERE file_path = ?');
      const deleteSymsStmt = this.db.prepare('DELETE FROM symbols WHERE file_path = ?');
      const deleteRefsStmt = this.db.prepare('DELETE FROM references_table WHERE file_path = ?');
      const deleteCallsStmt = this.db.prepare('DELETE FROM call_graph WHERE file_path = ?');
      const deleteVecsStmt = this.db.prepare('DELETE FROM vector_embeddings WHERE file_path = ?');

      // Prune deleted files
      for (const delPath of deletedFiles) {
        deleteFileStmt.run(delPath);
        deleteSymsStmt.run(delPath);
        deleteRefsStmt.run(delPath);
        deleteCallsStmt.run(delPath);
        deleteVecsStmt.run(delPath);
      }

      const insertFileStmt = this.db.prepare(`
        INSERT INTO files (file_path, language, hash, line_count) VALUES (?, ?, ?, ?)
      `);

      const insertSymStmt = this.db.prepare(`
        INSERT INTO symbols (id, file_path, name, kind, start_line, end_line, start_column, end_column, container_name, signature, doc_comment, exported, callers, callees)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertRefStmt = this.db.prepare(`
        INSERT INTO references_table (source_symbol_id, target_symbol_name, reference_type, file_path, line, column_num, context_snippet)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const insertCallStmt = this.db.prepare(`
        INSERT INTO call_graph (caller_symbol_id, callee_symbol_name, file_path, line)
        VALUES (?, ?, ?, ?)
      `);

      const insertVecStmt = this.db.prepare(`
        INSERT INTO vector_embeddings (id, file_path, symbol_id, content, start_line, end_line, vector)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of filesToParse) {
        deleteFileStmt.run(item.relPath);
        deleteSymsStmt.run(item.relPath);
        deleteRefsStmt.run(item.relPath);
        deleteCallsStmt.run(item.relPath);
        deleteVecsStmt.run(item.relPath);

        const parseResult: ParseResult = this.parser.parseSource(item.relPath, item.content);
        filesIndexed++;

        insertFileStmt.run(item.relPath, parseResult.language, item.hash, parseResult.linesOfCode);

        // Store Symbols
        for (const sym of parseResult.symbols) {
          symbolsExtracted++;
          insertSymStmt.run(
            sym.id,
            sym.filePath,
            sym.name,
            sym.kind,
            sym.startLine,
            sym.endLine,
            sym.startColumn || 0,
            sym.endColumn || 0,
            sym.containerName || null,
            sym.signature || null,
            sym.docComment || null,
            sym.exported ? 1 : 0,
            JSON.stringify(sym.callers || []),
            JSON.stringify(sym.callees || [])
          );

          // Embed symbol content
          const snippetText = `${sym.kind} ${sym.name} ${sym.signature || ''}\n${sym.docComment || ''}`;
          const embeddingRes = this.embedder.generateEmbeddingSync(snippetText);
          insertVecStmt.run(
            `vec_${sym.id}`,
            sym.filePath,
            sym.id,
            snippetText,
            sym.startLine,
            sym.endLine,
            JSON.stringify(embeddingRes.vector)
          );
        }

        // Store References
        for (const ref of parseResult.references) {
          referencesRecorded++;
          insertRefStmt.run(
            ref.sourceSymbolId || null,
            ref.targetSymbolName,
            ref.referenceType,
            ref.filePath,
            ref.line,
            ref.column,
            ref.contextSnippet
          );

          if (ref.referenceType === 'call' && ref.sourceSymbolId) {
            insertCallStmt.run(
              ref.sourceSymbolId,
              ref.targetSymbolName,
              ref.filePath,
              ref.line
            );
          }
        }

        // File-level vector embedding for general semantic search
        const fileEmbeddingRes = this.embedder.generateEmbeddingSync(item.content);
        insertVecStmt.run(
          `vec_file_${item.relPath}`,
          item.relPath,
          null,
          item.content.slice(0, 1000), // First 1k characters
          1,
          parseResult.linesOfCode,
          JSON.stringify(fileEmbeddingRes.vector)
        );
      }

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    const durationMs = performance.now() - startTime;
    return {
      filesIndexed,
      totalLines,
      totalLinesIndexed: totalLines,
      symbolsExtracted,
      referencesRecorded,
      durationMs,
    };
  }

  public async querySymbols(
    symbolName: string,
    options: SymbolQueryOptions = {},
    jobId?: string,
    persona?: string,
  ): Promise<SymbolQueryResult & Array<ASTSymbol>> {
    const symStmt = this.db.prepare('SELECT * FROM symbols WHERE name = ?');
    const symRows = symStmt.all(symbolName) as any[];

    const definitions: ASTSymbol[] = symRows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      startColumn: r.start_column,
      endColumn: r.end_column,
      containerName: r.container_name || undefined,
      signature: r.signature || undefined,
      docComment: r.doc_comment || undefined,
      exported: Boolean(r.exported),
      callers: JSON.parse(r.callers || '[]'),
      callees: JSON.parse(r.callees || '[]'),
    }));

    const refStmt = this.db.prepare('SELECT * FROM references_table WHERE target_symbol_name = ?');
    const refRows = refStmt.all(symbolName) as any[];

    const references: SymbolReference[] = refRows.map((r) => ({
      sourceSymbolId: r.source_symbol_id || undefined,
      targetSymbolName: r.target_symbol_name,
      referenceType: r.reference_type,
      filePath: r.file_path,
      line: r.line,
      column: r.column_num,
      contextSnippet: r.context_snippet,
    }));

    // Find Callers: symbols that call this symbolName
    const callersStmt = this.db.prepare(`
      SELECT DISTINCT s.* FROM symbols s
      JOIN call_graph cg ON cg.caller_symbol_id = s.id
      WHERE cg.callee_symbol_name = ?
    `);
    const callerRows = callersStmt.all(symbolName) as any[];

    const callers: ASTSymbol[] = callerRows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      startColumn: r.start_column,
      endColumn: r.end_column,
      containerName: r.container_name || undefined,
      signature: r.signature || undefined,
      docComment: r.doc_comment || undefined,
      exported: Boolean(r.exported),
    }));


    // Find Callees: symbols called by this symbolName
    const defIds = definitions.map((d) => d.id);
    const callees: ASTSymbol[] = [];
    if (defIds.length > 0) {
      const calleesStmt = this.db.prepare(`
        SELECT DISTINCT s.* FROM symbols s
        JOIN call_graph cg ON cg.callee_symbol_name = s.name
        WHERE cg.caller_symbol_id IN (${defIds.map(() => '?').join(',')})
      `);
      const calleeRows = calleesStmt.all(...defIds) as any[];
      for (const r of calleeRows) {
        callees.push({
          id: r.id,
          name: r.name,
          kind: r.kind,
          filePath: r.file_path,
          startLine: r.start_line,
          endLine: r.end_line,
          startColumn: r.start_column,
          endColumn: r.end_column,
          containerName: r.container_name || undefined,
          signature: r.signature || undefined,
          docComment: r.doc_comment || undefined,
          exported: Boolean(r.exported),
        });
      }
    }

    // Return hybrid result that works as SymbolQueryResult object AND Array of definitions
    const resultObject = {
      symbolName,
      definitions,
      references,
      callers,
      callees,
    };

    // Assign definitions elements to resultObject to enable array indexing result[0]
    definitions.forEach((def, index) => {
      Object.defineProperty(resultObject, index, {
        value: def,
        enumerable: true,
      });
    });
    Object.defineProperty(resultObject, 'length', {
      value: definitions.length,
      enumerable: false,
      writable: true,
    });

    if (jobId) {
      LiveStreamBus.getInstance().publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'ast:lookup',
        persona: (persona as any) || 'architecture',
        data: {
          symbolName,
          filePath: definitions[0]?.filePath || 'unknown',
          callersCount: callers.length,
          calleesCount: callees.length,
          riskScore: 0.1 * (callers.length + callees.length),
        },
      });
    }

    return resultObject as unknown as SymbolQueryResult & Array<ASTSymbol>;
  }

  public queryCallers(symbolName: string): ASTSymbol[] {
    const callersStmt = this.db.prepare(`
      SELECT DISTINCT s.* FROM symbols s
      JOIN call_graph cg ON cg.caller_symbol_id = s.id
      WHERE cg.callee_symbol_name = ?
    `);
    const callerRows = callersStmt.all(symbolName) as any[];
    return callerRows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      startColumn: r.start_column,
      endColumn: r.end_column,
      containerName: r.container_name || undefined,
      signature: r.signature || undefined,
      docComment: r.doc_comment || undefined,
      exported: Boolean(r.exported),
    }));
  }

  public async semanticSearch(
    query: string,
    limit: number = 10
  ): Promise<SemanticSearchResult[]> {
    const queryEmbedding = this.embedder.generateEmbeddingSync(query).vector;

    const stmt = this.db.prepare('SELECT file_path, symbol_id, content, start_line, end_line, vector FROM vector_embeddings');
    const rows = stmt.all() as any[];

    const scoredResults: SemanticSearchResult[] = [];

    for (const row of rows) {
      try {
        const rowVector: number[] = JSON.parse(row.vector);
        const score = this.embedder.cosineSimilarity(queryEmbedding, rowVector);

        scoredResults.push({
          filePath: row.file_path,
          symbolId: row.symbol_id || undefined,
          content: row.content,
          startLine: row.start_line,
          endLine: row.end_line,
          score,
        });
      } catch {
        // Skip invalid vector string
      }
    }

    scoredResults.sort((a, b) => b.score - a.score);
    return scoredResults.slice(0, limit);
  }

  public getCounts(): { nodes: number; edges: number } {
    try {
      const n = this.db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number } | undefined;
      const e = this.db.prepare('SELECT COUNT(*) as cnt FROM references_table').get() as { cnt: number } | undefined;
      return {
        nodes: n?.cnt || 0,
        edges: e?.cnt || 0,
      };
    } catch {
      return { nodes: 0, edges: 0 };
    }
  }

  public async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }

  private discoverFiles(dirPath: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', '.agents', '.ct-memory', 'coverage'].includes(entry.name)) {
          continue;
        }
        results.push(...this.discoverFiles(fullPath));
      } else if (entry.isFile()) {
        if (this.parser.isSupportedFile(fullPath)) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }
}
