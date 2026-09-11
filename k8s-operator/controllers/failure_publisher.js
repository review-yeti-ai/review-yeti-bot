const repository = process.env.REVIEW_REPOSITORY || '';
const [owner, repo, extra] = repository.split('/');
const head = process.env.REVIEW_HEAD_SHA || '';
const runId = process.env.REVIEW_RUN_ID || '';
const attempt = Number(process.env.REVIEW_EXECUTION_ATTEMPT || '');
const token = process.env.GITHUB_PUBLISH_TOKEN || '';
if (!owner || !repo || extra || !/^[a-f0-9]{40}$/.test(head) || !/^run_[a-f0-9]{32}$/.test(runId)
    || !Number.isSafeInteger(attempt) || attempt < 1 || !token.startsWith('ghs_')) {
  throw new Error('invalid failure publication identity');
}
const externalId = runId + ':a' + attempt;
const base = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
const request = async (path, init = {}) => {
  const response = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'review-yeti-failure-publisher',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('GitHub failure publication request failed with HTTP ' + response.status);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
};
const checks = [];
for (let page = 1; page <= 5; page += 1) {
  const result = await request(base + '/commits/' + head
    + '/check-runs?check_name=Review%20Yeti&filter=all&per_page=100&page=' + page);
  if (!Array.isArray(result.check_runs)) throw new Error('invalid check lookup response');
  checks.push(...result.check_runs);
  if (result.check_runs.length < 100) break;
  if (page === 5) throw new Error('check lookup exceeded bounded pagination');
}
const candidates = checks.filter((check) => check && check.name === 'Review Yeti'
  && check.head_sha === head && check.external_id === externalId);
if (candidates.length > 1) throw new Error('ambiguous failure publication identity');
const failure = {
  status: 'completed',
  conclusion: 'failure',
  completed_at: new Date().toISOString(),
  output: {
    title: 'Review Yeti: review did not complete',
    summary: 'The Kubernetes worker failed or disappeared before a durable verdict was recorded. '
      + 'This is a failed review rather than an approval. Re-run the governed review workflow to request a fresh attempt.',
  },
};
if (candidates.length === 1) {
  const candidate = candidates[0];
  if (!Number.isSafeInteger(candidate.id) || candidate.id < 1) throw new Error('invalid check identity');
  const current = await request(base + '/check-runs/' + candidate.id);
  if (current.id !== candidate.id || current.name !== 'Review Yeti' || current.head_sha !== head
      || current.external_id !== externalId) throw new Error('failure publication identity changed');
  if (current.status !== 'completed') {
    if (!['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(current.status)) {
      throw new Error('unknown check state');
    }
    await request(base + '/check-runs/' + candidate.id, { method: 'PATCH', body: JSON.stringify(failure) });
  }
} else {
  await request(base + '/check-runs', { method: 'POST', body: JSON.stringify({
    name: 'Review Yeti', head_sha: head, external_id: externalId, ...failure,
  }) });
}
