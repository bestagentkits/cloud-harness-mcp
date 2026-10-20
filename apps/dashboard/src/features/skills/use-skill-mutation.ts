import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { ConflictError } from '@/lib/api-client';
import { type BffMutationOptions, useBffMutation } from '@/lib/bff-mutation';
import { bffKey, bffPath } from '@/lib/bff-query';

/** The library read (the page registry's primary read) and the skill-set list. */
export const SKILLS_KEY: QueryKey = bffKey('/skills');
export const SKILL_SETS_KEY: QueryKey = bffKey('/skill-sets');

/** The reads the detail drawer holds for one skill: the single-skill read, revisions and usage. */
export function skillDetailKeys(skillId: string): QueryKey[] {
  return [bffKey(bffPath('skills', skillId)), bffKey(bffPath('skills', skillId, 'revisions')), bffKey(bffPath('skills', skillId, 'usage'))];
}

/**
 * A generation-fenced skills write. A 409 means the record moved since the page read it: the
 * affected reads refetch at once, so the operator sees the current generation before trying
 * again, and `onConflict` raises the page's "This changed elsewhere" notice. The request is
 * never retried; `useBffMutation`'s toast still reports the failure.
 */
export function useSkillMutation<TVariables, TResult>(options: BffMutationOptions<TVariables, TResult> & {
  refresh: QueryKey[];
  onConflict?: ((error: ConflictError) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const { refresh, onConflict, mutationFn, ...rest } = options;
  return useBffMutation<TVariables, TResult>({
    ...rest,
    mutationFn: async (variables) => {
      try {
        return await mutationFn(variables);
      } catch (error) {
        if (error instanceof ConflictError) {
          onConflict?.(error);
          await Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        }
        throw error;
      }
    }
  });
}
