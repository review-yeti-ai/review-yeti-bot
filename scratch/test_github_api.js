const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env
const envPath = path.join(__dirname, '../.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const t = line.trim();
  if (!t || t.startsWith('#')) return;
  const eq = line.indexOf('=');
  if (eq === -1) return;
  let key = line.substring(0, eq).trim();
  let val = line.substring(eq + 1).trim();
  if (val.startsWith('"') && val.endsWith('"')) val = val.substring(1, val.length - 1);
  env[key] = val;
});

const appId = env.GITHUB_APP_ID;
const privateKey = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');

function generateGitHubAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  };

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const toSign = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(toSign);
  const signature = sign.sign(privateKey, 'base64url');
  return `${toSign}.${signature}`;
}

async function run() {
  try {
    const jwt = generateGitHubAppJwt(appId, privateKey);
    console.log('Generated JWT successfully.');

    // 1. Get installation token
    const tokenRes = await fetch('https://api.github.com/app/installations/148780830/access_tokens', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${jwt}`,
        'User-Agent': 'ct-review-bot[bot]',
      }
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }

    const tokenData = await tokenRes.json();
    const token = tokenData.token;
    console.log('Obtained installation token successfully.');

    // 2. Fetch PR
    const prRes = await fetch('https://api.github.com/repos/calltelemetry/ct-review-bot/pulls/9', {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'ct-review-bot[bot]',
      }
    });

    if (!prRes.ok) {
      throw new Error(`Fetch PR failed: ${prRes.status} ${await prRes.text()}`);
    }

    const prData = await prRes.json();
    console.log('Successfully fetched PR details:');
    console.log('Title:', prData.title);
    console.log('State:', prData.state);
    console.log('Head SHA:', prData.head.sha);
    console.log('Base SHA:', prData.base.sha);
  } catch (err) {
    console.error('Error during testing:', err.message);
  }
}

run();
