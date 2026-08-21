#!/usr/bin/env node

const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA = /^[0-9a-f]{40}$/u;

/**
 * Validate the immutable release identity used by the tag workflow.
 *
 * The tag commit may be behind a newer main commit when another change lands
 * while the release job is queued, so ancestry is supplied by the workflow
 * rather than incorrectly requiring the two SHAs to be identical.
 */
export function validateReleaseVersion({
  tag,
  packageVersion,
  mainSha,
  checkedOutSha,
  taggedSha,
  tagReachableFromMain,
}) {
  const match = typeof tag === 'string' ? tag.match(SEMVER_TAG) : null;
  if (!match) {
    throw new Error('release tag must use vMAJOR.MINOR.PATCH semver');
  }

  const normalizedVersion = tag.slice(1);
  if (packageVersion !== normalizedVersion) {
    throw new Error(`package.json version ${packageVersion} does not match release tag ${tag}`);
  }

  for (const [label, value] of [
    ['main', mainSha],
    ['checked-out', checkedOutSha],
    ['tagged', taggedSha],
  ]) {
    if (typeof value !== 'string' || !SHA.test(value)) {
      throw new Error(`${label} commit must be a lowercase 40-character SHA`);
    }
  }

  if (checkedOutSha !== taggedSha) {
    throw new Error(`tagged commit ${taggedSha} does not match checked-out commit ${checkedOutSha}`);
  }

  if (tagReachableFromMain !== true) {
    throw new Error(`release commit ${checkedOutSha} is not reachable from main ${mainSha}`);
  }

  return {
    normalizedVersion,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || process.argv[index + 1] === undefined) {
    throw new Error(`missing required argument ${name}`);
  }
  return process.argv[index + 1];
}

function runCli() {
  const result = validateReleaseVersion({
    tag: readArgument('--tag'),
    packageVersion: readArgument('--package-version'),
    mainSha: readArgument('--main-sha'),
    checkedOutSha: readArgument('--checked-out-sha'),
    taggedSha: readArgument('--tagged-sha'),
    tagReachableFromMain: readArgument('--tag-reachable-from-main') === 'true',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedScript = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname;
if (invokedScript === new URL(import.meta.url).pathname) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
