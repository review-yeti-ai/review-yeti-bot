import { completeCurrentVersionLifecycleHistory } from './groundedReviewFixture';

/** Complete, exact-head history and thread receipts for prepared checkpoint tests. */
export function preparedCheckpointHistory(input: {
  policyDigest: string;
  configDigest: string;
  currentHeadSha: string;
  priorHeadSha?: string;
  baseSha: string;
}) {
  const source = completeCurrentVersionLifecycleHistory();

  return {
    prLifecycleHistory: {
      ...source,
      read: async () => {
        const snapshot = await source.read();
        return {
          ...snapshot,
          events: snapshot.events.map((event) => ({
            ...event,
            headSha: input.priorHeadSha ?? input.currentHeadSha,
            baseSha: input.baseSha,
            policyDigest: input.policyDigest,
            configDigest: input.configDigest,
          })),
        };
      },
    },
    findingThreadReader: async (_identity: unknown, currentHeadSha: string) => ({
      source: 'service' as const,
      headSha: currentHeadSha || input.currentHeadSha,
      complete: true,
      omittedCount: 0,
      threads: [],
    }),
  };
}
