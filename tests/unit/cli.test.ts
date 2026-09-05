import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BIN_PATH = path.join(REPO_ROOT, 'bin/review-yeti.js');

describe('Review Yeti CLI Binary & Git Subcommand (bin/review-yeti.js)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-cli-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bin/review-yeti.js has executable file permissions (0o755)', () => {
    const stat = fs.statSync(BIN_PATH);
    const isExecutable = (stat.mode & 0o111) !== 0;
    expect(isExecutable).toBe(true);
  });

  it('prints version information via --version', () => {
    const output = execFileSync('node', [BIN_PATH, '--version'], {
      encoding: 'utf-8',
    });
    expect(output).toContain('review-yeti v1.28.6');
  });

  it('prints help message via --help and -h', () => {
    const outputLong = execFileSync('node', [BIN_PATH, '--help'], {
      encoding: 'utf-8',
    });
    expect(outputLong).toContain('Review Yeti CLI');
    expect(outputLong).toContain('pre-commit');
    expect(outputLong).toContain('install-hook');

    const outputShort = execFileSync('node', [BIN_PATH, '-h'], {
      encoding: 'utf-8',
    });
    expect(outputShort).toContain('Review Yeti CLI');
  });

  it('supports "git yeti" invocation by stripping leading "yeti" argument', () => {
    const output = execFileSync('node', [BIN_PATH, 'yeti', '--version'], {
      encoding: 'utf-8',
    });
    expect(output).toContain('review-yeti v1.28.6');
  });

  it('blocks commit (exit code 1) on staged diff containing AWS credential', () => {
    const diffFile = path.join(tempDir, 'leak.diff');
    fs.writeFileSync(
      diffFile,
      `
diff --git a/src/secrets.ts b/src/secrets.ts
new file mode 100644
--- /dev/null
+++ b/src/secrets.ts
@@ -0,0 +1,2 @@
+const AWS_KEY = "AKIA1111111111111111";
`
    );

    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync('node', [BIN_PATH, 'pre-commit', '--diff', diffFile], {
        encoding: 'utf-8',
      });
    } catch (err: any) {
      exitCode = err.status;
      stdout = err.stdout?.toString() || '';
      stderr = err.stderr?.toString() || '';
    }

    expect(exitCode).toBe(1);
    expect(stdout).toContain('AWS Access Key at src/secrets.ts:1');
    expect(stdout).toContain('\x1b[1;31m[P0]\x1b[0m');
    expect(stdout).toContain('Commit blocked: 1 blocking P0 issue(s) detected');
  });

  it('respects NO_COLOR environment variable in CLI output', () => {
    const diffFile = path.join(tempDir, 'leak.diff');
    fs.writeFileSync(
      diffFile,
      `
diff --git a/src/secrets.ts b/src/secrets.ts
new file mode 100644
--- /dev/null
+++ b/src/secrets.ts
@@ -0,0 +1,2 @@
+const AWS_KEY = "AKIA1111111111111111";
`
    );

    let stdout = '';
    try {
      stdout = execFileSync('node', [BIN_PATH, 'pre-commit', '--diff', diffFile], {
        encoding: 'utf-8',
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (err: any) {
      stdout = err.stdout?.toString() || '';
    }

    // Must contain plain text without ANSI escape sequence \x1b[
    expect(stdout).toContain('[P0] AWS Access Key');
    expect(stdout).not.toContain('\x1b[1;31m');
  });

  it('passes cleanly (exit code 0) on clean diff without credentials', () => {
    const diffFile = path.join(tempDir, 'clean.diff');
    fs.writeFileSync(
      diffFile,
      `
diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,2 +1,2 @@
+const port = process.env.PORT || 3000;
`
    );

    const stdout = execFileSync('node', [BIN_PATH, 'pre-commit', '--diff', diffFile], {
      encoding: 'utf-8',
    });

    expect(stdout).toContain('Pre-commit checks passed');
  });

  it('installs pre-commit hook via "install-hook --dir <path>" and makes it executable', () => {
    const output = execFileSync('node', [BIN_PATH, 'install-hook', '--dir', tempDir], {
      encoding: 'utf-8',
    });

    expect(output).toContain('Successfully installed Review Yeti pre-commit hook');
    const hookPath = path.join(tempDir, '.git', 'hooks', 'pre-commit');
    expect(fs.existsSync(hookPath)).toBe(true);

    const stat = fs.statSync(hookPath);
    const isExecutable = (stat.mode & 0o111) !== 0;
    expect(isExecutable).toBe(true);
  });
});
