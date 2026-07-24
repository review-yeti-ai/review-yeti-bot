import { spawn, execSync } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

const rootDir = path.resolve(__dirname, '../../');
const distIndexPath = path.join(rootDir, 'dist/index.js');
const k8sDir = path.join(rootDir, 'k8s');

interface TestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  details: string;
}

const results: TestResult[] = [];

function logResult(category: string, name: string, status: 'PASS' | 'FAIL' | 'WARN', details: string) {
  results.push({ category, name, status, details });
  console.log(`[${status}] ${category} :: ${name} -> ${details}`);
}

function makeRequest(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function runHostBindingTests() {
  console.log('\n--- 1. HOST & PORT BINDING EMPIRICAL TESTS ---');

  // Test 1.1: Custom PORT=3991 and HOST=0.0.0.0
  try {
    const child = spawn('node', [distIndexPath], {
      env: { ...process.env, PORT: '3991', HOST: '0.0.0.0', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await new Promise((r) => setTimeout(r, 1000));
    const res = await makeRequest('http://127.0.0.1:3991/health');
    if (res.status === 200) {
      logResult('Host Binding', 'PORT=3991 HOST=0.0.0.0 binding', 'PASS', `Received status ${res.status}: ${res.body}`);
    } else {
      logResult('Host Binding', 'PORT=3991 HOST=0.0.0.0 binding', 'FAIL', `Unexpected status ${res.status}`);
    }

    // Graceful shutdown test via SIGTERM
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    child.kill('SIGTERM');
    const exitCode = await exitPromise;
    if (exitCode === 0) {
      logResult('Host Binding', 'SIGTERM Graceful Shutdown', 'PASS', 'Process exited with status 0 upon SIGTERM');
    } else {
      logResult('Host Binding', 'SIGTERM Graceful Shutdown', 'FAIL', `Process exited with code ${exitCode}`);
    }
  } catch (err: any) {
    logResult('Host Binding', 'PORT=3991 HOST=0.0.0.0 binding', 'FAIL', err.message);
  }

  // Test 1.2: Custom PORT=3992 and HOST=127.0.0.1
  try {
    const child = spawn('node', [distIndexPath], {
      env: { ...process.env, PORT: '3992', HOST: '127.0.0.1', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await new Promise((r) => setTimeout(r, 1000));
    const res = await makeRequest('http://127.0.0.1:3992/health');
    if (res.status === 200) {
      logResult('Host Binding', 'PORT=3992 HOST=127.0.0.1 binding', 'PASS', `Successfully responded on 127.0.0.1:3992`);
    } else {
      logResult('Host Binding', 'PORT=3992 HOST=127.0.0.1 binding', 'FAIL', `Unexpected status ${res.status}`);
    }

    // Graceful shutdown via SIGINT
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    child.kill('SIGINT');
    const exitCode = await exitPromise;
    if (exitCode === 0) {
      logResult('Host Binding', 'SIGINT Graceful Shutdown', 'PASS', 'Process exited with status 0 upon SIGINT');
    } else {
      logResult('Host Binding', 'SIGINT Graceful Shutdown', 'FAIL', `Process exited with code ${exitCode}`);
    }
  } catch (err: any) {
    logResult('Host Binding', 'PORT=3992 HOST=127.0.0.1 binding', 'FAIL', err.message);
  }

  // Test 1.3: Empty HOST string fallback
  try {
    const child = spawn('node', [distIndexPath], {
      env: { ...process.env, PORT: '3993', HOST: '', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await new Promise((r) => setTimeout(r, 1000));
    const res = await makeRequest('http://127.0.0.1:3993/health');
    if (res.status === 200) {
      logResult('Host Binding', 'Empty HOST string fallback to 0.0.0.0', 'PASS', `Successfully responded when HOST=""`);
    } else {
      logResult('Host Binding', 'Empty HOST string fallback to 0.0.0.0', 'FAIL', `Unexpected status ${res.status}`);
    }

    child.kill('SIGTERM');
  } catch (err: any) {
    logResult('Host Binding', 'Empty HOST fallback', 'FAIL', err.message);
  }

  // Test 1.4: Invalid PORT string (e.g. PORT=abc)
  try {
    const child = spawn('node', [distIndexPath], {
      env: { ...process.env, PORT: 'invalid_port', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderrData = '';
    child.stderr?.on('data', (d) => (stderrData += d.toString()));

    await new Promise((r) => setTimeout(r, 1000));
    child.kill('SIGKILL');

    if (stderrData.includes('RangeError') || stderrData.includes('ERR_SOCKET_BAD_PORT') || stderrData.includes('NaN')) {
      logResult('Host Binding', 'Invalid PORT handling (PORT=invalid_port)', 'WARN', `NaN port causes error/unpredictable binding: ${stderrData.slice(0, 100)}`);
    } else {
      logResult('Host Binding', 'Invalid PORT handling (PORT=invalid_port)', 'WARN', `Process behaved unexpectedly with PORT=invalid_port`);
    }
  } catch (err: any) {
    logResult('Host Binding', 'Invalid PORT handling', 'WARN', err.message);
  }
}

function runContainerStaticTestAudits() {
  console.log('\n--- 2. DOCKERFILE & .DOCKERIGNORE STATIC TEST BYPASS & SECURITY AUDIT ---');

  const dockerfilePath = path.join(rootDir, 'Dockerfile');
  const dockerignorePath = path.join(rootDir, '.dockerignore');

  const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
  const dockerignoreContent = fs.readFileSync(dockerignorePath, 'utf-8');

  // Audit 2.1: Check if container.test.ts can be bypassed by appending USER root at the end of Dockerfile
  const mockBypassDockerfile = dockerfileContent + '\nUSER root\n';
  const hasUserNode = mockBypassDockerfile.includes('USER node');
  const hasChown = mockBypassDockerfile.includes('COPY --chown=node:node');
  if (hasUserNode && hasChown) {
    logResult('Container Static Test', 'Bypass Vulnerability: USER root append after USER node', 'WARN',
      'container.test.ts passes if "USER node" is anywhere in Dockerfile, even if followed by "USER root".');
  }

  // Audit 2.2: Check node user UID vs Kubernetes runAsUser
  // Alpine node image creates `node` user with UID 1000.
  // deployment.yaml specifies `runAsUser: 10001`.
  logResult('Container Security', 'UID Mismatch: Container node user vs K8s runAsUser', 'WARN',
    'Dockerfile creates user "node" (UID 1000) and COPY --chown=node:node sets ownership to 1000. deployment.yaml sets runAsUser: 10001, which may cause file permission denied issues when reading /app files!');

  // Audit 2.3: Check HEALTHCHECK command in Dockerfile
  if (dockerfileContent.includes('HEALTHCHECK') && dockerfileContent.includes("fetch('http://localhost:3000/health')")) {
    logResult('Container Security', 'Dockerfile HEALTHCHECK Directive', 'PASS',
      'Uses Node.js global fetch to test http://localhost:3000/health without requiring curl or wget.');
  } else {
    logResult('Container Security', 'Dockerfile HEALTHCHECK Directive', 'FAIL',
      'HEALTHCHECK directive is missing or uses missing tool.');
  }

  // Audit 2.4: Check .dockerignore completeness & sensitivity
  const dockerignoreLines = dockerignoreContent.split('\n').map(l => l.trim()).filter(Boolean);
  const sensitiveFiles = ['.env', '.git', 'coverage', 'tests', '.agents', 'Dockerfile', '.dockerignore'];
  const missingSensitive = sensitiveFiles.filter(f => !dockerignoreLines.includes(f));
  if (missingSensitive.length === 0) {
    logResult('Container Static Test', '.dockerignore Security Exclusions', 'PASS',
      'All required sensitive files (.env, .git, coverage, tests, .agents, etc.) are excluded.');
  } else {
    logResult('Container Static Test', '.dockerignore Security Exclusions', 'FAIL',
      `Missing sensitive exclusions: ${missingSensitive.join(', ')}`);
  }

  // Audit 2.5: Test behavior if .dockerignore uses trailing slashes (e.g. node_modules/)
  logResult('Container Static Test', '.dockerignore Trailing Slash Exact Matching Risk', 'WARN',
    'container.test.ts uses exact string equality expect(lines).toContain("node_modules"). If a developer writes "node_modules/", the test fails despite being valid .dockerignore syntax.');
}

function runKubernetesManifestAudits() {
  console.log('\n--- 3. KUBERNETES MANIFEST & DOKS DEPLOYMENT INTEGRATION AUDIT ---');

  const deploymentDoc = yaml.load(fs.readFileSync(path.join(k8sDir, 'deployment.yaml'), 'utf-8')) as any;
  const serviceDoc = yaml.load(fs.readFileSync(path.join(k8sDir, 'service.yaml'), 'utf-8')) as any;
  const configmapDoc = yaml.load(fs.readFileSync(path.join(k8sDir, 'configmap.yaml'), 'utf-8')) as any;
  const secretDoc = yaml.load(fs.readFileSync(path.join(k8sDir, 'secret.yaml'), 'utf-8')) as any;
  const ingressDoc = yaml.load(fs.readFileSync(path.join(k8sDir, 'ingress.yaml'), 'utf-8')) as any;

  // 3.1 SecurityContext audit in deployment.yaml
  const containerSec = deploymentDoc.spec.template.spec.containers[0].securityContext;
  if (containerSec.runAsNonRoot === true && containerSec.allowPrivilegeEscalation === false && containerSec.capabilities?.drop?.includes('ALL')) {
    logResult('K8s Manifest', 'deployment.yaml SecurityContext', 'PASS',
      'Enforces runAsNonRoot=true, allowPrivilegeEscalation=false, capabilities.drop=[ALL].');
  } else {
    logResult('K8s Manifest', 'deployment.yaml SecurityContext', 'FAIL',
      'SecurityContext missing required security constraints.');
  }

  // 3.2 Image tag audit
  const containerImage = deploymentDoc.spec.template.spec.containers[0].image;
  if (containerImage.endsWith(':latest')) {
    logResult('K8s Manifest', 'deployment.yaml Image Tag Policy', 'WARN',
      `Uses image '${containerImage}'. Production deployments on DOKS should avoid ':latest' and use explicit version tags or git SHAs for immutable deployments.`);
  } else {
    logResult('K8s Manifest', 'deployment.yaml Image Tag Policy', 'PASS', `Uses explicit tag '${containerImage}'`);
  }

  // 3.3 Probe endpoint audit
  const livenessPath = deploymentDoc.spec.template.spec.containers[0].livenessProbe.httpGet.path;
  const readinessPath = deploymentDoc.spec.template.spec.containers[0].readinessProbe.httpGet.path;
  if (livenessPath === '/health' && readinessPath === '/api/router/status') {
    logResult('K8s Manifest', 'Probe Endpoint Alignment', 'PASS',
      `livenessProbe (${livenessPath}) and readinessProbe (${readinessPath}) correctly align with application endpoints.`);
  } else {
    logResult('K8s Manifest', 'Probe Endpoint Alignment', 'FAIL',
      `Mismatch in probe endpoints: liveness=${livenessPath}, readiness=${readinessPath}`);
  }

  // 3.4 Ingress TLS Audit
  if (!ingressDoc.spec.tls || ingressDoc.spec.tls.length === 0) {
    logResult('K8s Manifest', 'ingress.yaml TLS/HTTPS Configuration', 'WARN',
      'ingress.yaml does not specify spec.tls or cert-manager annotations for HTTPS termination.');
  } else {
    logResult('K8s Manifest', 'ingress.yaml TLS/HTTPS Configuration', 'PASS', 'TLS configuration present.');
  }

  // 3.5 Secret placeholder audit
  const secretData = secretDoc.stringData || secretDoc.data;
  const hasPlaceholders = Object.values(secretData).some((val: any) => typeof val === 'string' && val.includes('placeholder'));
  if (hasPlaceholders) {
    logResult('K8s Manifest', 'secret.yaml Placeholder Values', 'WARN',
      'secret.yaml contains template placeholders (e.g. placeholder-webhook-secret). Ensure these are populated via sealed secrets or CI/CD secret injection in actual DOKS environments.');
  }

  // 3.6 Test deploy-doks.sh & verify-doks.sh dry runs
  try {
    const deployOut = execSync(`${path.join(rootDir, 'scripts/deploy-doks.sh')} --dry-run`, { encoding: 'utf-8', cwd: rootDir });
    const verifyOut = execSync(`${path.join(rootDir, 'scripts/verify-doks.sh')} --dry-run`, { encoding: 'utf-8', cwd: rootDir });
    if (deployOut.includes('Dry-run completed successfully.') && verifyOut.includes('Verification completed successfully.')) {
      logResult('DOKS Scripts', 'deploy-doks.sh & verify-doks.sh --dry-run', 'PASS',
        'Both deployment and verification scripts execute cleanly in dry-run mode.');
    } else {
      logResult('DOKS Scripts', 'deploy-doks.sh & verify-doks.sh --dry-run', 'FAIL',
        'Scripts failed dry-run output validation.');
    }
  } catch (err: any) {
    logResult('DOKS Scripts', 'deploy-doks.sh & verify-doks.sh --dry-run', 'FAIL', err.message);
  }
}

async function main() {
  console.log('=== STARTING EMPIRICAL CHALLENGE HARNESS FOR MILESTONE 5 ===\n');
  await runHostBindingTests();
  runContainerStaticTestAudits();
  runKubernetesManifestAudits();

  console.log('\n=== EMPIRICAL CHALLENGE SUMMARY ===');
  const passes = results.filter(r => r.status === 'PASS').length;
  const fails = results.filter(r => r.status === 'FAIL').length;
  const warns = results.filter(r => r.status === 'WARN').length;
  console.log(`Total Checks: ${results.length} | PASS: ${passes} | FAIL: ${fails} | WARN: ${warns}`);

  fs.writeFileSync(
    path.join(__dirname, 'harness_results.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2)
  );
}

main().catch(err => {
  console.error('Fatal error in empirical harness:', err);
  process.exit(1);
});
