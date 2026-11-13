import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPrivilegedChangeScan,
  scanPrivilegedChanges,
  type PrivilegedChangeScanFile,
} from '../src/privilegedChangeScan.js';

function scan(files: PrivilegedChangeScanFile[], truncated = false) {
  const result = scanPrivilegedChanges(files, { truncated });
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') throw new Error('unreachable');
  return result;
}

describe('privileged change scan', () => {
  it('detects privileged container settings on added manifest lines', () => {
    const result = scan([{
      filename: 'clusters/lab/tailscale.yaml',
      status: 'modified',
      patch: [
        '@@ -1,2 +1,8 @@',
        '-        securityContext: {}',
        '+        securityContext:',
        '+          privileged: true',
        '+          runAsUser: 0',
        '+          hostNetwork: true',
        '+          hostPID: true',
        '+          capabilities:',
        '+            add: ["NET_ADMIN", "SYS_MODULE"]',
      ].join('\n'),
    }]);

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.findings.map((finding) => finding.rule), [
      'privileged-container', 'root-user', 'host-network', 'host-namespace', 'added-capability',
    ]);
    assert.match(formatPrivilegedChangeScan(result), /privileged-change-scan=escalated;rules=/u);
  });

  it('detects hostPath volumes and ignores context-only or removed lines', () => {
    const result = scan([{
      filename: 'clusters/lab/host-path.yaml',
      status: 'modified',
      patch: [
        '         volumes:',
        '-        - hostPath:',
        '-            path: /var/lib/kubelet',
        '+        emptyDir: {}',
        '+        securityContext:',
        '+          privileged: false',
      ].join('\n'),
    }]);

    assert.deepEqual(result.findings, []);
    assert.match(formatPrivilegedChangeScan(result), /^privileged-change-scan=clear\./u);
  });

  it('detects hostPath additions', () => {
    const result = scan([{
      filename: 'clusters/lab/agent.yaml',
      status: 'modified',
      patch: ['+        hostPath:', '+          path: /var/run/docker.sock'].join('\n'),
    }]);

    assert.deepEqual(result.findings.map((finding) => finding.rule), ['host-path']);
  });

  it('detects RBAC kinds and NetworkPolicy removals', () => {
    const result = scan([
      { filename: 'clusters/lab/rbac.yaml', status: 'added', patch: '+kind: ClusterRoleBinding\n+kind: Role' },
      { filename: 'clusters/lab/netpol.yaml', status: 'removed', patch: '-kind: NetworkPolicy\n-metadata:' },
      { filename: 'clusters/lab/network-policies.yaml', status: 'removed', patch: null },
    ]);

    assert.deepEqual(result.findings.map((finding) => `${finding.rule}:${finding.file}`), [
      'rbac-change:clusters/lab/rbac.yaml',
      'rbac-change:clusters/lab/rbac.yaml',
      'network-policy-removal:clusters/lab/netpol.yaml',
      'network-policy-removal:clusters/lab/network-policies.yaml',
    ].filter((value, index, all) => all.indexOf(value) === index));
  });

  it('only classifies manifests and bounds the listed findings', () => {
    const files: PrivilegedChangeScanFile[] = [
      { filename: 'docs/notes.md', status: 'modified', patch: '+privileged: true' },
      { filename: 'backend/main.py', status: 'modified', patch: '+runAsUser: 0' },
      ...Array.from({ length: 40 }, (_, index) => ({
        filename: `clusters/lab/${index}.yaml`,
        status: 'modified',
        patch: '+          privileged: true',
      })),
    ];
    const result = scan(files, true);

    assert.equal(result.status, 'complete');
    assert.equal(result.filesScanned, 40);
    assert.equal(result.truncated, true);
    assert.equal(result.findings.length, 20);
    const formatted = formatPrivilegedChangeScan(result);
    assert.match(formatted, /scan truncated at the file cap/u);
    assert.doesNotMatch(formatted, /docs\/notes\.md/u);
  });

  it('renders an explicit unavailable notice', () => {
    const formatted = formatPrivilegedChangeScan({
      version: 'PrivilegedChangeScan.v1', status: 'unavailable', reason: 'diff_unavailable',
    });
    assert.match(formatted, /privileged-change-scan=unavailable\./u);
    assert.match(formatted, /were not checked/u);
  });
});
