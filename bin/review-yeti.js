#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

let args = process.argv.slice(2);
// If invoked via git sub-command where 'yeti' is passed as first argument
if (args[0] === 'yeti') {
  args = args.slice(1);
}

const distCliPath = path.resolve(__dirname, '../dist/cli/index.js');
const srcCliPath = path.resolve(__dirname, '../src/cli/index.ts');

if (fs.existsSync(distCliPath)) {
  const { runCli } = require(distCliPath);
  runCli(args).then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
} else if (fs.existsSync(srcCliPath)) {
  require('ts-node/register');
  const { runCli } = require(srcCliPath);
  runCli(args).then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
} else {
  console.error('Error: review-yeti CLI module not found.');
  process.exit(1);
}
