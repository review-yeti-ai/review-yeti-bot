const { execSync } = require('child_process');
const fs = require('fs');

const omnirouteToken = 'ct-secure-token-12345';
const storageKey = 'storage_encryption_key_123456789';

console.log('Patching Kubernetes secret omniroute-runtime...');
const omniPatch = {
  data: {
    OMNIROUTE_API_KEY: Buffer.from(omnirouteToken).toString('base64'),
    STORAGE_ENCRYPTION_KEY: Buffer.from(storageKey).toString('base64')
  }
};
fs.writeFileSync('/tmp/omni-patch.json', JSON.stringify(omniPatch));
try {
  execSync('kubectl -n ct-review-system patch secret omniroute-runtime --patch-file=/tmp/omni-patch.json');
  console.log('omniroute-runtime patched successfully.');
} catch (err) {
  console.error('Failed to patch omniroute-runtime:', err.message);
} finally {
  try { fs.unlinkSync('/tmp/omni-patch.json'); } catch (_) {}
}

console.log('Patching Kubernetes secret ct-review-bot-runtime...');
const botPatch = {
  data: {
    OMNIROUTE_ACCESS_TOKEN: Buffer.from(omnirouteToken).toString('base64')
  }
};
fs.writeFileSync('/tmp/bot-patch.json', JSON.stringify(botPatch));
try {
  execSync('kubectl -n ct-review-system patch secret ct-review-bot-runtime --patch-file=/tmp/bot-patch.json');
  console.log('ct-review-bot-runtime patched successfully.');
} catch (err) {
  console.error('Failed to patch ct-review-bot-runtime:', err.message);
} finally {
  try { fs.unlinkSync('/tmp/bot-patch.json'); } catch (_) {}
}
