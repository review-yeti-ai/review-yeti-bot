#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback;
}
const fixturesDir = path.resolve(root, optionValue('--fixtures', 'tests/fixtures/review-workflows'));
const cassettesDir = path.resolve(root, optionValue('--cassettes', 'tests/fixtures/cassettes'));
const unsafe = /(api[_-]?key|authorization|private[_-]?key|workspace[_-]?jwt|doppler[_-]?token)/iu;

function walk(value, location = '$') {
  if (typeof value === 'string') {
    if (unsafe.test(value)) throw new Error(`unsafe receipt fixture value at ${location}`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (unsafe.test(key) && child !== '<redacted>') throw new Error(`unsafe receipt fixture key at ${location}.${key}`);
    walk(child, `${location}.${key}`);
  }
}

const fixtureFiles = fs.readdirSync(fixturesDir).filter((file) => file.endsWith('.json')).sort();
const scenarioIds = new Set();
const providers = new Set();
for (const file of fixtureFiles) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8'));
  walk(fixture, file);
  if (typeof fixture.id !== 'string' || scenarioIds.has(fixture.id)) throw new Error(`invalid or duplicate scenario id in ${file}`);
  scenarioIds.add(fixture.id);
  const event = fixture.event || {};
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(String(event.repository || ''))) throw new Error(`invalid repository identity in ${file}`);
  if (!Number.isInteger(event.prNumber) || !/^[a-f0-9]{40}$/u.test(String(event.headSha || ''))) throw new Error(`missing exact-head identity in ${file}`);
  const expected = fixture.expected || {};
  const provider = fixture.config?.memory?.provider || fixture.memory?.providerResponse?.provider || 'honcho';
  if (typeof provider !== 'string' || !provider) throw new Error(`missing provider capability result in ${file}`);
  providers.add(provider);
  if (typeof expected.coverageStatus !== 'string' || typeof expected.memoryQueryStatus !== 'string'
    || typeof expected.memoryWriteStatus !== 'string' || typeof expected.outboxState !== 'string'
    || !Number.isInteger(expected.publishedReviewCount)) {
    throw new Error(`missing publication/outbox receipt fields in ${file}`);
  }
}

const cassetteFiles = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    else if (entry.name.endsWith('.json')) cassetteFiles.push(fullPath);
  }
}
collect(cassettesDir);
for (const file of cassetteFiles) {
  const cassette = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cassette.version !== 2 || !cassette.fixtureId || !cassette.provider || !Array.isArray(cassette.allowedOrigins)) {
    throw new Error(`cassette manifest is not versioned and scoped: ${file}`);
  }
  walk(cassette, file);
}

const receipt = {
  status: 'ok',
  scenarios: scenarioIds.size,
  scenarioIds: [...scenarioIds],
  providers: [...providers].sort(),
  cassettes: cassetteFiles.length,
  exactHeadBound: true,
  publicationAndOutboxFields: true,
};
console.log(JSON.stringify(receipt));
