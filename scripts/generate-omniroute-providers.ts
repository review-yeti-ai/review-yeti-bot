import fs from 'fs';
import path from 'path';

/**
 * OmniRoute Provider Meta Schema Auto-Generator
 *
 * Reads src/gateway/omniRouteClient.ts and src/config/schema.ts, parses provider
 * provenances, model maps, and allowed model lists, and outputs strongly-typed
 * metadata definitions to src/types/providers.generated.ts.
 */

export interface ProviderDefinition {
  id: string;
  displayName: string;
  defaultBaseUrl: string;
  provenancePrefixes: string[];
  defaultModel: string;
  supportedModels: string[];
  supportsCustomModels: boolean;
  requiresApiKey: boolean;
}

function parseOmniRouteProvenance(omniRouteClientContent: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  const match = omniRouteClientContent.match(/const OMNIROUTE_PROVIDER_PROVENANCE:\s*Record<string,\s*readonly string\[\]>\s*=\s*(\{[\s\S]*?\});/);
  if (match && match[1]) {
    try {
      // Evaluate key-value pairs safely using simple regex extraction
      const lines = match[1].split('\n');
      for (const line of lines) {
        const lineMatch = line.match(/['"]?([a-zA-Z0-9_-]+)['"]?:\s*\[(.*?)\]/);
        if (lineMatch) {
          const key = lineMatch[1];
          const prefixes = lineMatch[2]
            .split(',')
            .map((s) => s.trim().replace(/['"]/g, ''))
            .filter(Boolean);
          map[key] = prefixes;
        }
      }
    } catch {
      // Fallback
    }
  }
  return map;
}

function parseSchemaModels(schemaContent: string): { v3Models: Record<string, string>; allowedModels: string[] } {
  const v3Models: Record<string, string> = {};
  const allowedModels: string[] = [];

  const v3Match = schemaContent.match(/export const V3_PROVIDER_MODELS\s*=\s*(\{[\s\S]*?\})\s*as const;/);
  if (v3Match && v3Match[1]) {
    const lines = v3Match[1].split('\n');
    for (const line of lines) {
      const lineMatch = line.match(/['"]?([a-zA-Z0-9_-]+)['"]?:\s*['"]([^'"]+)['"]/);
      if (lineMatch) {
        v3Models[lineMatch[1]] = lineMatch[2];
      }
    }
  }

  const allowedMatch = schemaContent.match(/export const R4_ALLOWED_MODELS\s*=\s*\[([\s\S]*?)\];/);
  if (allowedMatch && allowedMatch[1]) {
    const items = allowedMatch[1]
      .split('\n')
      .map((line) => {
        const m = line.match(/['"]([^'"]+)['"]/);
        return m ? m[1] : null;
      })
      .filter((x): x is string => x !== null);
    allowedModels.push(...items);
  }

  return { v3Models, allowedModels };
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const omniRouteClientPath = path.join(rootDir, 'src', 'gateway', 'omniRouteClient.ts');
  const schemaPath = path.join(rootDir, 'src', 'config', 'schema.ts');
  const outputPath = path.join(rootDir, 'src', 'types', 'providers.generated.ts');

  const omniRouteContent = fs.readFileSync(omniRouteClientPath, 'utf8');
  const schemaContent = fs.readFileSync(schemaPath, 'utf8');

  const provenanceMap = parseOmniRouteProvenance(omniRouteContent);
  const { v3Models, allowedModels } = parseSchemaModels(schemaContent);

  // Catalog definitions for all 9 AI provider families + codex/agy
  const providersCatalog: Record<string, ProviderDefinition> = {
    openai: {
      id: 'openai',
      displayName: 'OpenAI',
      defaultBaseUrl: 'https://api.openai.com/v1',
      provenancePrefixes: ['openai', 'gpt'],
      defaultModel: 'gpt-4o',
      supportedModels: ['gpt-4o', 'gpt-4o-mini', 'o1-mini', 'o3-mini', 'openai/gpt-5.6-luna', 'openrouter/5.6-luna-high'],
      supportsCustomModels: true,
      requiresApiKey: true,
    },
    anthropic: {
      id: 'anthropic',
      displayName: 'Anthropic Claude',
      defaultBaseUrl: 'https://api.anthropic.com/v1',
      provenancePrefixes: ['claude', 'anthropic'],
      defaultModel: 'claude-3-5-sonnet',
      supportedModels: ['claude-3-5-sonnet', 'claude-3-7-sonnet', 'claude-5-sonnet', 'claude-opus-4-8'],
      supportsCustomModels: false,
      requiresApiKey: true,
    },
    gemini: {
      id: 'gemini',
      displayName: 'Google Gemini',
      defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      provenancePrefixes: ['gemini', 'google'],
      defaultModel: 'gemini-1.5-pro',
      supportedModels: ['gemini-1.5-pro', 'gemini-2.0-flash', 'gemini-2.0-pro'],
      supportsCustomModels: false,
      requiresApiKey: true,
    },
    grok: {
      id: 'grok',
      displayName: 'xAI Grok',
      defaultBaseUrl: 'https://api.x.ai/v1',
      provenancePrefixes: provenanceMap['grok-cli'] || ['grok-cli', 'grok'],
      defaultModel: v3Models['grok'] || 'grok-cli/grok-4.5',
      supportedModels: ['grok-cli/grok-4.5', 'grok-2'],
      supportsCustomModels: false,
      requiresApiKey: true,
    },
    deepseek: {
      id: 'deepseek',
      displayName: 'DeepSeek AI',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
      provenancePrefixes: ['deepseek'],
      defaultModel: 'deepseek-v3',
      supportedModels: ['deepseek-v3', 'deepseek-r1', 'deepseek-v4-pro'],
      supportsCustomModels: true,
      requiresApiKey: true,
    },
    glm: {
      id: 'glm',
      displayName: 'GLM / Synthetic Arbiter',
      defaultBaseUrl: 'https://api.omniroute.internal/v1',
      provenancePrefixes: ['glm', 'synthetic'],
      defaultModel: v3Models['synthetic'] || 'glm-5.2',
      supportedModels: ['glm-5.2', 'synthetic/v1', 'synthetic/glm-5.2-high'],
      supportsCustomModels: false,
      requiresApiKey: false,
    },
    doppler: {
      id: 'doppler',
      displayName: 'Doppler Secret Sync',
      defaultBaseUrl: 'https://api.doppler.com/v3',
      provenancePrefixes: ['doppler'],
      defaultModel: 'doppler-sync-v1',
      supportedModels: ['doppler-sync-v1'],
      supportsCustomModels: false,
      requiresApiKey: true,
    },
    ollama: {
      id: 'ollama',
      displayName: 'Ollama Local LLM',
      defaultBaseUrl: 'http://localhost:11434/v1',
      provenancePrefixes: ['ollama', 'local'],
      defaultModel: 'llama3.3',
      supportedModels: ['llama3.3', 'qwen2.5-coder', 'deepseek-r1:8b'],
      supportsCustomModels: true,
      requiresApiKey: false,
    },
    'custom-openai': {
      id: 'custom-openai',
      displayName: 'Custom OpenAI-Compatible',
      defaultBaseUrl: 'https://api.custom-llm.com/v1',
      provenancePrefixes: ['custom'],
      defaultModel: 'custom-model-v1',
      supportedModels: ['custom-model-v1'],
      supportsCustomModels: true,
      requiresApiKey: true,
    },
    codex: {
      id: 'codex',
      displayName: 'Codex Gateway',
      defaultBaseUrl: 'https://api.codex.internal/v1',
      provenancePrefixes: provenanceMap['codex'] || ['codex', 'cx'],
      defaultModel: v3Models['codex'] || 'codex/gpt-5.6-sol-high',
      supportedModels: ['codex/gpt-5.6-sol-high', 'gpt-5.6-sol'],
      supportsCustomModels: false,
      requiresApiKey: true,
    },
    agy: {
      id: 'agy',
      displayName: 'AGY Thinking Engine',
      defaultBaseUrl: 'https://api.agy.internal/v1',
      provenancePrefixes: provenanceMap['agy'] || ['agy'],
      defaultModel: v3Models['agy-opus'] || 'agy/claude-opus-4-6-thinking',
      supportedModels: ['agy/claude-opus-4-6-thinking'],
      supportsCustomModels: false,
      requiresApiKey: true,
    },
  };

  const providerTypes = Object.keys(providersCatalog);
  const allModelsSet = new Set<string>();
  for (const provider of Object.values(providersCatalog)) {
    for (const model of provider.supportedModels) {
      allModelsSet.add(model);
    }
  }
  for (const model of allowedModels) {
    allModelsSet.add(model);
  }

  const generatedCode = `/**
 * AUTO-GENERATED FILE - DO NOT MODIFY DIRECTLY.
 * Generated by scripts/generate-omniroute-providers.ts
 */

export type ProviderType =
${providerTypes.map((t) => `  | '${t}'`).join('\n')};

export interface GeneratedProviderMeta {
  id: ProviderType;
  displayName: string;
  defaultBaseUrl: string;
  provenancePrefixes: readonly string[];
  defaultModel: string;
  supportedModels: readonly string[];
  supportsCustomModels: boolean;
  requiresApiKey: boolean;
}

export const OMNIROUTE_GENERATED_PROVIDERS: Record<ProviderType, GeneratedProviderMeta> = ${JSON.stringify(
    providersCatalog,
    null,
    2
  )};

export const OMNIROUTE_GENERATED_MODEL_LIST: readonly string[] = ${JSON.stringify(
    Array.from(allModelsSet),
    null,
    2
  )};
`;

  // Write to src/types/providers.generated.ts
  const typesDir = path.dirname(outputPath);
  if (!fs.existsSync(typesDir)) {
    fs.mkdirSync(typesDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, generatedCode, 'utf8');
  console.log(`[generate:providers] Successfully generated ${outputPath}`);
}

main();
