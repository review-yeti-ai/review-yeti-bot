import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function setup() {
  const tmpBase = path.join(os.tmpdir(), 'ct-review-bot-e2e-global');
  if (!fs.existsSync(tmpBase)) {
    fs.mkdirSync(tmpBase, { recursive: true });
  }
  process.env.CT_E2E_GLOBAL_TMP = tmpBase;
}

export async function teardown() {
  const tmpBase = process.env.CT_E2E_GLOBAL_TMP;
  if (tmpBase && fs.existsSync(tmpBase)) {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // Ignore cleanup warning
    }
  }
}
