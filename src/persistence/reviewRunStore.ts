import fs from 'node:fs';
import path from 'node:path';

interface StoreData {
  deliveries: Record<string, string>;
  heads: Record<string, string>;
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
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return { deliveries: {}, heads: {} };
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  claimDelivery(deliveryId: string): boolean {
    if (!deliveryId || this.data.deliveries[deliveryId]) return false;
    this.data.deliveries[deliveryId] = new Date().toISOString();
    this.persist();
    return true;
  }

  markHead(owner: string, repo: string, prNumber: number, headSha: string): void {
    this.data.heads[`${owner}/${repo}#${prNumber}`] = headSha;
    this.persist();
  }

  isCurrentHead(owner: string, repo: string, prNumber: number, headSha: string): boolean {
    return this.data.heads[`${owner}/${repo}#${prNumber}`] === headSha;
  }
}
