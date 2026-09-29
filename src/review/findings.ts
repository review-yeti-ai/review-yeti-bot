/**
 * Structured review findings domain model and parsing utilities.
 * Defines canonical finding types and extraction/normalization logic.
 */

export type FindingSeverity = 'P0' | 'P1' | 'P2';

export interface Finding {
  severity: FindingSeverity;
  file: string;
  line: number;
  title: string;
  description: string;
  suggestedPatch?: string;
}

/**
 * Sanitizes an object into a JSON string suitable for PostgreSQL JSONB:
 * - Strips literal null bytes (\0 and \u0000)
 * - Guards against lone surrogates using String.prototype.toWellFormed or regex
 */
export function sanitizeJsonString(value: unknown): string {
  const replacer = (_key: string, val: unknown) => {
    if (typeof val === 'string') {
      let str = val;
      if (typeof (str as any).toWellFormed === 'function') {
        str = (str as any).toWellFormed();
      } else {
        str = str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
      }
      return str.replace(/\0/g, '').replace(/\\u0000/g, '');
    }
    return val;
  };

  let json = JSON.stringify(value, replacer);
  json = json.replace(/\0/g, '').replace(/\\u0000/g, '');
  return json;
}

/**
 * Normalizes a raw finding item into a structured Finding object.
 * Fails closed by mapping unrecognized or missing severity to P0.
 */
export function normalizeFinding(item: any): Finding {
  let severity: FindingSeverity;
  const rawSev = String(item?.severity || '').toUpperCase().trim();
  if (rawSev === 'P0' || rawSev.includes('BLOCKER') || rawSev.includes('CRITICAL') || rawSev.includes('HIGH')) {
    severity = 'P0';
  } else if (rawSev === 'P2' || rawSev.includes('NIT') || rawSev.includes('LOW')) {
    severity = 'P2';
  } else if (rawSev === 'P1' || rawSev.includes('WARN') || rawSev.includes('MAJOR')) {
    severity = 'P1';
  } else {
    // Missing, unclassified, or unrecognized severity strictly fails closed to P0
    severity = 'P0';
  }

  const lineNum = typeof item?.line === 'number' && !isNaN(item.line)
    ? item.line
    : (parseInt(String(item?.line), 10) || 1);

  return {
    severity,
    file: String(item?.file || item?.path || item?.filename || 'unknown'),
    line: Math.max(1, lineNum),
    title: String(item?.title || item?.summary || item?.headline || 'Review finding'),
    description: String(item?.description || item?.body || item?.details || item?.title || ''),
    ...(item?.suggestedPatch ? { suggestedPatch: String(item.suggestedPatch) } : {}),
  };
}

/**
 * Extracts structured findings from LLM output, handling:
 * 1. Markdown JSON code blocks (```json ... ```)
 * 2. Raw JSON objects ({ "findings": [...] })
 * 3. JSON arrays ([ { "severity": ... } ])
 * 4. Text finding markers (Finding [P0]: in file:line title)
 */
export function extractFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  if (!text || typeof text !== 'string') return findings;

  // 1. Try JSON block extraction
  const jsonBlockRegexes = [
    /```(?:json)?\s*([\s\S]*?)\s*```/gi,
    /(\{[\s\S]*?"findings"[\s\S]*?\})/gi,
    /(\[\s*\{[\s\S]*?"severity"[\s\S]*?\}\s*\])/gi,
  ];

  let parsed = false;
  for (const regex of jsonBlockRegexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const candidate = match[1]?.trim() || match[0]?.trim();
      try {
        const data = JSON.parse(candidate);
        const list = Array.isArray(data) ? data : (Array.isArray(data?.findings) ? data.findings : null);
        if (list && Array.isArray(list)) {
          for (const item of list) {
            if (item && typeof item === 'object') {
              findings.push(normalizeFinding(item));
            }
          }
          if (findings.length > 0) {
            parsed = true;
            break;
          }
        }
      } catch {
        // Continue searching next match
      }
    }
    if (parsed) break;
  }

  // 2. Direct full-string JSON parse
  if (!parsed) {
    try {
      const data = JSON.parse(text.trim());
      const list = Array.isArray(data) ? data : (Array.isArray(data?.findings) ? data.findings : null);
      if (list && Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item === 'object') {
            findings.push(normalizeFinding(item));
          }
        }
        parsed = true;
      }
    } catch {
      // Not JSON
    }
  }

  // 3. Fallback text regex
  if (findings.length === 0) {
    const textFindingRegex = /(?:Finding|Bug|Defect|Issue)\s*\[?(P[0-2])\]?:\s*(?:(?:in|on|at)\s+([^\s:]+)(?::(\d+))?)?\s*([^\n]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = textFindingRegex.exec(text)) !== null) {
      const sev = (match[1].toUpperCase() as FindingSeverity) || 'P1';
      findings.push({
        severity: sev,
        file: match[2] || 'unknown',
        line: match[3] ? parseInt(match[3], 10) : 1,
        title: match[4]?.trim() || 'Review finding',
        description: match[4]?.trim() || '',
      });
      parsed = true;
    }
  }

  // 4. Fail-closed safety: if non-empty output failed to parse into valid findings
  // and does not affirmatively declare a clean review, treat it as unclassified/malformed.
  if (findings.length === 0 && !parsed) {
    const trimmed = text.trim();
    const isCleanAffirmation =
      /\b(?:no\s+(?:blocking\s+)?(?:issues|defects|bugs|findings)\s+(?:found|detected)|clean\s+(?:pr|diff|review|code)|lgtm|looks\s+good\s+to\s+me)\b/i.test(trimmed);
    if (!isCleanAffirmation && trimmed.length > 0) {
      findings.push({
        severity: 'unclassified' as FindingSeverity,
        file: 'unknown',
        line: 1,
        title: 'Malformed or Unrecognized Completion',
        description: `Model output could not be parsed as valid findings or clean review: ${trimmed.slice(0, 120)}`,
      });
    }
  }

  return findings;
}
