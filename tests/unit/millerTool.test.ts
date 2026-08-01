import { describe, it, expect } from 'vitest';
import { executeMillerTool } from '../../src/services/millerTool';

describe('Miller Tool Service (src/services/millerTool.ts)', () => {
  it('1. Handles non-code files cleanly with hunk fallback', async () => {
    const res = await executeMillerTool({
      filePath: 'README.md',
      patch: '@@ -1,3 +1,5 @@\n# Title\n+## New Section\n',
    });

    expect(res).toBeDefined();
    expect(res.mode).toBe('hunk_fallback');
    expect(res.miller).toContain('Hunk Fallback');
    expect(res.miller).toContain('New Section');
  });

  it('2. Extracts syntactically bounded AST snippets for TypeScript source code overlapping patch lines', async () => {
    const tsCode = `
export interface UserConfig {
  id: string;
  name: string;
}

export class UserService {
  public getUser(id: string): UserConfig {
    return { id, name: 'Alice' };
  }
}
`;
    const patch = `@@ -7,3 +7,5 @@
 export class UserService {
   public getUser(id: string): UserConfig {
+    console.log("Fetching user", id);
     return { id, name: 'Alice' };
   }
 }`;

    const res = await executeMillerTool({
      filePath: 'src/services/userService.ts',
      patch,
    });

    expect(res).toBeDefined();
    expect(res.miller).toBeDefined();
    expect(res.filePath).toBe('src/services/userService.ts');
  });

  it('3. Handles missing or empty parameters gracefully without throwing exceptions', async () => {
    const resNull = await executeMillerTool({ filePath: '' });
    expect(resNull).toBeDefined();
    expect(resNull.miller).toContain('[Miller Error]');

    const resNonExistent = await executeMillerTool({
      filePath: 'non_existent_file.json',
      patch: '+ { "key": "value" }',
    });
    expect(resNonExistent).toBeDefined();
    expect(resNonExistent.mode).toBe('hunk_fallback');
  });
});
