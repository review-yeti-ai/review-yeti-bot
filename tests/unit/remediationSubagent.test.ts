import { describe, it, expect } from 'vitest';
import {
  generateRemediation,
  generateRemediationForFinding,
  type FindingRemediation,
} from '../../src/review/remediationSubagent';
import type { LeanFindingSummary } from '../../src/reviewTaskContract';

describe('Remediation Subagent — On-Demand Remediation Generation', () => {
  const sampleFinding: LeanFindingSummary = {
    severity: 'P0',
    file: 'src/auth/jwt.ts',
    line: 12,
    fingerprint: '1234567890abcdef',
    summary: 'Insecure direct object reference.',
  };

  it('generates structured code replacement snippet with startLine and endLine', async () => {
    const remediation = await generateRemediationForFinding(
      sampleFinding,
      'const data = eval(req.body);',
    );
    expect(remediation.codeReplacement).toBeDefined();
    expect(remediation.codeReplacement?.startLine).toBe(12);
    expect(remediation.codeReplacement?.endLine).toBe(12);
    expect(remediation.codeReplacement?.originalSnippet).toBe('const data = eval(req.body);');
    expect(remediation.codeReplacement?.suggestedSnippet).toContain('safeHandler');
  });

  it('includes actionable alternative fixOptions', () => {
    const remediation = generateRemediation(sampleFinding, 'const x = 1;');
    expect(remediation.fixOptions).toBeDefined();
    expect(remediation.fixOptions?.length).toBeGreaterThanOrEqual(2);
    expect(remediation.fixOptions?.[0]).toContain('src/auth/jwt.ts:12');
  });

  it('retains identical fingerprint to maintain upstream finding identity link', async () => {
    const remediation = await generateRemediationForFinding(sampleFinding, 'const x = 1;');
    expect(remediation.fingerprint).toBe(sampleFinding.fingerprint);
  });

  it('preserves original finding severity, file, and line anchoring in remediation payload', () => {
    const remediation = generateRemediation(sampleFinding, 'let a = 1;');
    expect(remediation.severity).toBe('P0');
    expect(remediation.file).toBe('src/auth/jwt.ts');
    expect(remediation.line).toBe(12);
    expect(remediation.explanation).toContain('P0 on src/auth/jwt.ts:12');
  });

  it('gracefully degrades to explanation when source context is empty, whitespace, or undefined', async () => {
    const emptyRem = await generateRemediationForFinding(sampleFinding, '');
    expect(emptyRem.explanation).toContain('Source context unavailable');
    expect(emptyRem.codeReplacement).toBeUndefined();
    expect(emptyRem.fixOptions?.length).toBeGreaterThanOrEqual(2);

    const wsRem = generateRemediation(sampleFinding, '   \n  \t');
    expect(wsRem.explanation).toContain('Source context unavailable');
    expect(wsRem.codeReplacement).toBeUndefined();

    const undefRem = await generateRemediationForFinding(sampleFinding, undefined);
    expect(undefRem.explanation).toContain('Source context unavailable');
    expect(undefRem.codeReplacement).toBeUndefined();
  });

  it('preserves original line indentation in code replacement', () => {
    const indented = '        const val = eval(input);';
    const rem = generateRemediation(sampleFinding, indented);
    expect(rem.codeReplacement?.originalSnippet).toBe(indented);
    expect(rem.codeReplacement?.suggestedSnippet.startsWith('        ')).toBe(true);
  });

  it('clamps suggested snippet within bounded size when defect is large', () => {
    const longContext = 'line;\n'.repeat(60);
    const rem = generateRemediation(sampleFinding, longContext);
    expect(rem.codeReplacement?.suggestedSnippet.length).toBeLessThanOrEqual(400);
  });

  it('safely handles special characters and template literal backticks', () => {
    const templateCode = 'const query = `SELECT * FROM ${table} WHERE id = ${id}`;';
    const rem = generateRemediation(sampleFinding, templateCode);
    expect(rem.codeReplacement?.originalSnippet).toContain('SELECT');
    expect(rem.codeReplacement?.suggestedSnippet).toBeDefined();
  });

  it('targets the exact line in multi-line source context', () => {
    const multiLineCode = [
      'function test() {',
      '  const a = 1;',
      '  const b = eval(a);', // line 3
      '  return b;',
      '}',
    ].join('\n');
    const findingLine3: LeanFindingSummary = {
      severity: 'P1',
      file: 'src/util.ts',
      line: 3,
      fingerprint: 'abcdef1234567890',
      summary: 'Dangerous eval call.',
    };
    const rem = generateRemediation(findingLine3, multiLineCode);
    expect(rem.codeReplacement?.originalSnippet).toBe('  const b = eval(a);');
    expect(rem.codeReplacement?.suggestedSnippet).toContain('safeHandler');
    expect(rem.codeReplacement?.startLine).toBe(3);
    expect(rem.codeReplacement?.endLine).toBe(3);
  });
});
