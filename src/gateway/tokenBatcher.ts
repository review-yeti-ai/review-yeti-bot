export interface TokenBatcherOptions {
  batchIntervalMs?: number; // default: 50ms
  minBatchChars?: number;   // default: 80 chars (~20 tokens)
}

export class TokenBatcher {
  private buffer: string = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly batchIntervalMs: number;
  private readonly minBatchChars: number;
  private readonly onFlush: (chunk: string) => void;

  constructor(onFlush: (chunk: string) => void, options?: TokenBatcherOptions) {
    this.onFlush = onFlush;
    this.batchIntervalMs = options?.batchIntervalMs ?? 50;
    this.minBatchChars = options?.minBatchChars ?? 80;
  }

  public push(text: string): void {
    if (!text) return;
    this.buffer += text;
    if (this.buffer.length >= this.minBatchChars) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.batchIntervalMs);
      if (typeof (this.timer as any)?.unref === 'function') {
        (this.timer as any).unref();
      }
    }
  }

  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) {
      const chunk = this.buffer;
      this.buffer = '';
      this.onFlush(chunk);
    }
  }

  public cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }

  public get pendingLength(): number {
    return this.buffer.length;
  }
}
