import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { bffPrefix } from '@/lib/bff-mutation';
import { refetchGitHubReads } from './github-model';

describe('refetchGitHubReads', () => {
  it('never lets a read that was pending before a connection change become the shown answer', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = [...bffPrefix('/github/repositories'), {}];
    let fetches = 0;
    // The dashboard's TypeScript lib predates Promise.withResolvers, so the gate is built by hand.
    let releaseOld!: () => void;
    const old = { promise: new Promise<void>((resolve) => { releaseOld = resolve; }), resolve: () => releaseOld() };
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => {
        fetches += 1;
        // The first read was sent before the change and answers late, with the previous connection's rows.
        if (fetches === 1) {
          await old.promise;
          return { data: { repositories: ['old/repository'] } };
        }
        return { data: { repositories: [] } };
      }
    });
    // A mounted page: the observer starts the first read.
    const unsubscribe = observer.subscribe(() => undefined);
    await Promise.resolve();
    expect(fetches).toBe(1);

    const refetched = refetchGitHubReads(queryClient, ['/github/repositories']);
    old.resolve();
    await refetched;

    expect(fetches).toBe(2);
    expect(queryClient.getQueryData(key)).toEqual({ data: { repositories: [] } });
    unsubscribe();
  });
});
