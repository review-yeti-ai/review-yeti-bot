const Database = require('/usr/local/lib/node_modules/omniroute/node_modules/better-sqlite3');
const crypto = require('crypto');

const secret = process.env.STORAGE_ENCRYPTION_KEY || 'storage_encryption_key_123456789';
const STATIC_SALT = "omniroute-field-encryption-v1";
const key = crypto.scryptSync(secret, STATIC_SALT, 32);

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `enc:v1:${iv.toString("hex")}:${encrypted}:${authTag}`;
}

const db = new Database('/data/storage.sqlite');

db.transaction(() => {
  // 1. Clean up old connections and nodes for Codex Gateway
  db.prepare("DELETE FROM provider_connections WHERE provider = 'openai-compatible-responses-codex-gateway'").run();
  db.prepare("DELETE FROM provider_nodes WHERE id = 'openai-compatible-responses-codex-gateway'").run();
  
  // 2. Insert Custom Codex Gateway node pointing to synthetic server!
  db.prepare(`
    INSERT INTO provider_nodes (
      id, type, name, prefix, api_type, base_url, created_at, updated_at
    ) VALUES (
      'openai-compatible-responses-codex-gateway',
      'openai-compatible',
      'Custom Codex Gateway',
      'codex-gateway',
      'openai',
      'https://api.synthetic.new/openai/v1',
      datetime('now'),
      datetime('now')
    )
  `).run();
  console.log("Inserted Custom Codex Gateway node pointing to synthetic server.");

  // 3. Insert Codex connection with the synthetic key and synthetic baseUrl
  const syntheticKeyEncrypted = encrypt(process.env.SYNTHETIC_API_KEY || '');
  db.prepare(`
    INSERT INTO provider_connections (
      id, provider, auth_type, name, is_active, test_status, api_key, provider_specific_data, created_at, updated_at
    ) VALUES (
      'openai-compatible-responses-codex-gateway-conn',
      'openai-compatible-responses-codex-gateway',
      'apikey',
      'Codex Gateway Connection',
      1,
      'verified',
      ?,
      '{"apiKeyHealth":{},"baseUrl":"https://api.synthetic.new/openai/v1"}',
      datetime('now'),
      datetime('now')
    )
  `).run(syntheticKeyEncrypted);
  console.log("Inserted Codex Gateway connection pointing to synthetic.");

  // 4. Update model aliases
  const targetClaudeModel = 'openrouter/anthropic/claude-sonnet-5';
  const targetSyntheticModel = 'hf:zai-org/GLM-5.2';

  const aliases = {
    // Map Codex models directly to the synthetic model name (which will be processed under this provider's endpoint)
    'codex-gateway/gpt-5.6-sol-high': targetSyntheticModel,
    'codex/gpt-5.6-sol-high': targetSyntheticModel,
    'gpt-5.6-sol-high': targetSyntheticModel,

    // Map Claude models to Claude 5 Sonnet on OpenRouter
    'claude-5-sonnet': targetClaudeModel,
    'claude-opus-4-8': targetClaudeModel,
    'claude-3-5-sonnet': targetClaudeModel,
    'claude-3.5-sonnet': targetClaudeModel,
    'anthropic/claude-3-5-sonnet': targetClaudeModel,
    'anthropic/claude-3-7-sonnet': targetClaudeModel,
    'claude/claude-opus-4-8': targetClaudeModel,
    'claude/claude-sonnet-5': targetClaudeModel
  };

  // Insert into namespace = 'modelAliases'
  for (const [aliasKey, targetValue] of Object.entries(aliases)) {
    db.prepare(`
      INSERT OR REPLACE INTO key_value (namespace, key, value)
      VALUES ('modelAliases', ?, ?)
    `).run(aliasKey, JSON.stringify(targetValue));
  }

  // ALSO insert into namespace = 'settings', key = 'modelAliases' to hydrate customAliases() in memory!
  db.prepare(`
    INSERT OR REPLACE INTO key_value (namespace, key, value)
    VALUES ('settings', 'modelAliases', ?)
  `).run(JSON.stringify(aliases));
  
  console.log("Successfully inserted aliases into settings.");
})();

console.log("Database update completed successfully.");
