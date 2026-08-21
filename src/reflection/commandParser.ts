export interface ParsedReflectionCommand {
  type: 'learning' | 'nit' | 'adr';
  category: string;
  title?: string;
  description?: string;
  pattern?: string;
  reason?: string;
  filePath?: string;
  adrNumber?: number;
  targetPaths?: string[];
  rawText: string;
}

export function parseLearnCommand(commentText: string): { isLearnCommand: boolean; pattern: string | null; rule?: string } {
  if (!commentText) {
    return { isLearnCommand: false, pattern: null };
  }
  const trimmed = commentText.trim();
  const match = trimmed.match(/@(ct-review|ct-review-bot|bot)\s+learn\s+([\s\S]+)/i);
  if (!match) {
    return { isLearnCommand: false, pattern: null };
  }
  const rawPattern = match[2].trim();
  return {
    isLearnCommand: true,
    pattern: rawPattern,
    rule: rawPattern,
  };
}

export class ReflectionCommandParser {
  public parse(text: string, context?: { filePath?: string }): ParsedReflectionCommand | null {
    if (!text || typeof text !== 'string') return null;

    const match = text.match(/@(ct-review|ct-review-bot|bot)\s+learn\s+([\s\S]+)/i);
    if (!match) return null;

    const body = match[2].trim();
    if (!body) return null;

    // 1. ADR Format: adr 42: Title | Description | path
    const adrMatch = body.match(/^adr\s+(\d+):\s*([^|]+)\s*\|\s*([^|]+)(?:\s*\|\s*([\s\S]+))?$/i);
    if (adrMatch) {
      const adrNumber = parseInt(adrMatch[1], 10);
      const title = adrMatch[2].trim();
      const description = adrMatch[3].trim();
      const rawPaths = adrMatch[4]?.trim() || '**';
      const targetPaths = rawPaths.split(',').map((p) => p.trim());
      return {
        type: 'adr',
        category: 'adr',
        adrNumber,
        title,
        description,
        targetPaths,
        rawText: text,
      };
    }

    // 2. Nit Format: nit: pattern | reason
    const nitMatch = body.match(/^nit:\s*([^|]+)(?:\s*\|\s*([\s\S]+))?$/i);
    if (nitMatch) {
      const pattern = nitMatch[1].trim();
      const reason = nitMatch[2]?.trim() || 'User requested nit suppression';
      return {
        type: 'nit',
        category: 'nit',
        pattern,
        reason,
        filePath: context?.filePath || '',
        rawText: text,
      };
    }

    // 3. Categorized Learning: category: Title - Description
    const catMatch = body.match(/^(convention|architecture|security|performance|style):\s*([^-]+)\s*-\s*([\s\S]+)$/i);
    if (catMatch) {
      const category = catMatch[1].toLowerCase();
      const title = catMatch[2].trim();
      const description = catMatch[3].trim();
      return {
        type: 'learning',
        category,
        title,
        description,
        rawText: text,
      };
    }

    // 4. Fallback Generic Learning
    return {
      type: 'learning',
      category: 'convention',
      title: body.split('\n')[0].slice(0, 50).trim(),
      description: body,
      rawText: text,
    };
  }
}

