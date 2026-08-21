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

  it('reads and validates Dockerfile production runner configuration', () => {
    expect(fs.existsSync(dockerfilePath)).toBe(true);
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

    // Production runner stage
    expect(dockerfile).toContain('AS runner');
    expect(dockerfile).toContain('node:24-bookworm-slim');
    expect(dockerfile).toContain('npm ci');

    // Non-root security
    expect(dockerfile).toContain('USER node');

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

    expect(ingressNetwork).toContain('kubernetes.io/ingress.class: haproxy-ct-dev');
    expect(ingressNetwork).toContain('name: acme-http01-solver-allowed');
    expect(ingressNetwork).toContain('acme.cert-manager.io/http01-solver: "true"');
    expect(ingressNetwork).toContain('kubernetes.io/metadata.name: ct-dev');
    expect(ingressNetwork).toContain('app.kubernetes.io/name: haproxy-ingress');
    expect(ingressNetwork).toContain('port: 8089');
  });

  it('validates bot-deployment.yaml.tpl rolling update strategy, probes, and resource bounds', () => {
    const deployment = fs.readFileSync(botDeploymentPath, 'utf-8');

    // Rolling update strategy
    expect(deployment).toContain('type: RollingUpdate');
    expect(deployment).toContain('maxSurge: 1');
    expect(deployment).toContain('maxUnavailable: 0');

    // Readiness & Liveness probes
    expect(deployment).toContain('path: /ready');
    expect(deployment).toContain('path: /health');
    expect(deployment).toContain('initialDelaySeconds: 3');
    expect(deployment).toContain('periodSeconds: 5');
    expect(deployment).toContain('timeoutSeconds: 2');

    // Resource limits & requests
    expect(deployment).toContain('cpu: 100m');
    expect(deployment).toContain('memory: 256Mi');
    expect(deployment).toContain('cpu: 500m');
    expect(deployment).toContain('memory: 512Mi');
  });

  it('validates deploy-doks.sh and verify-doks.sh for sha256 enforcement, pod readiness, and endpoint checks', () => {
    const deployScript = fs.readFileSync(path.join(rootDir, 'scripts/deploy-doks.sh'), 'utf-8');
    const verifyScript = fs.readFileSync(path.join(rootDir, 'scripts/verify-doks.sh'), 'utf-8');

    // SHA256 64-hex digest pinning enforcement
    expect(deployScript).toMatch(/@sha256:\[0-9a-fA-F\]\{64\}/);
    expect(verifyScript).toMatch(/@sha256:\[0-9a-fA-F\]\{64\}/);

    // Pod readiness checks
    expect(deployScript).toContain('wait --for=condition=ready pod');
    expect(verifyScript).toContain('wait --for=condition=ready pod');

    // Endpoints verified in verify-doks.sh
    expect(verifyScript).toContain('/health');
    expect(verifyScript).toContain('/ready');
    expect(verifyScript).toContain('/api/version');
  });
});
