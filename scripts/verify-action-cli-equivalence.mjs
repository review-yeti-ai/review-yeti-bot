#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function value(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function read(file) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error(`invalid receipt: ${file}`);
  return parsed.result || parsed;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function project(result) {
  const identity = result.identity || {
    repository: result.source?.repository,
    prNumber: result.source?.prNumber,
    baseSha: result.source?.baseSha,
    headSha: result.source?.headSha,
  };
  return {
    identity,
    verdict: result.verdict,
    coverage: result.coverage,
    investigationDigest: result.investigation?.receiptDigest || result.investigation?.digest || null,
    reviewUnits: result.reviewUnits || null,
    findingVerification: result.findingVerification || null,
  };
}

export function verifyActionCliEquivalence(action, cli) {
  const actionProjection = project(action);
  const cliProjection = project(cli);
  const equivalent = canonical(actionProjection) === canonical(cliProjection);
  return {
    schemaVersion: 'action-cli-equivalence-v1',
    equivalent,
    actionDigest: crypto.createHash('sha256').update(canonical(actionProjection)).digest('hex'),
    cliDigest: crypto.createHash('sha256').update(canonical(cliProjection)).digest('hex'),
    differences: equivalent ? [] : ['authority_receipt_mismatch'],
    action: actionProjection,
    cli: cliProjection,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const actionPath = value(process.argv.slice(2), '--action-receipt');
    const cliPath = value(process.argv.slice(2), '--cli-receipt');
    if (!actionPath || !cliPath) throw new Error('--action-receipt and --cli-receipt are required');
    const receipt = verifyActionCliEquivalence(read(actionPath), read(cliPath));
    const outputPath = value(process.argv.slice(2), '--output');
    if (outputPath) {
      const temporary = `${outputPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, outputPath);
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = receipt.equivalent ? 0 : 1;
  } catch (error) {
    process.stderr.write(`equivalence: ${error.message}\n`);
    process.exitCode = 2;
  }
}
