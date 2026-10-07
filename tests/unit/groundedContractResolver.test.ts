import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/review/groundedEvidenceV2';
import { groundedRelativeImportCandidates, parseGroundedRelativeImports, resolveGroundedExportAtLine,
  resolveGroundedExportDefinition } from '../../src/review/groundedContractResolver';

describe('grounded contract resolver', () => {
  it('resolves a named import to the exact complete exported definition in a large file', () => {
    const declaration = "import { safeHelper as localHelper } from './helper';\r\n";
    const importer = `${declaration}localHelper(value);\r\n`;
    const definition = 'export function safeHelper(value: string) { return value.trim(); }\r\n';
    const helper = `${Array.from({ length: 1_000 }, (_, index) => `const unused${index} = '${'x'.repeat(40)}';\r\n`).join('')}${definition}`;
    expect(Buffer.byteLength(helper, 'utf8')).toBeGreaterThan(24_000);

    const imports = parseGroundedRelativeImports(importer, 'src/caller.ts');
    expect(imports).toMatchObject({ complete: true, declarations: [{ specifier: './helper', symbols: ['safeHelper'] }] });
    if (!imports.complete) throw new Error(imports.reason);
    const resolved = resolveGroundedExportDefinition(helper, 'src/helper.ts', 'safeHelper');
    expect(resolved.complete).toBe(true);
    if (!resolved.complete) throw new Error(resolved.reason);
    expect(resolved.source).toBe(definition);
    expect(resolved.startLine).toBe(1_001);
    expect(resolved.endLine).toBe(1_001);
    expect(resolved.digest).toBe(sha256Bytes(Buffer.from(definition, 'utf8')));
  });

  it('resolves imported aliases through a named local export', () => {
    const source = 'function internalGuard(value: string) { return value.trim(); }\nexport { internalGuard as publicGuard };\n';
    const resolved = resolveGroundedExportDefinition(source, 'src/helper.ts', 'publicGuard');
    expect(resolved).toMatchObject({ complete: true, startLine: 1, endLine: 1, symbols: ['internalGuard', 'publicGuard'] });
  });

  it('keeps extensionless relative targets ambiguous and explicit source targets singular', () => {
    expect(groundedRelativeImportCandidates('src/handler.ts', './security'))
      .toContain('src/security/index.ts');
    expect(groundedRelativeImportCandidates('src/handler.ts', './security.ts')).toEqual(['src/security.ts']);
  });

  it('binds a deleted candidate line to the exact exported definition it removed', () => {
    const source = 'export function authorize(request: Request) {\n  return request.session !== null;\n}\n';
    expect(resolveGroundedExportAtLine(source, 'src/authorization.ts', 2))
      .toMatchObject({ complete: true, symbol: 'authorize', definition: { startLine: 1, endLine: 3 } });
    expect(resolveGroundedExportAtLine('export const one = 1;\nexport const two = 2;\n', 'src/multi.ts', 1))
      .toMatchObject({ complete: true, symbol: 'one' });
  });

  it.each([
    { name: 'side-effect imports', source: "import './polyfills';\n" },
    { name: 'namespace imports', source: "import * as helper from './helper';\nhelper.safe();\n" },
    { name: 'dynamic relative imports', source: "const helper = await import('./helper');\n" },
    { name: 'require calls', source: "const helper = require('./helper');\n" },
  ])('marks $name as unsupported instead of assuming no contract', ({ source }) => {
    expect(parseGroundedRelativeImports(source, 'src/caller.ts')).toMatchObject({ complete: false });
  });

  it.each([
    "export { authorize } from './security';\n",
    "export * from './security';\n",
    "export * as security from './security';\n",
  ])('marks relative re-exports as unsupported instead of treating them as an import-free source', (source) => {
    expect(parseGroundedRelativeImports(source, 'src/index.ts'))
      .toMatchObject({ complete: false, reason: 'relative_reexport_unsupported', declarations: [] });
  });

  it('refuses missing, ambiguous, and re-exported symbols without a bounded local definition', () => {
    expect(resolveGroundedExportDefinition('export const other = 1;\n', 'src/helper.ts', 'required'))
      .toMatchObject({ complete: false, reason: 'export_not_found' });
    expect(resolveGroundedExportDefinition('export function required() {}\nexport const required = 1;\n',
      'src/helper.ts', 'required')).toMatchObject({ complete: false, reason: 'ambiguous_export' });
    expect(resolveGroundedExportDefinition("export { required } from './elsewhere';\n", 'src/helper.ts', 'required'))
      .toMatchObject({ complete: false, reason: 'unsupported_reexport' });
  });
});
