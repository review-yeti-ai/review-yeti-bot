import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { execSync } from 'child_process';

describe('Milestone 5 DOKS Deployment & Kubernetes Manifest Integration Test Suite', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const k8sDir = path.join(rootDir, 'k8s');
  const scriptsDir = path.join(rootDir, 'scripts');

  it('parses and validates deployment.yaml manifest structure', () => {
    const deploymentPath = path.join(k8sDir, 'deployment.yaml');
    expect(fs.existsSync(deploymentPath)).toBe(true);

    const doc = yaml.load(fs.readFileSync(deploymentPath, 'utf-8')) as any;
    expect(doc.apiVersion).toBe('apps/v1');
    expect(doc.kind).toBe('Deployment');
    expect(doc.metadata.name).toBe('ct-review-bot');
    expect(doc.spec.replicas).toBe(2);
    expect(doc.spec.selector.matchLabels.app).toBe('ct-review-bot');
    expect(doc.spec.strategy.type).toBe('RollingUpdate');

    const container = doc.spec.template.spec.containers[0];
    expect(container.name).toBe('ct-review-bot');
    expect(container.ports[0].containerPort).toBe(3000);

    // securityContext
    expect(container.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 10001,
      allowPrivilegeEscalation: false,
      capabilities: {
        drop: ['ALL']
      }
    });

    // livenessProbe
    expect(container.livenessProbe.httpGet.path).toBe('/health');
    expect(container.livenessProbe.httpGet.port).toBe(3000);
    expect(container.livenessProbe.initialDelaySeconds).toBe(10);
    expect(container.livenessProbe.periodSeconds).toBe(15);

    // readinessProbe
    expect(container.readinessProbe.httpGet.path).toBe('/api/router/status');
    expect(container.readinessProbe.httpGet.port).toBe(3000);
    expect(container.readinessProbe.initialDelaySeconds).toBe(5);
    expect(container.readinessProbe.periodSeconds).toBe(10);

    // resources
    expect(container.resources).toEqual({
      requests: {
        cpu: '250m',
        memory: '512Mi'
      },
      limits: {
        cpu: '1000m',
        memory: '1Gi'
      }
    });

    // envFrom
    expect(container.envFrom).toEqual([
      { configMapRef: { name: 'ct-review-bot-config' } },
      { secretRef: { name: 'ct-review-bot-secret' } }
    ]);

    // volumeMounts
    expect(container.volumeMounts[0].mountPath).toBe('/app/data');
    expect(doc.spec.template.spec.volumes[0].emptyDir).toBeDefined();
  });

  it('parses and validates service.yaml manifest structure', () => {
    const servicePath = path.join(k8sDir, 'service.yaml');
    expect(fs.existsSync(servicePath)).toBe(true);

    const doc = yaml.load(fs.readFileSync(servicePath, 'utf-8')) as any;
    expect(doc.apiVersion).toBe('v1');
    expect(doc.kind).toBe('Service');
    expect(doc.metadata.name).toBe('ct-review-bot-service');
    expect(doc.spec.type).toBe('ClusterIP');
    expect(doc.spec.ports[0].port).toBe(3000);
    expect(doc.spec.ports[0].targetPort).toBe(3000);
    expect(doc.spec.selector.app).toBe('ct-review-bot');
  });

  it('parses and validates configmap.yaml manifest structure', () => {
    const configMapPath = path.join(k8sDir, 'configmap.yaml');
    expect(fs.existsSync(configMapPath)).toBe(true);

    const doc = yaml.load(fs.readFileSync(configMapPath, 'utf-8')) as any;
    expect(doc.apiVersion).toBe('v1');
    expect(doc.kind).toBe('ConfigMap');
    expect(doc.metadata.name).toBe('ct-review-bot-config');
    expect(doc.data).toEqual({
      PORT: '3000',
      HOST: '0.0.0.0',
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      OMNIROUTE_BASE_URL: 'http://omniroute-service.default.svc.cluster.local:9090',
      AGY_ENDPOINT: 'http://omniroute-service.default.svc.cluster.local:9090',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api',
      OPENAI_BASE_URL: 'https://api.openai.com',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      CT_REVIEW_DB_PATH: '/app/data/pr_states.sqlite'
    });
  });

  it('parses and validates secret.yaml manifest structure', () => {
    const secretPath = path.join(k8sDir, 'secret.yaml');
    expect(fs.existsSync(secretPath)).toBe(true);

    const doc = yaml.load(fs.readFileSync(secretPath, 'utf-8')) as any;
    expect(doc.apiVersion).toBe('v1');
    expect(doc.kind).toBe('Secret');
    expect(doc.metadata.name).toBe('ct-review-bot-secret');
    expect(doc.type).toBe('Opaque');

    const secretData = doc.stringData || doc.data;
    expect(secretData).toBeDefined();
    expect(secretData.WEBHOOK_SECRET).toBeDefined();
    expect(secretData.GITHUB_APP_ID || secretData.GITHUB_TOKEN).toBeDefined();
    expect(secretData.CT_SECRET_SALT).toBeDefined();
    expect(secretData.CT_SECRET_MASTER_KEY).toBeDefined();
  });

  it('parses and validates ingress.yaml manifest structure', () => {
    const ingressPath = path.join(k8sDir, 'ingress.yaml');
    expect(fs.existsSync(ingressPath)).toBe(true);

    const doc = yaml.load(fs.readFileSync(ingressPath, 'utf-8')) as any;
    expect(doc.apiVersion).toBe('networking.k8s.io/v1');
    expect(doc.kind).toBe('Ingress');
    expect(doc.metadata.name).toBe('ct-review-bot-ingress');
    expect(doc.metadata.annotations['kubernetes.io/ingress.class']).toBe('nginx');

    const rule = doc.spec.rules[0];
    const pathItem = rule.http.paths[0];
    expect(pathItem.path).toBe('/');
    expect(pathItem.backend.service.name).toBe('ct-review-bot-service');
    expect(pathItem.backend.service.port.number).toBe(3000);
  });

  it('executes scripts/deploy-doks.sh --dry-run using execSync', () => {
    const deployScriptPath = path.join(scriptsDir, 'deploy-doks.sh');
    expect(fs.existsSync(deployScriptPath)).toBe(true);

    const output = execSync(`${deployScriptPath} --dry-run`, {
      cwd: rootDir,
      encoding: 'utf-8'
    });

    expect(output).toContain('DOKS Deployment Script');
    expect(output).toContain('Dry Run Mode: true');
    expect(output).toContain('Dry-run completed successfully.');
  });

  it('executes scripts/verify-doks.sh --dry-run using execSync', () => {
    const verifyScriptPath = path.join(scriptsDir, 'verify-doks.sh');
    expect(fs.existsSync(verifyScriptPath)).toBe(true);

    const output = execSync(`${verifyScriptPath} --dry-run`, {
      cwd: rootDir,
      encoding: 'utf-8'
    });

    expect(output).toContain('DOKS Verification Script');
    expect(output).toContain('Dry Run Mode: true');
    expect(output).toContain('Verification completed successfully.');
  });
});
