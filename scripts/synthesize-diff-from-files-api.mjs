#!/usr/bin/env node
// Second-tier diff fallback: reassemble a unified diff from GitHub's
// `GET /repos/{repo}/pulls/{pr}/files` response.
//
// This is the "List pull requests files" API GitHub's own 406 error message
// points to, and the second fallback named in review-yeti-bot#REL-513 for
// when the local-clone fallback (scripts/fetch-pr-diff.sh) cannot reach the
// remote (network/permissions hiccup rather than a size limit). Each file
// entry already carries a `patch` field with the same per-file unified-diff
// hunk body `git diff`/`gh pr diff` would produce; this module only needs to
// re-attach the `diff --git` / `---` / `+++` headers so the reassembled text
// parses the same way as a real unified diff downstream (planDiffBudget in
// review-pipeline.js splits on those headers).
//
// GitHub omits `patch` for binary files, renames-only entries, and any
// single file whose own diff is "too large" -- those are reported as
// omitted rather than silently absent, same honesty contract as the
// existing char-budget truncation.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function synthesizeDiffFromFilesApi(files) {
  const entries = Array.isArray(files) ? files : [];
  const sections = [];
  const omitted = [];

  for (const entry of entries) {
    const filename = entry && entry.filename;
    if (!filename) continue;

    if (!entry.patch) {
      omitted.push(filename);
      continue;
    }

    const previous = entry.previous_filename || filename;
    const isAdded = entry.status === 'added';
    const isRemoved = entry.status === 'removed';
    const aPath = isAdded ? '/dev/null' : `a/${previous}`;
    const bPath = isRemoved ? '/dev/null' : `b/${filename}`;

    sections.push(
      [
        `diff --git a/${previous} b/${filename}`,
        `--- ${aPath}`,
        `+++ ${bPath}`,
        entry.patch,
        '',
      ].join('\n'),
    );
  }

  return { text: sections.join(''), fileCount: sections.length, omitted };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const files = JSON.parse(raw || '[]');
  const result = synthesizeDiffFromFilesApi(files);
  process.stdout.write(result.text);
  process.stderr.write(
    `synthesize-diff-from-files-api: ${result.fileCount} file(s) synthesized, ${result.omitted.length} omitted (no patch: binary/rename-only/oversized)\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
