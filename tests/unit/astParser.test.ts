import { describe, it, expect } from 'vitest';
import { ASTParser } from '../../src/indexer/astParser';

describe('ASTParser', () => {
  const parser = new ASTParser();

  it('detects language and checks supported file types correctly', () => {
    expect(parser.isSupportedFile('src/foo.ts')).toBe(true);
    expect(parser.isSupportedFile('src/bar.js')).toBe(true);
    expect(parser.isSupportedFile('scripts/test.py')).toBe(true);
    expect(parser.isSupportedFile('README.md')).toBe(false);
  });

  it('parses TypeScript source code and extracts classes, functions, interfaces, imports, and calls', () => {
    const tsCode = `
      import { logger } from '../utils/logger';
      import fs from 'node:fs';

      /**
       * User Manager Class
       */
      export class UserManager extends BaseManager implements IManager {
        private name: string;

        constructor(name: string) {
          super();
          this.name = name;
        }

        public async getUser(id: string): Promise<string> {
          logger.info('fetching user', id);
          return this.name;
        }
      }

      export interface IManager {
        getUser(id: string): Promise<string>;
      }

      export function createManager(name: string): UserManager {
        return new UserManager(name);
      }
    `;

    const result = parser.parseSource('src/userManager.ts', tsCode);

    expect(result.language).toBe('typescript');
    expect(result.symbols.length).toBeGreaterThan(0);

    const classSym = result.symbols.find((s) => s.kind === 'class' && s.name === 'UserManager');
    expect(classSym).toBeDefined();
    expect(classSym?.exported).toBe(true);
    expect(classSym?.docComment).toContain('User Manager Class');

    const interfaceSym = result.symbols.find((s) => s.kind === 'interface' && s.name === 'IManager');
    expect(interfaceSym).toBeDefined();

    const fnSym = result.symbols.find((s) => s.kind === 'function' && s.name === 'createManager');
    expect(fnSym).toBeDefined();
    expect(fnSym?.exported).toBe(true);

    const methodSym = result.symbols.find((s) => s.kind === 'method' && s.name === 'getUser');
    expect(methodSym).toBeDefined();
    expect(methodSym?.containerName).toBe('UserManager');

    // Imports check
    expect(result.imports.length).toBe(2);
    expect(result.imports[0].source).toBe('../utils/logger');
    expect(result.imports[0].specifiers).toContain('logger');

    // References check
    const extendsRef = result.references.find((r) => r.referenceType === 'extends');
    expect(extendsRef?.targetSymbolName).toBe('BaseManager');
  });

  it('prevents JSDoc bleed across preceding symbols', () => {
    const tsCode = `
      /** JSDoc for Foo */
      export function Foo() {
        return 42;
      }

      export function Bar() {
        return 100;
      }
    `;

    const result = parser.parseSource('src/bleed.ts', tsCode);
    const fooSym = result.symbols.find((s) => s.name === 'Foo');
    const barSym = result.symbols.find((s) => s.name === 'Bar');

    expect(fooSym?.docComment).toBe('JSDoc for Foo');
    expect(barSym?.docComment).toBeUndefined();
  });

  it('parses Python source code and extracts classes, methods, docstrings, and calls with sourceSymbolId', () => {
    const pythonCode = `
import os
from datetime import datetime

class DataProcessor:
    """Processes datasets asynchronously."""
    def __init__(self, name: str):
        self.name = name

    def process(self, data: list) -> dict:
        """Process input list into dict."""
        print("Processing", data)
        return {"name": self.name}

def main():
    processor = DataProcessor("test")
    processor.process([1, 2, 3])
`;

    const result = parser.parseSource('scripts/processor.py', pythonCode);

    expect(result.language).toBe('python');
    expect(result.symbols.length).toBeGreaterThan(0);

    const classSym = result.symbols.find((s) => s.kind === 'class' && s.name === 'DataProcessor');
    expect(classSym).toBeDefined();
    expect(classSym?.docComment).toContain('Processes datasets asynchronously');

    const methodSym = result.symbols.find((s) => s.kind === 'method' && s.name === 'process');
    expect(methodSym).toBeDefined();
    expect(methodSym?.docComment).toContain('Process input list');

    const fnSym = result.symbols.find((s) => s.kind === 'function' && s.name === 'main');
    expect(fnSym).toBeDefined();

    // Verify Python call reference has sourceSymbolId set
    const callRef = result.references.find((r) => r.referenceType === 'call' && r.targetSymbolName === 'process');
    expect(callRef).toBeDefined();
    expect(callRef?.sourceSymbolId).toBe(fnSym?.id);

    expect(fnSym?.callees).toContain('process');
    expect(methodSym?.callers).toContain('main');

    expect(result.imports.length).toBe(2);
  });

  it('handles broken or malformed syntax with fallback parsing cleanly', () => {
    const brokenCode = `
      export class BrokenClass {
        function unterminated(
    `;

    const result = parser.parseSource('src/broken.ts', brokenCode);

    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    expect(result.symbols[0].name).toBe('BrokenClass');
  });
});
