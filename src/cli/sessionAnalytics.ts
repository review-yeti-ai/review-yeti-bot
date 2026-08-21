#!/usr/bin/env node

import { runCLI } from '../analytics/cliParser';

async function main() {
  const args = process.argv.slice(2);
  const result = await runCLI(args);

  if (result.exitCode !== 0) {
    console.error(result.output);
  } else if (result.outPath) {
    console.log(`Output successfully written to ${result.outPath}`);
  } else {
    console.log(result.output);
  }

  process.exit(result.exitCode);
}

main();
