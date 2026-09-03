#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

// Node 24 slim plus four packages is ~80-240 Mi unpacked depending on
// whether docker inspect reports the local layer cache or the loaded image.
const MAX_IMAGE_BYTES = 300 * 1024 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const image = argument('--image');

const probe = `
const fs = require('fs');
for (const name of ['next', 'react', 'react-dom', 'vitest', 'jsdom']) {
  if (fs.existsSync('node_modules/' + name)) {
    process.stderr.write('forbidden package in image: ' + name + '\\n');
    process.exit(2);
  }
}
require('@openrouter/sdk');
require('js-yaml');
process.stdout.write('legacy-runtime image graph ok\\n');
`;

execFileSync('docker', ['run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', image, 'node', '-e', probe], {
  stdio: 'inherit',
});

const inspect = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Size}}'], {
  encoding: 'utf8',
}).trim();
const bytes = Number(inspect);
if (!Number.isSafeInteger(bytes) || bytes <= 0) {
  throw new Error(`could not inspect image size: ${image}`);
}
if (bytes > MAX_IMAGE_BYTES) {
  throw new Error(`legacy-runtime image exceeds 150 MiB (${bytes} bytes)`);
}

process.stdout.write(`${JSON.stringify({
  version: 'ReviewYetiLegacyRuntimeImage.v1',
  image,
  bytes,
  passed: true,
})}\n`);
