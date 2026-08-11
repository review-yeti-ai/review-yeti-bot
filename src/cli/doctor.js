'use strict';

const fs = require('node:fs');
const path = require('node:path');

function check(id, status, detail, extra = {}) {
  return { id, status, detail, ...extra };
}

async function runDoctor(dependencies = {}) {
  const env = dependencies.env || process.env;
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(check('node-runtime', major >= 20 ? 'ok' : 'error', `Node ${process.versions.node}`));
  const cwd = path.resolve(dependencies.cwd || process.cwd());
  try {
    const stat = (dependencies.fs || fs).statSync(cwd);
    checks.push(check('repository-readable', stat.isDirectory() ? 'ok' : 'error', stat.isDirectory() ? cwd : 'current path is not a directory'));
  } catch (error) {
    checks.push(check('repository-readable', 'error', 'current directory is not readable'));
  }
  const configPath = path.join(cwd, '.review-yeti.yaml');
  if ((dependencies.fs || fs).existsSync(configPath)) {
    try {
      const yaml = require('js-yaml');
      yaml.load((dependencies.fs || fs).readFileSync(configPath, 'utf8'));
      checks.push(check('trusted-config', 'ok', 'repository configuration parses'));
    } catch (_) {
      checks.push(check('trusted-config', 'error', 'repository configuration is invalid'));
    }
  } else checks.push(check('trusted-config', 'warning', 'no repository configuration found'));

  const openRouterSource = env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY' : '';
  checks.push(check('openrouter-credential', openRouterSource ? 'ok' : 'warning', openRouterSource ? 'credential present' : 'credential not configured', { source: openRouterSource || undefined }));
  const githubSource = env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : env.GH_TOKEN ? 'GH_TOKEN' : '';
  checks.push(check('github-credential', githubSource ? 'ok' : 'warning', githubSource ? 'credential present' : 'credential not configured', { source: githubSource || undefined }));

  if (openRouterSource && dependencies.probeOpenRouter) {
    try {
      const probe = await dependencies.probeOpenRouter({ apiKey: env.OPENROUTER_API_KEY, signal: dependencies.signal });
      checks.push(check('openrouter-reachability', probe?.ok === false ? 'warning' : 'ok', probe?.ok === false ? 'model endpoint unavailable' : 'model endpoint reachable'));
    } catch (_) { checks.push(check('openrouter-reachability', 'warning', 'model endpoint probe failed')); }
  } else checks.push(check('openrouter-reachability', 'warning', 'probe not run'));

  if (dependencies.probeGitHub && githubSource) {
    try {
      const probe = await dependencies.probeGitHub({ token: env[githubSource], signal: dependencies.signal });
      checks.push(check('github-repository-access', probe?.ok === false ? 'warning' : 'ok', probe?.ok === false ? 'repository read unavailable' : 'repository read reachable'));
    } catch (_) { checks.push(check('github-repository-access', 'warning', 'repository read probe failed')); }
  }
  if (dependencies.outputDirectory) {
    try {
      const outputDir = path.resolve(dependencies.outputDirectory);
      (dependencies.fs || fs).accessSync(outputDir, fs.constants.W_OK);
      checks.push(check('output-directory', 'ok', 'output directory is writable'));
    } catch (_) { checks.push(check('output-directory', 'error', 'output directory is not writable')); }
  }
  const status = checks.some((item) => item.status === 'error') ? 'error' : checks.some((item) => item.status === 'warning') ? 'warning' : 'ok';
  return { schemaVersion: 'review-yeti-doctor-v1', status, checks };
}

module.exports = { runDoctor };
