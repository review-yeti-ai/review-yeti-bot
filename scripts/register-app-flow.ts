import express from 'express';
import fs from 'fs';
import path from 'path';

const PORT = 3000;
const REDIRECT_URL = `http://127.0.0.1:${PORT}/callback`;
const GITHUB_ORG = 'calltelemetry';

const manifest = {
  name: 'ct-review-bot',
  url: 'https://review-bot.calltelemetry.com',
  redirect_url: REDIRECT_URL,
  hook_attributes: {
    url: 'https://review-bot.calltelemetry.com/webhook',
    active: true,
  },
  public: false,
  default_permissions: {
    pull_requests: 'write',
    issues: 'write',
    contents: 'read',
    metadata: 'read',
  },
  default_events: [
    'pull_request',
    'issue_comment',
    'pull_request_review_comment',
  ],
};

const app = express();

app.get('/', (_req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>1-Click GitHub App Setup — ct-review-bot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 60px; text-align: center; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 40px; max-width: 600px; margin: 0 auto; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    h1 { color: #58a6ff; font-size: 26px; margin-bottom: 16px; }
    p { color: #8b949e; line-height: 1.6; margin-bottom: 28px; font-size: 16px; }
    button { background: #238636; color: #ffffff; border: none; font-size: 18px; font-weight: 600; padding: 14px 32px; border-radius: 8px; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #2ea043; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🤖 Automated 1-Click GitHub App Setup</h1>
    <p>Click below to create the <strong>ct-review-bot</strong> GitHub App for <strong>@${GITHUB_ORG}</strong>.<br>GitHub will pre-fill all permissions, webhooks, and events automatically.</p>
    <form action="https://github.com/organizations/${GITHUB_ORG}/settings/apps/new" method="post">
      <input type="hidden" name="manifest" value='${JSON.stringify(manifest)}'>
      <button type="submit">🚀 Create ct-review-bot App on GitHub</button>
    </form>
  </div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send('Missing code parameter from GitHub callback');
    return;
  }

  try {
    const exchangeRes = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!exchangeRes.ok) {
      const errText = await exchangeRes.text();
      res.status(500).send(`Failed to convert GitHub App Manifest code: ${errText}`);
      return;
    }

    const appConfig: any = await exchangeRes.json();
    const envContent = `# GitHub App Config Generated Automatically\n` +
      `GITHUB_APP_ID=${appConfig.id}\n` +
      `GITHUB_APP_CLIENT_ID=${appConfig.client_id}\n` +
      `GITHUB_APP_CLIENT_SECRET=${appConfig.client_secret}\n` +
      `GITHUB_WEBHOOK_SECRET=${appConfig.webhook_secret}\n` +
      `GITHUB_APP_PRIVATE_KEY="${appConfig.pem.replace(/\n/g, '\\n')}"\n`;

    fs.writeFileSync(path.join(__dirname, '../.env'), envContent, 'utf-8');

    const installUrl = `https://github.com/organizations/${GITHUB_ORG}/settings/apps/${appConfig.slug}/installations`;

    const successHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>GitHub App Setup Complete!</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 60px; text-align: center; }
    .card { background: #161b22; border: 1px solid #238636; border-radius: 12px; padding: 40px; max-width: 600px; margin: 0 auto; }
    h1 { color: #3fb950; font-size: 26px; }
    code { background: #0d1117; padding: 4px 8px; border-radius: 4px; color: #58a6ff; }
    a { display: inline-block; background: #1f6feb; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🎉 GitHub App Created Successfully!</h1>
    <p>App ID: <code>${appConfig.id}</code></p>
    <p>Credentials written automatically to <code>.env</code> and ready for k8s secret deployment.</p>
    <a href="${installUrl}" target="_blank">📲 Install App on @${GITHUB_ORG} Repositories</a>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(successHtml);

    console.log(`\n======================================================`);
    console.log(`🎉 GitHub App Successfully Created!`);
    console.log(`App ID:          ${appConfig.id}`);
    console.log(`Client ID:       ${appConfig.client_id}`);
    console.log(`Installation:    ${installUrl}`);
    console.log(`======================================================\n`);

    setTimeout(() => process.exit(0), 3000);
  } catch (err: any) {
    res.status(500).send(`Exception during GitHub App setup: ${err?.message || err}`);
  }
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Automated 1-Click GitHub App Setup Server Running!`);
  console.log(`Open in browser: http://127.0.0.1:${PORT}`);
  console.log(`======================================================\n`);
});
