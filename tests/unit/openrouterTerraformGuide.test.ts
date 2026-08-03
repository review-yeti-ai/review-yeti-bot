import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('managed OpenRouter deployment contract', () => {
  const guide = read('docs/OPENROUTER_TERRAFORM.md');
  const main = read('infra/openrouter/main.tf');
  const variables = read('infra/openrouter/variables.tf');
  const outputs = read('infra/openrouter/outputs.tf');
  const action = read('action.yml');

  it('pins the OpenRouter provider and keeps the template overrideable', () => {
    expect(main).toContain('registry.terraform.io/OpenRouterTeam/openrouter');
    expect(main).toContain('version = "0.1.30"');
    expect(variables).toContain('variable "allowed_models"');
    expect(variables).toContain('variable "guardrail_limit_usd"');
    expect(variables).toContain('variable "completion_key_limit"');
    expect(outputs).toContain('output "completion_key_hash"');
    expect(outputs).toContain('sensitive   = true');
  });

  it('documents the explicit OpenRouter endpoint and secret boundary', () => {
    expect(guide).toContain('https://openrouter.ai/api/v1');
    expect(guide).toContain('OPENROUTER_API_KEY');
    expect(guide).toContain('OPENROUTER_REVIEW_FLEET_KEY');
    expect(guide).toContain('OPENROUTER_PR_REVIEW_API_KEY');
    expect(guide).toContain('TF_VAR_openrouter_management_key');
    expect(guide).toContain('tofu -chdir=infra/openrouter plan -out=review-fleet.tfplan');
    expect(guide).toContain('guardrail key assignment');
    expect(action).toContain('https://openrouter.ai/api/v1');
  });

  it('keeps the infrastructure template free of deprecated proxy routing', () => {
    expect(main.toLowerCase()).not.toContain('omniroute');
    expect(variables.toLowerCase()).not.toContain('omniroute');
    expect(outputs.toLowerCase()).not.toContain('omniroute');
    expect(guide).toMatch(/Do not configure OmniRoute variables/);
  });
});
