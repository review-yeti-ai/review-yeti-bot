const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const envPath = path.join(__dirname, '../.env');
if (!fs.existsSync(envPath)) {
  console.error('.env file not found at ' + envPath);
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');

const env = {};
const lines = envContent.split('\n');

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;

  const equalsIdx = line.indexOf('=');
  if (equalsIdx === -1) continue;

  const key = line.substring(0, equalsIdx).trim();
  let val = line.substring(equalsIdx + 1).trim();

  // Strip wrapping quotes
  if (val.startsWith('"') && val.endsWith('"')) {
    val = val.substring(1, val.length - 1);
  } else if (val.startsWith("'") && val.endsWith("'")) {
    val = val.substring(1, val.length - 1);
  }

  env[key] = val;
}

const appId = env.GITHUB_APP_ID;
const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
let privateKey = env.GITHUB_APP_PRIVATE_KEY;

if (privateKey) {
  // Convert literal \n sequence to real newlines
  privateKey = privateKey.replace(/\\n/g, '\n').trim();
}

if (!appId || !privateKey || !webhookSecret) {
  console.error('Missing required keys in .env file', { appId: !!appId, privateKey: !!privateKey, webhookSecret: !!webhookSecret });
  process.exit(1);
}

console.log('Found GITHUB_APP_ID:', appId);
console.log('Found GITHUB_WEBHOOK_SECRET length:', webhookSecret.length);
console.log('Found GITHUB_APP_PRIVATE_KEY length:', privateKey.length);

// Base64 encode the values for kubectl
const b64AppId = Buffer.from(appId).toString('base64');
const b64PrivateKey = Buffer.from(privateKey).toString('base64');
const b64WebhookSecret = Buffer.from(webhookSecret).toString('base64');

const patchData = {
  data: {
    GITHUB_APP_ID: b64AppId,
    GITHUB_APP_PRIVATE_KEY: b64PrivateKey,
    WEBHOOK_SECRET: b64WebhookSecret,
    OMNIROUTE_ACCESS_TOKEN: Buffer.from('').toString('base64')
  }
};

const patchJson = JSON.stringify(patchData);
fs.writeFileSync('/tmp/secret-patch.json', patchJson);

console.log('Patching Kubernetes secret ct-review-bot-runtime...');
try {
  const output = execSync('kubectl -n ct-review-system patch secret ct-review-bot-runtime --patch-file=/tmp/secret-patch.json', { encoding: 'utf8' });
  console.log('Success:', output.trim());
} catch (err) {
  console.error('Failed to patch secret:', err.message);
  process.exit(1);
} finally {
  try { fs.unlinkSync('/tmp/secret-patch.json'); } catch (_) {}
}
