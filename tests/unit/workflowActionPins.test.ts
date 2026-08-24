import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const workflowDirectory = path.join(process.cwd(), '.github/workflows');

const requiredPins = new Map([
  ['actions/checkout', '93cb6efe18208431cddfb8368fd83d5badbf9bfd'],
  ['actions/setup-node', 'a0853c24544627f65ddf259abe73b1d18a591444'],
  ['actions/cache', 'caa296126883cff596d87d8935842f9db880ef25'],
  ['actions/upload-artifact', 'b7c566a772e6b6bfb58ed0dc250532a479d7789f'],
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
        /uses:\s*['"]?(actions\/(?:checkout|setup-node|cache|upload-artifact))@([^'"\s#]+)/gu,
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
