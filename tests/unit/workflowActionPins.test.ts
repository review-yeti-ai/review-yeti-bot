import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const workflowDirectory = path.join(process.cwd(), '.github/workflows');

const requiredPins = new Map([
  ['actions/checkout', '93cb6efe18208431cddfb8368fd83d5badbf9bfd'],
  ['actions/setup-node', 'a0853c24544627f65ddf259abe73b1d18a591444'],
  ['actions/cache', 'caa296126883cff596d87d8935842f9db880ef25'],
  ['actions/upload-artifact', 'b7c566a772e6b6bfb58ed0dc250532a479d7789f'],
  ['docker/setup-buildx-action', '37fe631027851001ddb9b187196cc803df7f5f0e'],
  ['docker/build-push-action', '53b7df96c91f9c12dcc8a07bcb9ccacbed38856a'],
  ['docker/login-action', 'c94ce9fb468520275223c153574b00df6fe4bcc9'],
  ['digitalocean/action-doctl', '3cb3953159719656269e044e0e24ca16dd2a690f'],
  ['googleapis/release-please-action', '45996ed1f6d02564a971a2fa1b5860e934307cf7'],
]);

describe('workflow action runtime pins', () => {
  it('uses immutable Node 24 releases for the first-party JavaScript actions', () => {
    const workflowFiles = fs
      .readdirSync(workflowDirectory)
      .filter((file) => /\.ya?ml$/u.test(file));
    const observedActions = new Set<string>();

    for (const workflowFile of workflowFiles) {
      const workflow = fs.readFileSync(path.join(workflowDirectory, workflowFile), 'utf8');
      const references = workflow.matchAll(
        /uses:\s*['"]?((?:actions\/(?:checkout|setup-node|cache|upload-artifact)|docker\/(?:setup-buildx-action|build-push-action|login-action)|digitalocean\/action-doctl|googleapis\/release-please-action))@([^'"\s#]+)/gu,
      );

      for (const [, action, reference] of references) {
        observedActions.add(action);
        expect(reference, `${workflowFile}: ${action} must use its reviewed immutable pin`).toBe(
          requiredPins.get(action),
        );
      }
    }

    expect(observedActions).toEqual(new Set(requiredPins.keys()));
  });
});
