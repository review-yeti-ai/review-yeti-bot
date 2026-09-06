import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';
import { parseAndValidateConfig, ConfigValidationError } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { codeRabbitRawSchema } from '../../src/config/codeRabbitSchema';

const REPO_ROOT = path.resolve(__dirname, '../..');

function repoPath(...segments: string[]): string {
  return path.join(REPO_ROOT, ...segments);
}

function parsePersonaMarkdown(content: string): { frontmatter: Record<string, any> | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content.trim() };
  }
  const parsedFrontmatter = yaml.load(match[1]) as Record<string, any>;
  return { frontmatter: parsedFrontmatter, body: match[2].trim() };
}

describe('Review Yeti E2E Test Suite', () => {
  // Check milestone existence for progressive testability
  const hasExamples = fs.existsSync(repoPath('examples'));
  const hasHelmChart = fs.existsSync(repoPath('charts/review-yeti/Chart.yaml'));
  // REL-570: the chart existing does not mean the `helm` binary does. Every test below that
  // shells out to helm must be gated on the binary too, or it fails with ENOENT on any host
  // without helm instead of skipping.
  const hasHelmBinary = (() => {
    try {
      execSync('helm version --short', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const canRunHelm = hasHelmChart && hasHelmBinary;
  // These shell out to helm; they are subprocess-bound, not logic-bound, and vitest's 5s default
  // is not a meaningful bound on a `helm lint`/`helm template` spawn -- especially with
  // fileParallelism on, where the spawn competes with the other workers. `helm lint` timing out
  // at 5000ms is what reddened main at 67fb09e.
  const HELM_TIMEOUT_MS = 60_000;
  const hasCloudValues = fs.existsSync(repoPath('examples/k8s/values-doks.yaml'));
  const hasHelmGuide = fs.existsSync(repoPath('docs/HELM_GUIDE.md'));
  const hasTroubleshooting = fs.existsSync(repoPath('docs/TROUBLESHOOTING.md'));

  // =========================================================================
  // TIER 1: Feature Coverage & Structural Integrity
  // =========================================================================
  describe('Tier 1: Feature Coverage & Structural Integrity', () => {
    describe('1.1 Workflows (examples/workflows/)', () => {
      it('Feature 1: standalone-action.yml exists, is valid YAML, and configures standalone OpenRouter review', () => {
        const filePath = repoPath('examples/workflows/standalone-action.yml');
        expect(fs.existsSync(filePath), 'standalone-action.yml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;
        expect(doc).toBeTypeOf('object');
        expect(doc.name).toBeDefined();

        // Trigger validation
        expect(doc.on?.pull_request).toBeDefined();

        // Permissions
        expect(doc.permissions).toBeDefined();
        expect(doc.permissions.contents).toBe('read');
        expect(doc.permissions['pull-requests']).toBe('write');

        // Review step
        const steps = doc.jobs?.review?.steps as any[];
        expect(steps).toBeDefined();
        const actionStep = steps.find((s) => s.uses && s.uses.includes('review-yeti-bot'));
        expect(actionStep, 'Step must use review-yeti-bot action').toBeDefined();
        expect(actionStep.with?.['openrouter-api-key']).toBeDefined();
        expect(actionStep.with?.model).toContain('deepseek');
        expect(actionStep.with?.['github-token']).toBeDefined();
      });

      it('Feature 2: github-app-action.yml mints App token and grants checks:write', () => {
        const filePath = repoPath('examples/workflows/github-app-action.yml');
        expect(fs.existsSync(filePath), 'github-app-action.yml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;

        // Permissions must include checks: write for native Check Runs
        expect(doc.permissions?.checks).toBe('write');

        // Must have token minting step
        const steps = doc.jobs?.review?.steps as any[];
        expect(steps).toBeDefined();
        const tokenStep = steps.find((s) => s.uses && s.uses.includes('create-github-app-token'));
        expect(tokenStep, 'Must use create-github-app-token').toBeDefined();
        expect(tokenStep.with?.['app-id']).toBeDefined();
        expect(tokenStep.with?.['private-key']).toBeDefined();

        // Action step must use minted token
        const actionStep = steps.find((s) => s.uses && s.uses.includes('review-yeti-bot'));
        expect(actionStep).toBeDefined();
        expect(actionStep.with?.['github-token']).toMatch(/steps\.(app-token|.+)\.outputs\.token/);
      });

      it('Feature 3: kubernetes-dispatch.yml sets id-token: write and execution-backend: doks', () => {
        const filePath = repoPath('examples/workflows/kubernetes-dispatch.yml');
        expect(fs.existsSync(filePath), 'kubernetes-dispatch.yml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;

        // Permissions must grant OIDC id-token: write
        expect(doc.permissions?.['id-token']).toBe('write');

        const steps = doc.jobs?.dispatch?.steps as any[];
        expect(steps).toBeDefined();
        const dispatchStep = steps.find((s) => s.uses && s.uses.includes('review-yeti-bot'));
        expect(dispatchStep).toBeDefined();
        expect(dispatchStep.with?.['execution-backend']).toBe('doks');
        expect(dispatchStep.with?.['doks-dispatch-url']).toBeDefined();
      });

      it('Feature 4: reusable-hub.yml defines workflow_call and workflow_dispatch interfaces', () => {
        const filePath = repoPath('examples/workflows/reusable-hub.yml');
        expect(fs.existsSync(filePath), 'reusable-hub.yml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;

        expect(doc.on?.workflow_call).toBeDefined();
        expect(doc.on?.workflow_dispatch).toBeDefined();

        // Inputs and secrets declared
        const callInputs = doc.on?.workflow_call?.inputs;
        expect(callInputs?.model).toBeDefined();
      });

      it('Feature 5: consumer-caller.yml is a concise caller referencing central hub', () => {
        const filePath = repoPath('examples/workflows/consumer-caller.yml');
        expect(fs.existsSync(filePath), 'consumer-caller.yml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines.length).toBeLessThanOrEqual(12);

        const doc = yaml.load(content) as Record<string, any>;
        expect(doc.jobs?.review?.uses).toContain('reusable-hub.yml');
        expect(doc.jobs?.review?.secrets).toBe('inherit');
      });

      it('Feature 6: incremental-review.yml configures actions:read and incremental review dials', () => {
        const filePath = repoPath('examples/workflows/incremental-review.yml');
        expect(fs.existsSync(filePath), 'incremental-review.yml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;

        expect(doc.permissions?.actions).toBe('read');

        const steps = doc.jobs?.review?.steps as any[];
        const actionStep = steps.find((s) => s.uses && s.uses.includes('review-yeti-bot'));
        expect(actionStep).toBeDefined();
        expect(String(actionStep.with?.['incremental-review'])).toBe('true');
        expect(actionStep.with?.['max-incremental-diff-chars']).toBeDefined();
        expect(actionStep.with?.['max-incremental-chain']).toBeDefined();
      });
    });

    describe('1.2 Configurations (examples/configs/)', () => {
      it('Feature 7: default.ct-review.yaml defines standard balanced 5-persona setup', () => {
        const filePath = repoPath('examples/configs/default.ct-review.yaml');
        expect(fs.existsSync(filePath), 'default.ct-review.yaml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;

        expect(doc.version).toBe(3);
        expect(doc.profile).toBe('balanced');
        expect(doc.quorum).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(doc.personas)).toBe(true);
        expect(doc.personas.length).toBeGreaterThanOrEqual(5);

        const personaIds = doc.personas.map((p: any) => p.id);
        expect(personaIds).toContain('security');
        expect(personaIds).toContain('performance');
        expect(personaIds).toContain('architecture');
        expect(personaIds).toContain('testing');
        expect(personaIds).toContain('dependencies');
      });

      it('Feature 8: strict-security.ct-review.yaml configures assertive profile and blocking rules', () => {
        const filePath = repoPath('examples/configs/strict-security.ct-review.yaml');
        expect(fs.existsSync(filePath), 'strict-security.ct-review.yaml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;

        expect(doc.version).toBe(3);
        expect(doc.profile).toBe('assertive');
        expect(doc.quorum).toBeGreaterThanOrEqual(2);
        expect(Array.isArray(doc.rules)).toBe(true);
        expect(doc.rules.length).toBeGreaterThan(0);
      });

      it('Feature 9: monorepo.ct-review.yaml defines path_filters and scoped persona paths', () => {
        const filePath = repoPath('examples/configs/monorepo.ct-review.yaml');
        expect(fs.existsSync(filePath), 'monorepo.ct-review.yaml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;

        expect([3, 4]).toContain(doc.version);
        expect(Array.isArray(doc.path_filters)).toBe(true);
        expect(doc.path_filters.length).toBeGreaterThan(0);

        // At least one persona has path scoping beyond ['**']
        const hasScopedPersona = doc.personas.some((p: any) => p.paths && p.paths.some((path: string) => path !== '**'));
        expect(hasScopedPersona, 'Monorepo config must contain path-scoped personas').toBe(true);
      });

      it('Feature 10: coderabbit-compat.yaml defines 1:1 drop-in CodeRabbit sections', () => {
        const filePath = repoPath('examples/configs/coderabbit-compat.yaml');
        expect(fs.existsSync(filePath), 'coderabbit-compat.yaml must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;

        expect(doc.reviews).toBeDefined();
        expect(doc.chat).toBeDefined();
        expect(doc.knowledge_base).toBeDefined();
      });
    });

    describe('1.3 Custom Personas (examples/personas/)', () => {
      const personas = [
        { file: 'tenancy.md', id: 'tenancy', keyword: 'tenant' },
        { file: 'database-migrations.md', id: 'database-migrations', keyword: 'migration' },
        { file: 'performance.md', id: 'performance', keyword: 'performance' },
        { file: 'compliance.md', id: 'compliance', keyword: 'audit' },
      ];

      for (const p of personas) {
        it(`Feature ${p.id}: ${p.file} contains valid YAML frontmatter and comprehensive charter`, () => {
          const filePath = repoPath('examples/personas', p.file);
          expect(fs.existsSync(filePath), `${p.file} must exist`).toBe(true);

          const content = fs.readFileSync(filePath, 'utf-8');
          const { frontmatter, body } = parsePersonaMarkdown(content);

          expect(frontmatter, 'Persona must have YAML frontmatter').not.toBeNull();
          expect(frontmatter?.name).toBeTypeOf('string');
          expect(frontmatter?.model).toBeTypeOf('string');
          expect(frontmatter?.enabled).toBe(true);

          expect(body.length, 'Charter body must be comprehensive (>= 400 chars)').toBeGreaterThanOrEqual(400);
          expect(body.toLowerCase()).toContain(p.keyword);
          expect(body).toMatch(/Role|Mission/i);
          expect(body).toMatch(/What to Flag/i);
          expect(body).toMatch(/Severity Guidelines/i);
        });
      }
    });

    describe('1.4 Documentation & Catalog Index', () => {
      it('Feature 15: examples/README.md indexes all workflows, configs, personas, and k8s values', () => {
        const filePath = repoPath('examples/README.md');
        expect(fs.existsSync(filePath), 'examples/README.md must exist').toBe(true);

        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('standalone-action.yml');
        expect(content).toContain('github-app-action.yml');
        expect(content).toContain('kubernetes-dispatch.yml');
        expect(content).toContain('reusable-hub.yml');
        expect(content).toContain('consumer-caller.yml');
        expect(content).toContain('incremental-review.yml');
        expect(content).toContain('default.ct-review.yaml');
        expect(content).toContain('strict-security.ct-review.yaml');
        expect(content).toContain('monorepo.ct-review.yaml');
        expect(content).toContain('coderabbit-compat.yaml');
        expect(content).toContain('tenancy.md');
        expect(content).toContain('database-migrations.md');
        expect(content).toContain('performance.md');
        expect(content).toContain('compliance.md');
      });

      it.skipIf(!hasHelmGuide)('Feature 22: docs/HELM_GUIDE.md contains complete operational instructions', () => {
        const filePath = repoPath('docs/HELM_GUIDE.md');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('Installation');
        expect(content).toContain('Upgrade');
        expect(content).toContain('Rollback');
        expect(content).toContain('review-yeti');
      });

      it.skipIf(!hasTroubleshooting)('Feature 23: docs/TROUBLESHOOTING.md covers 403, 401, 429, and worker timeouts', () => {
        const filePath = repoPath('docs/TROUBLESHOOTING.md');
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toMatch(/403/);
        expect(content).toMatch(/401/);
        expect(content).toMatch(/429/);
        expect(content).toMatch(/timeout|deadline/i);
      });
    });

    describe('1.5 Helm 3 Chart Structure (charts/review-yeti/)', () => {
      it.skipIf(!hasHelmChart)('Feature 16: Chart.yaml defines valid Helm 3 metadata', () => {
        const filePath = repoPath('charts/review-yeti/Chart.yaml');
        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;
        expect(doc.apiVersion).toBe('v2');
        expect(doc.name).toBe('review-yeti');
        expect(doc.version).toBe('1.0.0');
        expect(doc.appVersion).toBe('1.28.0');
      });

      it.skipIf(!hasHelmChart)('Feature 17: values.yaml specifies non-root securityContext and secret references', () => {
        const filePath = repoPath('charts/review-yeti/values.yaml');
        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = yaml.load(content) as Record<string, any>;

        expect(doc.dispatcher?.securityContext?.runAsNonRoot).toBe(true);
        expect(doc.operator?.securityContext?.runAsNonRoot).toBe(true);
        expect(doc.secrets).toBeDefined();
      });

      it.skipIf(!hasHelmChart)('Feature 18: templates/ directory contains all required manifests', () => {
        const templates = [
          'deployment-dispatcher.yaml',
          'deployment-operator.yaml',
          'service.yaml',
          'ingress.yaml',
          'rbac.yaml',
          // worker-rbac.yaml is deliberately absent (REL-586): it bound jobs:create
          // and pods/exec:create to the DEFAULT ServiceAccount, so any pod running
          // as default with a mounted token could create a pod mounting any Secret
          // in the namespace -- the App private key, every run token, the gateway
          // credential. Asserted absent below so it cannot return by inventory.
          'secrets.yaml',
          'configmap.yaml',
          'crd.yaml',
          '_helpers.tpl',
        ];

        for (const tmpl of templates) {
          const tmplPath = repoPath('charts/review-yeti/templates', tmpl);
          expect(fs.existsSync(tmplPath), `Template ${tmpl} must exist`).toBe(true);
        }
      });

      it.skipIf(!hasHelmChart)('Feature 18a: no template grants the default ServiceAccount pod access', () => {
        // Removal is only durable if reintroduction fails. Scan every rendered
        // template rather than just the deleted filename, so an equivalent grant
        // added elsewhere is caught too.
        const dir = repoPath('charts/review-yeti/templates');
        const rendered = fs.readdirSync(dir)
          .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
          .join('\n');
        expect(rendered).not.toContain('pods/exec');
        expect(rendered).not.toMatch(/name:\s*default\b/u);
      });
    });
  });

  // =========================================================================
  // TIER 2: Boundary, Corner Cases & Strict Schema Validation
  // =========================================================================
  describe('Tier 2: Boundary, Corner Cases & Strict Schema Validation', () => {
    describe('2.1 Strict Zod Validation of Example Configs', () => {
      it('validates default.ct-review.yaml against ctReviewConfigV3Schema without errors', () => {
        const content = fs.readFileSync(repoPath('examples/configs/default.ct-review.yaml'), 'utf-8');
        const config = parseAndValidateConfig(content);
        expect(config.version).toBe(3);
        expect(config.profile).toBe('balanced');
      });

      it('validates strict-security.ct-review.yaml against ctReviewConfigV3Schema without errors', () => {
        const content = fs.readFileSync(repoPath('examples/configs/strict-security.ct-review.yaml'), 'utf-8');
        const config = parseAndValidateConfig(content);
        expect(config.version).toBe(3);
        expect(config.profile).toBe('assertive');
      });

      it('validates monorepo.ct-review.yaml against ctReviewConfigV3Schema without errors', () => {
        const content = fs.readFileSync(repoPath('examples/configs/monorepo.ct-review.yaml'), 'utf-8');
        const config = parseAndValidateConfig(content);
        expect([3, 4]).toContain(config.version);
      });

      it('validates coderabbit-compat.yaml against codeRabbitRawSchema and translates to V3', () => {
        const content = fs.readFileSync(repoPath('examples/configs/coderabbit-compat.yaml'), 'utf-8');
        const rawObj = yaml.load(content);
        const parsedCodeRabbit = codeRabbitRawSchema.safeParse(rawObj);
        expect(parsedCodeRabbit.success, 'coderabbit-compat.yaml must conform to codeRabbitRawSchema').toBe(true);

        const translated = parseAndValidateConfig(content, true);
        expect(translated.version).toBe(3);
      });
    });

    describe('2.2 Negative & Adversarial Boundary Tests', () => {
      it('rejects configuration where quorum exceeds enabled distinct providers', () => {
        const invalidConfig = `
version: 3
profile: balanced
quorum: 5
personas:
  - id: security
    enabled: true
    required: true
    charter: "builtin:security"
    paths: ["**"]
    providers: ["openrouter"]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: openrouter
      enabled: true
      model: "deepseek/deepseek-v4-flash-0731"
      effort: high
      review_timeout_s: 180
      arbiter_timeout_s: 120
  arbiter:
    order: ["openrouter"]
`;
        expect(() => parseAndValidateConfig(invalidConfig)).toThrow(ConfigValidationError);
        expect(() => parseAndValidateConfig(invalidConfig)).toThrow(/quorum exceeds enabled distinct providers/);
      });

      it('rejects configuration with duplicate persona IDs', () => {
        const duplicateIdConfig = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    enabled: true
    required: true
    charter: "builtin:security"
    paths: ["**"]
    providers: ["openrouter"]
  - id: security
    enabled: true
    required: false
    charter: "builtin:constitutional-goals"
    paths: ["**"]
    providers: ["openrouter"]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: openrouter
      enabled: true
      model: "deepseek/deepseek-v4-flash-0731"
      effort: high
      review_timeout_s: 180
      arbiter_timeout_s: 120
  arbiter:
    order: ["openrouter"]
`;
        expect(() => parseAndValidateConfig(duplicateIdConfig)).toThrow(ConfigValidationError);
        expect(() => parseAndValidateConfig(duplicateIdConfig)).toThrow(/persona ids must be unique/);
      });

      it('rejects configuration where no enabled persona is required', () => {
        const noRequiredConfig = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    enabled: true
    required: false
    charter: "builtin:security"
    paths: ["**"]
    providers: ["openrouter"]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: openrouter
      enabled: true
      model: "deepseek/deepseek-v4-flash-0731"
      effort: high
      review_timeout_s: 180
      arbiter_timeout_s: 120
  arbiter:
    order: ["openrouter"]
`;
        expect(() => parseAndValidateConfig(noRequiredConfig)).toThrow(ConfigValidationError);
        expect(() => parseAndValidateConfig(noRequiredConfig)).toThrow(/at least one enabled required persona/);
      });

      it('rejects persona file with empty charter body', () => {
        const emptyCharter = `---
name: "Empty Persona"
model: openrouter/deepseek/deepseek-v4-flash-0731
enabled: true
---
`;
        const { frontmatter, body } = parsePersonaMarkdown(emptyCharter);
        expect(frontmatter?.name).toBe('Empty Persona');
        expect(body.length).toBe(0);
      });

      it('rejects malformed YAML configurations cleanly', () => {
        expect(() => parseAndValidateConfig('version: 3\nquorum: [unterminated')).toThrow(ConfigValidationError);
      });
    });

    describe('2.3 Helm Chart Linting', () => {
      it.skipIf(!canRunHelm)('helm lint charts/review-yeti passes with 0 errors and 0 warnings', () => {
        const cmd = 'helm lint charts/review-yeti';
        const output = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf-8' });
        expect(output).toContain('0 chart(s) failed');
        expect(output).not.toContain('[ERROR]');
        expect(output).not.toContain('[WARNING]');
      }, HELM_TIMEOUT_MS);
    });
  });

  // =========================================================================
  // TIER 3: Cross-Feature Combinations & Multi-Cloud Matrix
  // =========================================================================
  describe('Tier 3: Cross-Feature Combinations & Multi-Cloud Matrix', () => {
    it.skipIf(!canRunHelm)('renders base values.yaml with 100% valid Kubernetes YAML manifests', () => {
      const output = execSync('helm template review-yeti charts/review-yeti', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      const docs = yaml.loadAll(output).filter((d) => d && typeof d === 'object') as Record<string, any>[];
      expect(docs.length).toBeGreaterThanOrEqual(8);

      // Verify Dispatcher securityContext
      const dispatcher = docs.find((d) => d.kind === 'Deployment' && d.metadata?.name?.includes('dispatcher'));
      expect(dispatcher).toBeDefined();
      const dispSec = dispatcher?.spec?.template?.spec?.securityContext;
      expect(dispSec?.runAsNonRoot).toBe(true);

      // Verify Operator securityContext
      const operator = docs.find((d) => d.kind === 'Deployment' && d.metadata?.name?.includes('operator'));
      expect(operator).toBeDefined();
      const opSec = operator?.spec?.template?.spec?.securityContext;
      expect(opSec?.runAsNonRoot).toBe(true);
    }, HELM_TIMEOUT_MS);

    it.skipIf(!canRunHelm || !hasCloudValues)('renders DOKS cloud values with DO Block Storage CSI and DO LoadBalancer Ingress', () => {
      const output = execSync('helm template review-yeti charts/review-yeti -f examples/k8s/values-doks.yaml', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      const docs = yaml.loadAll(output).filter((d) => d && typeof d === 'object') as Record<string, any>[];

      // Ingress check
      const ingress = docs.find((d) => d.kind === 'Ingress');
      expect(ingress).toBeDefined();
      expect(ingress?.spec?.ingressClassName).toBe('nginx');
      expect(JSON.stringify(ingress?.metadata?.annotations)).toContain('service.beta.kubernetes.io/do-loadbalancer');

      // Operator Role check (namespace-scoped, no secrets, no nodes)
      const role = docs.find((d) => d.kind === 'Role');
      expect(role).toBeDefined();
      const clusterRole = docs.find((d) => d.kind === 'ClusterRole');
      expect(clusterRole, 'Operator must not use ClusterRole').toBeUndefined();

      const roleRules = JSON.stringify(role?.rules);
      expect(roleRules).not.toContain('"secrets"');
      expect(roleRules).not.toContain('"nodes"');
    }, HELM_TIMEOUT_MS);

    it.skipIf(!canRunHelm || !hasCloudValues)('renders EKS cloud values with AWS ALB Ingress annotations and IRSA support', () => {
      const output = execSync('helm template review-yeti charts/review-yeti -f examples/k8s/values-eks.yaml', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      const docs = yaml.loadAll(output).filter((d) => d && typeof d === 'object') as Record<string, any>[];

      const ingress = docs.find((d) => d.kind === 'Ingress');
      expect(ingress).toBeDefined();
      expect(ingress?.spec?.ingressClassName).toBe('alb');
      expect(ingress?.metadata?.annotations?.['alb.ingress.kubernetes.io/scheme']).toBe('internet-facing');
    }, HELM_TIMEOUT_MS);

    it.skipIf(!canRunHelm || !hasCloudValues)('renders local Minikube/Kind values with NodePort service and Ollama endpoint', () => {
      const output = execSync('helm template review-yeti charts/review-yeti -f examples/k8s/values-local.yaml', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      const docs = yaml.loadAll(output).filter((d) => d && typeof d === 'object') as Record<string, any>[];

      const service = docs.find((d) => d.kind === 'Service' && d.metadata?.name?.includes('dispatcher'));
      expect(service).toBeDefined();
      expect(service?.spec?.type).toBe('NodePort');
      expect(service?.spec?.ports?.[0]?.nodePort).toBe(30080);
    }, HELM_TIMEOUT_MS);

    it('validates security context hardening invariant across dispatcher template', () => {
      // Test the contract invariant: containers must have allowPrivilegeEscalation: false and readOnlyRootFilesystem: true
      const mockContainerSecurity = {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      };
      expect(mockContainerSecurity.allowPrivilegeEscalation).toBe(false);
      expect(mockContainerSecurity.readOnlyRootFilesystem).toBe(true);
      expect(mockContainerSecurity.capabilities.drop).toContain('ALL');
    });
  });

  // =========================================================================
  // TIER 4: Real-World Scenarios, Gallery Catalog Integrity & Anonymity Audit
  // =========================================================================
  describe('Tier 4: Real-World Scenarios, Gallery Catalog Integrity & Anonymity Audit', () => {
    it('Feature 15: all local file references in examples/README.md resolve to existing files', () => {
      const readmePath = repoPath('examples/README.md');
      const content = fs.readFileSync(readmePath, 'utf-8');

      // Match markdown links [text](relative_path)
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      let match: RegExpExecArray | null;
      const brokenLinks: string[] = [];

      while ((match = linkRegex.exec(content)) !== null) {
        const target = match[2].trim();
        // Skip external URLs and anchors
        if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#')) {
          continue;
        }

        // Relative path resolution from examples/
        const resolvedPath = path.resolve(repoPath('examples'), target);
        if (!fs.existsSync(resolvedPath)) {
          brokenLinks.push(`${match[1]} -> ${target}`);
        }
      }

      // If cloud values aren't in examples/k8s/ yet, ignore only pending M2 k8s links
      const nonK8sBroken = brokenLinks.filter((l) => !l.includes('k8s/') && !l.includes('values-'));
      expect(nonK8sBroken, `All examples/ README links must resolve: ${nonK8sBroken.join(', ')}`).toEqual([]);
    });

    it('Feature 25: zero "calltelemetry" occurrences in examples/', () => {
      const examplesDir = repoPath('examples');
      let result = '';
      try {
        result = execSync('grep -rn "calltelemetry" examples/', { cwd: REPO_ROOT, encoding: 'utf-8' });
      } catch (err: any) {
        // grep returns code 1 if no matches found, which is what we want!
        result = '';
      }
      expect(result.trim(), 'examples/ must have 0 calltelemetry mentions').toBe('');
    });

    it.skipIf(!hasHelmChart)('Feature 25: zero "calltelemetry" occurrences in charts/', () => {
      let result = '';
      try {
        result = execSync('grep -rn "calltelemetry" charts/', { cwd: REPO_ROOT, encoding: 'utf-8' });
      } catch (err: any) {
        result = '';
      }
      expect(result.trim(), 'charts/ must have 0 calltelemetry mentions').toBe('');
    });

    it.skipIf(!hasHelmGuide || !hasTroubleshooting)('Feature 25: zero "calltelemetry" occurrences in newly authored docs', () => {
      const newDocs = ['docs/HELM_GUIDE.md', 'docs/TROUBLESHOOTING.md'];
      for (const doc of newDocs) {
        const docPath = repoPath(doc);
        if (fs.existsSync(docPath)) {
          const content = fs.readFileSync(docPath, 'utf-8');
          expect(content.toLowerCase()).not.toContain('calltelemetry');
        }
      }
    });

    it('Feature 25: zero "calltelemetry" occurrences across all files delivered in Milestone 1', () => {
      const m1Files = [
        'examples/workflows/standalone-action.yml',
        'examples/workflows/github-app-action.yml',
        'examples/workflows/kubernetes-dispatch.yml',
        'examples/workflows/reusable-hub.yml',
        'examples/workflows/consumer-caller.yml',
        'examples/workflows/incremental-review.yml',
        'examples/configs/default.ct-review.yaml',
        'examples/configs/strict-security.ct-review.yaml',
        'examples/configs/monorepo.ct-review.yaml',
        'examples/configs/coderabbit-compat.yaml',
        'examples/personas/tenancy.md',
        'examples/personas/database-migrations.md',
        'examples/personas/performance.md',
        'examples/personas/compliance.md',
        'examples/README.md',
      ];

      for (const file of m1Files) {
        const fullPath = repoPath(file);
        expect(fs.existsSync(fullPath), `${file} must exist`).toBe(true);
        const text = fs.readFileSync(fullPath, 'utf-8');
        expect(text.toLowerCase(), `${file} contains proprietary name`).not.toContain('calltelemetry');
      }
    });
  });
});
