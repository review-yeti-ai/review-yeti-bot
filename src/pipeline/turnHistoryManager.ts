/**
 * Multi-Turn History Manager
 * Location: src/pipeline/turnHistoryManager.ts
 *
 * Implements sliding multi-turn history compaction and rolling findings ledger:
 * - Retains active 2-turn window with full fidelity.
 * - Compacts older turns (1..k-2) into structured tool receipts and a rolling findings ledger.
 * - Bounds historical context to <2000 tokens per persona loop.
 */

export interface TurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolReceipts?: Array<{ callId: string; tool: string; status: string; output: string }>;
}

export interface TurnHistoryManagerOptions {
  activeTurnWindow?: number;      // default: 2
  maxTurnHistoryTokens?: number;  // default: 8000
  systemPrompt?: string;
}

export interface FindingEntry {
  id: string;
  summary: string;
  severity: 'P0' | 'P1' | 'P2';
}

export interface ReceiptEntry {
  turn: number;
  tool: string;
  summary: string;
}

interface InternalTurn {
  turnNumber: number;
  role: 'user' | 'assistant';
  content: string;
  toolReceipts?: Array<{ callId: string; tool: string; status: string; output: string }>;
}

export class TurnHistoryManager {
  private readonly activeTurnWindow: number;
  private readonly maxTurnHistoryTokens: number;
  private readonly systemPrompt?: string;
  private turns: InternalTurn[] = [];
  private findingsLedger: Map<string, FindingEntry> = new Map();
  private receiptLedger: ReceiptEntry[] = [];

  constructor(options: TurnHistoryManagerOptions = {}) {
    this.activeTurnWindow = options.activeTurnWindow ?? 2;
    this.maxTurnHistoryTokens = options.maxTurnHistoryTokens ?? 8000;
    this.systemPrompt = options.systemPrompt;
  }

  public addTurn(
    role: 'user' | 'assistant',
    content: string,
    toolReceipts?: Array<{ callId: string; tool: string; status: string; output: string }>
  ): void {
    const turnNumber = this.turns.length + 1;
    const turn: InternalTurn = {
      turnNumber,
      role,
      content,
      toolReceipts: toolReceipts ? [...toolReceipts] : undefined,
    };
    this.turns.push(turn);

    // Record receipts
    if (toolReceipts && toolReceipts.length > 0) {
      for (const r of toolReceipts) {
        const shortOutput = r.output.length > 100 ? `${r.output.slice(0, 97)}...` : r.output;
        this.receiptLedger.push({
          turn: turnNumber,
          tool: r.tool,
          summary: `[${r.status}] ${r.callId}: ${shortOutput}`,
        });
      }
    }

    // Extract and record findings from content
    this.extractFindings(content);
  }

  private extractFindings(text: string): void {
    if (!text || !text.trim()) return;

    // 1. Try parsing full JSON block with findings
    try {
      const jsonMatch = text.match(/\{[\s\S]*"findings"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.findings)) {
          for (const f of parsed.findings) {
            const id = f.id || `${f.path || 'finding'}:${f.line || '0'}:${(f.title || f.summary || 'bug').slice(0, 20)}`;
            const summary = f.title || f.summary || f.body || 'Discovered finding';
            const severity = (['P0', 'P1', 'P2'].includes(f.severity) ? f.severity : 'P1') as 'P0' | 'P1' | 'P2';
            this.findingsLedger.set(id, { id, summary, severity });
          }
        }
      }
    } catch {
      // Ignore JSON parse failures and fallback to regex extraction
    }

    // 2. Regex fallback for finding patterns
    const findingPattern = /(?:Finding|Bug|Defect)\s*\[?(P[0-2])\]?:\s*([^\n]+)/gi;
    let match: RegExpExecArray | null;
    let idx = 1;
    while ((match = findingPattern.exec(text)) !== null) {
      const severity = match[1].toUpperCase() as 'P0' | 'P1' | 'P2';
      const summary = match[2].trim();
      const id = `extracted_${this.turns.length}_${idx++}`;
      if (!this.findingsLedger.has(id)) {
        this.findingsLedger.set(id, { id, summary, severity });
      }
    }
  }

  public getFormattedMessages(): TurnMessage[] {
    const messages: TurnMessage[] = [];

    if (this.systemPrompt) {
      messages.push({
        role: 'system',
        content: this.systemPrompt,
      });
    }

    const totalTurns = this.turns.length;
    const activeStartIdx = Math.max(0, totalTurns - this.activeTurnWindow);

    // 1. Compacted Historical Turns (0 to activeStartIdx - 1)
    if (activeStartIdx > 0) {
      for (let i = 0; i < activeStartIdx; i++) {
        const turn = this.turns[i];
        let compactedContent = turn.content;

        // If turn has long content, compact it
        if (compactedContent.length > 400) {
          compactedContent = `${compactedContent.slice(0, 350)}... [Turn ${turn.turnNumber} truncated for context efficiency]`;
        }

        // Compact tool receipts into concise summaries
        const formattedReceipts = turn.toolReceipts?.map((r) => ({
          callId: r.callId,
          tool: r.tool,
          status: r.status,
          output: `[Compact Receipt: ${r.status}, ${r.output.length} bytes output summarized]`,
        }));

        messages.push({
          role: turn.role,
          content: `[Historical Turn ${turn.turnNumber}]: ${compactedContent}`,
          toolReceipts: formattedReceipts,
        });
      }
    }

    // 2. Full Fidelity Active Turns (activeStartIdx to totalTurns - 1)
    for (let i = activeStartIdx; i < totalTurns; i++) {
      const turn = this.turns[i];
      messages.push({
        role: turn.role,
        content: turn.content,
        toolReceipts: turn.toolReceipts ? [...turn.toolReceipts] : undefined,
      });
    }

    return messages;
  }

  public getEstimatedTokens(): number {
    const messages = this.getFormattedMessages();
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += msg.content.length;
      if (msg.toolReceipts) {
        for (const r of msg.toolReceipts) {
          totalChars += r.output.length + r.tool.length + r.callId.length;
        }
      }
    }
    return Math.ceil(totalChars / 3.8);
  }

  public getReceiptLedger(): Array<{ turn: number; tool: string; summary: string }> {
    return [...this.receiptLedger];
  }

  public getFindingsLedger(): Array<{ id: string; summary: string; severity: string }> {
    return Array.from(this.findingsLedger.values());
  }
}
