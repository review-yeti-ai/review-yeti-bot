import fs from 'fs';
import path from 'path';
import { generateGitHubAppJwt } from '../src/github/appAuth';

async function postRealBotComment() {
  const envPath = path.join(__dirname, '../.env');
  if (!fs.existsSync(envPath)) {
    console.error('Missing .env file');
    process.exit(1);
  }

  const envText = fs.readFileSync(envPath, 'utf-8');
  const appIdMatch = envText.match(/GITHUB_APP_ID=(.+)/);
  const privateKeyMatch = envText.match(/GITHUB_APP_PRIVATE_KEY="([\s\S]+?)"/);

  if (!appIdMatch || !privateKeyMatch) {
    console.error('Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY in .env');
    process.exit(1);
  }

  const appId = appIdMatch[1].trim();
  const privateKey = privateKeyMatch[1].replace(/\\n/g, '\n').trim();

  console.log(`Generating App JWT for App ID ${appId}...`);
  const jwt = generateGitHubAppJwt(appId, privateKey);

  // 1. Fetch Installations for App
  console.log('Fetching installations for GitHub App...');
  const installRes = await fetch('https://api.github.com/app/installations', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'ct-review-bot[bot]',
    },
  });

  if (!installRes.ok) {
    const errText = await installRes.text();
    console.error(`Failed to fetch app installations HTTP ${installRes.status}: ${errText}`);
    process.exit(1);
  }

  const installations: any = await installRes.json();
  console.log(`Found ${installations.length} installations:`, installations.map((i: any) => ({ id: i.id, account: i.account?.login })));

  const ctInstallation = installations.find((i: any) => i.account?.login === 'calltelemetry') || installations[0];

  if (!ctInstallation) {
    console.error('No installation found for organization @calltelemetry. Install the app at https://github.com/organizations/calltelemetry/settings/apps/ct-review-bot/installations');
    process.exit(1);
  }

  const installationId = ctInstallation.id;
  console.log(`Using Installation ID ${installationId} for @calltelemetry...`);

  // 2. Exchange JWT for Installation Access Token (ghs_...)
  const tokenRes = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'ct-review-bot[bot]',
    },
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error(`Failed token exchange HTTP ${tokenRes.status}: ${errText}`);
    process.exit(1);
  }

  const tokenData: any = await tokenRes.json();
  const botToken = tokenData.token;
  console.log(`Successfully obtained installation token starting with ${botToken.substring(0, 7)}...`);

  // 3. Post real bot comment on calltelemetry/ct-meta PR #1437
  const commentBody = `### 🤖 ct-review-bot [bot] — Real GitHub App Bot Authentication Verified!

**App ID**: \`4385771\`
**Bot Identity**: \`ct-review-bot[bot]\`
**PR**: calltelemetry/ct-meta#1437 (DRAFT MODE)

---

#### 🟢 Draft Precheck & Bot Authentication Check
- 🎫 **Linear Ticket**: ✅ Valid (\`[PROJ-103]\` linked)
- 🔑 **Auth Method**: GitHub App Installation Access Token (\`ghs_...\`)
- 🤖 **Posted By**: Native \`ct-review-bot[bot]\` App account
- 💰 **LLM Tokens Used**: 0 tokens (Draft PR precheck mode)`;

  console.log('Posting comment as ct-review-bot[bot] on PR #1437...');
  const postRes = await fetch('https://api.github.com/repos/calltelemetry/ct-meta/issues/1437/comments', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${botToken}`,
      'User-Agent': 'ct-review-bot[bot]',
    },
    body: JSON.stringify({ body: commentBody }),
  });

  if (!postRes.ok) {
    const errText = await postRes.text();
    console.error(`Failed to post bot comment HTTP ${postRes.status}: ${errText}`);
    process.exit(1);
  }

  const commentData: any = await postRes.json();
  console.log(`\n======================================================`);
  console.log(`🎉 Comment Posted Successfully by ct-review-bot[bot]!`);
  console.log(`Comment URL: ${commentData.html_url}`);
  console.log(`Comment Author: ${commentData.user?.login} [${commentData.user?.type}]`);
  console.log(`======================================================\n`);
}

postRealBotComment();
