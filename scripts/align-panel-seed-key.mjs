import { appendFileSync } from 'node:fs';

import { isEntrypoint } from './entrypoint-guard.mjs';

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function alignPanelSeedKey(env = process.env) {
  const envName = String(env.RESOLVED_API_KEY_ENV || '').trim();
  if (!ENV_NAME.test(envName)) {
    throw new Error('resolved_api_key_env must be a single canonical secret env name');
  }
  const value = env[envName];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing secret for ${envName}`);
  }
  return { envName, value };
}

function main() {
  const aligned = alignPanelSeedKey();
  console.log(`::add-mask::${aligned.value}`);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(outputPath, `llm_api_key<<CT_REVIEW_SEED_KEY\n${aligned.value}\nCT_REVIEW_SEED_KEY\n`);
  appendFileSync(outputPath, `resolved_api_key_env=${aligned.envName}\n`);
}

if (isEntrypoint(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
