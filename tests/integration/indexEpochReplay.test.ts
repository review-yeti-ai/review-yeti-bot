import { describe, expect, it } from 'vitest';
import { RepositoryIndex } from '../../src/indexer/repositoryIndex';
import { ContextRetriever } from '../../src/indexer/contextRetriever';

describe('repository index replay', () => {
  it('keeps old epochs immutable when a later commit is indexed', () => {
    const index = new RepositoryIndex();
    const first = index.build({ owner: 'o', repo: 'r', commitSha: 'a'.repeat(40), files: [{ path: 'src/a.ts', content: 'export function oldName() {}' }] });
    const second = index.build({ owner: 'o', repo: 'r', commitSha: 'b'.repeat(40), files: [{ path: 'src/a.ts', content: 'export function newName() {}' }] });
    expect(second.epoch).toBe(first.epoch + 1);
    expect(new ContextRetriever(index).retrieve({ owner: 'o', repo: 'r', commitSha: first.commitSha, indexEpoch: first.epoch, text: 'oldName' })[0].reason).toContain('oldName');
    expect(new ContextRetriever(index).retrieve({ owner: 'o', repo: 'r', commitSha: second.commitSha, indexEpoch: second.epoch, text: 'newName' })[0].reason).toContain('newName');
  });

  it('bounds retained epochs while keeping epoch numbers monotonic', () => {
    const index = new RepositoryIndex(undefined, { maxEpochsPerRepository: 2 });
    const first = index.build({ owner: 'o', repo: 'bounded', commitSha: 'a'.repeat(40), files: [{ path: 'src/a.ts', content: 'export function one() {}' }] });
    const second = index.build({ owner: 'o', repo: 'bounded', commitSha: 'b'.repeat(40), files: [{ path: 'src/a.ts', content: 'export function two() {}' }] });
    const third = index.build({ owner: 'o', repo: 'bounded', commitSha: 'c'.repeat(40), files: [{ path: 'src/a.ts', content: 'export function three() {}' }] });

    expect(second.epoch).toBe(first.epoch + 1);
    expect(third.epoch).toBe(second.epoch + 1);
    expect(index.get('o', 'bounded', first.epoch)).toBeNull();
    expect(index.get('o', 'bounded', second.epoch)?.commitSha).toBe(second.commitSha);
    expect(index.get('o', 'bounded', third.epoch)?.commitSha).toBe(third.commitSha);
  });
});
