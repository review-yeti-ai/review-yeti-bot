import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), 'src/review/conditionalLanes.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const {
  MAX_ADVISORIES_PER_LANE,
  MAX_LANES,
  demoteToAdvisories,
  matchConditionalLanes,
  resolveConditionalLanes,
} = require(path.join(rootRepoDir, 'src/review/conditionalLanes.js'));

describe('resolveConditionalLanes', () => {
  it('parses a valid configuration', () => {
    const { lanes, problems } = resolveConditionalLanes('[{"persona":"licensing","paths":["release/**","**/cli.sh"]}]');
    expect(problems).toEqual([]);
    expect(lanes).toEqual([{ persona: 'licensing', paths: ['release/**', '**/cli.sh'] }]);
  });

  it('rejects malformed JSON, non-arrays, bad persona ids, and pathless lanes', () => {
    expect(resolveConditionalLanes('not json').problems[0]).toContain('invalid');
    expect(resolveConditionalLanes('{"persona":"x"}').problems[0]).toContain('array');
    expect(resolveConditionalLanes('[{"persona":"BAD ID!","paths":["a"]}]').problems[0]).toContain('identifier');
    expect(resolveConditionalLanes('[{"persona":"licensing","paths":[]}]').problems[0]).toContain('no path patterns');
    expect(resolveConditionalLanes('').lanes).toEqual([]);
    expect(resolveConditionalLanes(undefined).lanes).toEqual([]);
  });

  it('caps the lane count', () => {
    const raw = JSON.stringify(Array.from({ length: 10 }, (_, index) => ({ persona: `lane${index}`, paths: ['a/**'] })));
    expect(resolveConditionalLanes(raw).lanes).toHaveLength(MAX_LANES);
  });
});

describe('matchConditionalLanes', () => {
  const lanes = [
    { persona: 'licensing', paths: ['release/**', '**/cli.sh'] },
    { persona: 'database', paths: ['priv/repo/**'] },
  ];

  it('returns only lanes whose paths intersect the diff, with matched paths', () => {
    const triggered = matchConditionalLanes(lanes, ['release/ova/build.sh', 'lib/app.ex']);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].persona).toBe('licensing');
    expect(triggered[0].matchedPaths).toEqual(['release/ova/build.sh']);
  });

  it('matches nested glob patterns and returns nothing on a clean diff', () => {
    expect(matchConditionalLanes(lanes, ['scripts/cli.sh'])[0]?.persona).toBe('licensing');
    expect(matchConditionalLanes(lanes, ['lib/app.ex'])).toHaveLength(0);
    expect(matchConditionalLanes(lanes, [])).toHaveLength(0);
  });
});

describe('demoteToAdvisories', () => {
  it('demotes every finding to an annotated P2 preserving the assessed severity', () => {
    const advisories = demoteToAdvisories('licensing', [
      { severity: 'P0', path: 'release/cli.sh', line: 3, side: 'RIGHT', title: 'Key leak', body: 'A key is echoed.' },
      { severity: 'P2', path: 'release/cli.sh', line: 9, side: 'RIGHT', title: 'Nit', body: 'Minor.' },
    ]);
    expect(advisories).toHaveLength(2);
    expect(advisories.every((advisory: any) => advisory.severity === 'P2')).toBe(true);
    expect(advisories[0].body).toContain('lane assessed P0');
    expect(advisories[0].body).toContain('does not affect the verdict');
    expect(advisories[1].body).not.toContain('lane assessed');
    expect(advisories[0].conditionalLane).toBe('licensing');
  });

  it('caps advisories per lane and tolerates malformed input', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ severity: 'P1', path: `f${index}`, title: 't', body: 'b' }));
    expect(demoteToAdvisories('licensing', many)).toHaveLength(MAX_ADVISORIES_PER_LANE);
    expect(demoteToAdvisories('licensing', null)).toEqual([]);
  });
});
