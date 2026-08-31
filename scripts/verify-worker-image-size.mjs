#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const MAX_WORKER_BYTES = 300 * 1024 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function inspectRaw(image) {
  const raw = execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', image], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function manifestFor(image, document = inspectRaw(image)) {
  if (Array.isArray(document.layers)) return document;
  if (!Array.isArray(document.manifests)) throw new Error(`image manifest is not inspectable: ${image}`);
  const platform = document.manifests.find((candidate) =>
    candidate.platform?.os === 'linux' && candidate.platform?.architecture === 'amd64' &&
    candidate.digest && candidate.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest');
  if (!platform) throw new Error(`linux/amd64 image manifest is missing: ${image}`);
  const name = image.includes('@') ? image.slice(0, image.indexOf('@')) : image;
  return manifestFor(`${name}@${platform.digest}`);
}

function compressedBytes(image) {
  const manifest = manifestFor(image);
  const bytes = manifest.layers.reduce((total, layer) => total + Number(layer.size || 0), 0);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`image layers have no usable size: ${image}`);
  return bytes;
}

const workerImage = argument('--worker');
const serviceImage = argument('--service');
const workerBytes = compressedBytes(workerImage);
const serviceBytes = compressedBytes(serviceImage);
if (workerBytes > MAX_WORKER_BYTES) {
  throw new Error(`worker image exceeds 300 MiB compressed limit (${workerBytes} bytes)`);
}
if (workerBytes * 2 > serviceBytes) {
  throw new Error(`worker image is not at least 50% smaller than service image (${workerBytes}/${serviceBytes} bytes)`);
}
process.stdout.write(`${JSON.stringify({
  version: 'ReviewYetiWorkerImageSize.v1',
  workerBytes,
  serviceBytes,
  passed: true,
})}\n`);
