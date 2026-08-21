export interface VectorEmbedderOptions {
  dimensions?: number; // default: 384
  engine?: 'deterministic' | 'transformer' | 'auto';
  modelName?: string;
  enableSubtokenSplitting?: boolean;
  ngramRange?: [number, number];
}

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
  tokenCount: number;
  model: string;
  durationMs: number;
}

export interface ChunkInput {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  symbolKind?: string;
}

export interface EmbeddedChunk {
  chunk: ChunkInput;
  embedding: number[];
}

export class VectorEmbedder {
  private readonly dimensions: number;
  private readonly engine: string;
  private readonly modelName: string;
  private readonly enableSubtokenSplitting: boolean;
  private readonly ngramRange: [number, number];

  constructor(options: VectorEmbedderOptions = {}) {
    this.dimensions = options.dimensions ?? 384;
    this.engine = options.engine ?? 'auto';
    this.modelName = options.modelName ?? 'local-code-embedder-384d';
    this.enableSubtokenSplitting = options.enableSubtokenSplitting ?? true;
    this.ngramRange = options.ngramRange ?? [3, 5];
  }

  /**
   * Generates a 384-dimensional normalized dense vector for text.
   */
  public async generateEmbedding(text: string): Promise<EmbeddingResult> {
    const startTime = performance.now();
    const tokens = this.tokenizeCode(text);
    const vector = this.projectTokensToVector(tokens);
    const normalized = this.l2Normalize(vector);
    const durationMs = performance.now() - startTime;

    return {
      vector: normalized,
      dimension: this.dimensions,
      tokenCount: tokens.length,
      model: this.modelName,
      durationMs,
    };
  }

  /**
   * Synchronous helper for instant vector generation.
   */
  public generateEmbeddingSync(text: string): EmbeddingResult {
    const startTime = performance.now();
    const tokens = this.tokenizeCode(text);
    const vector = this.projectTokensToVector(tokens);
    const normalized = this.l2Normalize(vector);
    const durationMs = performance.now() - startTime;

    return {
      vector: normalized,
      dimension: this.dimensions,
      tokenCount: tokens.length,
      model: this.modelName,
      durationMs,
    };
  }

  /**
   * Batch generates embeddings for an array of text snippets.
   */
  public async generateBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((text) => this.generateEmbedding(text)));
  }

  /**
   * Embeds a single Code Chunk object.
   */
  public async embedChunk(chunk: ChunkInput): Promise<EmbeddedChunk> {
    const textToEmbed = `${chunk.symbolKind || ''} ${chunk.symbolName || ''} ${chunk.content}`;
    const result = await this.generateEmbedding(textToEmbed);
    return {
      chunk,
      embedding: result.vector,
    };
  }

  /**
   * Embeds multiple Code Chunks in parallel.
   */
  public async embedChunks(chunks: ChunkInput[]): Promise<EmbeddedChunk[]> {
    return Promise.all(chunks.map((chunk) => this.embedChunk(chunk)));
  }

  /**
   * Computes dot-product cosine similarity between two normalized vectors (-1.0 to 1.0).
   */
  public cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error(`Vector dimension mismatch: ${vecA.length} vs ${vecB.length}`);
    }
    let dotProduct = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
    }
    return Math.max(-1.0, Math.min(1.0, dotProduct));
  }

  /**
   * Code Tokenizer: Splits camelCase, snake_case, subwords, and extracts n-grams.
   */
  private tokenizeCode(text: string): string[] {
    const rawTokens = text.split(/[^a-zA-Z0-9_$]+/);
    const tokens: string[] = [];

    for (const raw of rawTokens) {
      if (!raw || raw.length < 2) continue;
      tokens.push(raw.toLowerCase());

      if (this.enableSubtokenSplitting) {
        // Split camelCase, PascalCase & Acronyms (e.g. JSONParser -> JSON Parser, HTTPClient -> HTTP Client)
        const splitText = raw
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
        const subwords = splitText.toLowerCase().split(/\s+/);
        for (const sw of subwords) {
          if (sw.length >= 2) tokens.push(sw);
        }
      }

      // Extract character n-grams for fuzzy matching
      if (raw.length >= this.ngramRange[0]) {
        for (let len = this.ngramRange[0]; len <= Math.min(raw.length, this.ngramRange[1]); len++) {
          for (let i = 0; i <= raw.length - len; i++) {
            tokens.push(`ng_${raw.substring(i, i + len).toLowerCase()}`);
          }
        }
      }
    }
    return tokens;
  }

  /**
   * Feature Hashing Projection to 384 dimensions.
   */
  private projectTokensToVector(tokens: string[]): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tfMap = new Map<string, number>();

    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) || 0) + 1);
    }

    for (const [token, count] of tfMap.entries()) {
      const weight = Math.log(1 + count);
      const hash1 = this.hashString(token);
      const bucket = Math.abs(hash1) % this.dimensions;
      const sign = (hash1 & 1) === 0 ? 1 : -1;
      vec[bucket] += weight * sign;
    }

    return vec;
  }

  private l2Normalize(vec: number[]): number[] {
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      sumSq += vec[i] * vec[i];
    }
    if (sumSq === 0) return vec;
    const norm = Math.sqrt(sumSq);
    return vec.map((val) => val / norm);
  }

  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return hash >>> 0;
  }
}
