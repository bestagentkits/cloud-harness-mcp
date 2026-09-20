import { HarnessError } from '@cloud-harness/contracts';

/**
 * One hit from a remote registry search. `reference` is what an importer accepts, which is not always
 * the display name: skills.sh needs the full owner/repo/skill path while SkillX uses a slug.
 */
export type RegistrySearchHit = {
  provider: 'skills-sh' | 'skillx';
  reference: string;
  name: string;
  description?: string;
  installs?: number;
};

/**
 * A remote search is an advisory lookup behind a dashboard request, so it gets a shorter bound than an
 * import: a slow provider must degrade into a reported warning rather than hold the caller's request
 * open, because the local results are still useful on their own.
 */
export const REGISTRY_SEARCH_TIMEOUT_MS = 8_000;

/** The two providers return different envelopes, so only transport and failure mapping live here. */
export async function fetchRegistrySearch(
  url: string,
  fetcher: typeof fetch,
  options: { signal?: AbortSignal | undefined } = {}
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTRY_SEARCH_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await fetcher(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) {
      throw new HarnessError('UNAVAILABLE', `registry search failed with status ${response.status}`, 503, true);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new HarnessError('TIMEOUT', `registry search timed out after ${REGISTRY_SEARCH_TIMEOUT_MS}ms`, 504, true);
    }
    if (options.signal?.aborted) {
      throw new HarnessError('CANCELLED', 'registry search was cancelled', 499, false);
    }
    throw new HarnessError('UNAVAILABLE', `registry search failed: ${error instanceof Error ? error.message : String(error)}`, 503, true);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
