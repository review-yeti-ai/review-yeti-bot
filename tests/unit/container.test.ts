import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Container Configuration Unit Tests', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const dockerfilePath = path.join(rootDir, 'Dockerfile');
  const dockerignorePath = path.join(rootDir, '.dockerignore');
  const botDeploymentPath = path.join(rootDir, 'k8s/bot-deployment.yaml.tpl');
  const ingressNetworkPath = path.join(rootDir, 'k8s/ingress-network.yaml');
  const omniRouteStatefulSetPath = path.join(
    rootDir,
    'k8s/omniroute-statefulset.yaml.tpl'
  );

  it('reads and validates Dockerfile multi-stage build configuration', () => {
    expect(fs.existsSync(dockerfilePath)).toBe(true);
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

    // Multi-stage build
    expect(dockerfile).toContain('AS builder');
    expect(dockerfile).toContain('AS runner');

    // Pinned major runtime shared by builder and runner.
    const fromLines = dockerfile.split('\n').filter(line => line.trim().startsWith('FROM'));
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
    fromLines.forEach(line => {
      expect(line).toContain('node:24-bookworm-slim');
    });

    // Builder stage steps
    expect(dockerfile).toContain('npm ci');
    expect(dockerfile).toContain('npm run build');
    expect(dockerfile).toContain('npm prune --omit=dev --omit=optional');

    // Non-root security
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('COPY --chown=node:node');

    // Expose 3000
    expect(dockerfile).toMatch(/EXPOSE\s+3000/);

    // Healthcheck
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/health');

    // CMD
    expect(dockerfile).toMatch(/CMD\s+\["node",\s*"dist\/index\.js"\]/);
  });

  it('reads and validates .dockerignore exclusions', () => {
    expect(fs.existsSync(dockerignorePath)).toBe(true);
    const dockerignore = fs.readFileSync(dockerignorePath, 'utf-8');
    const lines = dockerignore.split('\n').map(l => l.trim()).filter(Boolean);

    const requiredExclusions = [
      'node_modules',
      'dist',
      'coverage',
      '.git',
      '.agents',
      '.env',
      'tests',
      '*.log',
      'tmp',
      'Dockerfile',
      '.dockerignore',
      '.gitignore',
      'README.md'
    ];

    for (const item of requiredExclusions) {
      expect(lines).toContain(item);
    }
  });

  it('grants the non-root OmniRoute process write access to its persistent volume', () => {
    const statefulSet = fs.readFileSync(omniRouteStatefulSetPath, 'utf-8');

    expect(statefulSet).toContain('runAsUser: 10002');
    expect(statefulSet).toContain('runAsGroup: 10002');
    expect(statefulSet).toContain('fsGroup: 10002');
    expect(statefulSet).toContain('fsGroupChangePolicy: OnRootMismatch');
  });

  it('grants the non-root review bot write access to its persistent run store', () => {
    const deployment = fs.readFileSync(botDeploymentPath, 'utf-8');

    expect(deployment).toContain('runAsUser: 1000');
    expect(deployment).toContain('runAsGroup: 1000');
    expect(deployment).toContain('fsGroup: 1000');
    expect(deployment).toContain('fsGroupChangePolicy: OnRootMismatch');
  });

  it('allows HAProxy to reach only cert-manager HTTP-01 solver pods', () => {
    const ingressNetwork = fs.readFileSync(ingressNetworkPath, 'utf-8');

    expect(ingressNetwork).toContain('name: acme-http01-solver-allowed');
    expect(ingressNetwork).toContain('acme.cert-manager.io/http01-solver: "true"');
    expect(ingressNetwork).toContain('kubernetes.io/metadata.name: ct-dev');
    expect(ingressNetwork).toContain('app.kubernetes.io/name: haproxy-ingress');
    expect(ingressNetwork).toContain('port: 8089');
  });
});
