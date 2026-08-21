import fs from 'node:fs';
import path from 'node:path';

interface ThreadRecord {
  path: string;
  line: number;
  title: string;
  state: string;
  status: string;
}

interface StoreData {
  deliveries: Record<string, string>;
  heads: Record<string, string>;
  previousHeads?: Record<string, string>;
  threads?: Record<string, ThreadRecord>;
}

export class ReviewRunStore {
  private readonly filePath: string;
  private data: StoreData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.read();
  }

  private read(): StoreData {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        deliveries: parsed.deliveries || {},
        heads: parsed.heads || {},
        previousHeads: parsed.previousHeads || {},
        threads: parsed.threads || {},
      };
    } catch {
      return { deliveries: {}, heads: {}, previousHeads: {}, threads: {} };
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  private getKey(arg1: string | number, arg2?: string | number, arg3?: number): string {
    if (typeof arg1 === 'number') {
      return String(arg1);
    }
    if (arg2 !== undefined && arg3 !== undefined) {
      return `${arg1}/${arg2}#${arg3}`;
    }
    return String(arg1);
  }

  private getItemPath(item: any): string {
    return item?.filePath || item?.path || '';
  }

  private getItemLine(item: any): number {
    return item?.lineNumber ?? item?.line ?? 0;
  }

  claimDelivery(deliveryId: string): boolean {
    this.data = this.read();
    if (!deliveryId || this.data.deliveries[deliveryId]) return false;
    this.data.deliveries[deliveryId] = new Date().toISOString();
    this.persist();
    return true;
  }

  getHead(arg1: string | number, arg2?: string | number, arg3?: number): string | undefined {
    this.data = this.read();
    const key = this.getKey(arg1, arg2, arg3);
    const val = this.data.heads[key];
    if (val !== undefined) return val;
    if (typeof arg3 === 'number') {
      return this.data.heads[String(arg3)];
    }
    if (typeof arg1 === 'number') {
      return this.data.heads[String(arg1)];
    }
    return undefined;
  }

  getPreviousHead(arg1: string | number, arg2?: string | number, arg3?: number): string | undefined {
    this.data = this.read();
    const key = this.getKey(arg1, arg2, arg3);
    const val = this.data.previousHeads?.[key];
    if (val !== undefined) return val;
    if (typeof arg3 === 'number') {
      return this.data.previousHeads?.[String(arg3)];
    }
    if (typeof arg1 === 'number') {
      return this.data.previousHeads?.[String(arg1)];
    }
    return undefined;
  }

  markHead(arg1: string | number, arg2?: string | number, arg3?: number | string, arg4?: string): void {
    this.data = this.read();
    let keys: string[] = [];
    let headSha: string = '';

    if (typeof arg1 === 'number' && typeof arg2 === 'string') {
      keys = [String(arg1)];
      headSha = arg2;
    } else if (typeof arg1 === 'string' && typeof arg2 === 'string' && typeof arg3 === 'number' && typeof arg4 === 'string') {
      keys = [`${arg1}/${arg2}#${arg3}`, String(arg3)];
      headSha = arg4;
    } else {
      keys = [String(arg1)];
      headSha = String(arg2 || '');
    }

    for (const key of keys) {
      const current = this.data.heads[key];
      if (current && current !== headSha) {
        if (!this.data.previousHeads) this.data.previousHeads = {};
        this.data.previousHeads[key] = current;
      }
      this.data.heads[key] = headSha;
    }
    this.persist();
  }

  setHead(arg1: string | number, arg2?: string | number, arg3?: number | string, arg4?: string): void {
    this.markHead(arg1, arg2, arg3, arg4);
  }

  isCurrentHead(owner: string, repo: string, prNumber: number, headSha: string): boolean {
    this.data = this.read();
    const key = `${owner}/${repo}#${prNumber}`;
    return this.data.heads[key] === headSha || this.data.heads[String(prNumber)] === headSha;
  }

  recordThread(prNumber: number, itemPath: string, line: number, title: string, state: string = 'ACTIVE'): void {
    this.data = this.read();
    const key = `${prNumber}:${itemPath}:${line}:${title}`;
    if (!this.data.threads) this.data.threads = {};
    this.data.threads[key] = { path: itemPath, line, title, state, status: state };
    this.persist();
  }

  resolveThread(prNumber: number, itemPath: string, line: number, title: string): void {
    this.data = this.read();
    const key = `${prNumber}:${itemPath}:${line}:${title}`;
    if (!this.data.threads) this.data.threads = {};
    if (this.data.threads[key]) {
      this.data.threads[key].state = 'RESOLVED';
      this.data.threads[key].status = 'RESOLVED';
    } else {
      this.data.threads[key] = { path: itemPath, line, title, state: 'RESOLVED', status: 'RESOLVED' };
    }
    this.persist();
  }

  recordThreads(prNumber: number, batch: Array<any>): void {
    if (!Array.isArray(batch)) return;
    for (const b of batch) {
      this.recordThread(prNumber, this.getItemPath(b), this.getItemLine(b), b.title, 'ACTIVE');
    }
  }

  filterResolvedNits(
    prNumber: number,
    findings: Array<any>
  ): Array<any> {
    if (!Array.isArray(findings)) return [];
    this.data = this.read();
    const threads = this.data.threads || {};
    return findings.filter((f) => {
      const fPath = this.getItemPath(f);
      const fLine = this.getItemLine(f);
      const key = `${prNumber}:${fPath}:${fLine}:${f.title}`;
      return !threads[key];
    });
  }
}
