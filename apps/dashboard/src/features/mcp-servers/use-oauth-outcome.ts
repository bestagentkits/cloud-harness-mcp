import { useEffect, useRef } from 'react';
import { toast } from '@/components/ui/toast-store';
import { oauthOutcomeMessage } from './mcp-model';

/**
 * Announces the MCP OAuth callback outcome (`?oauth=&reason=`) once, then clears it from
 * the URL with a replace so a reload or Back does not announce it again. Runs on the list
 * page too: the server redirects there when the flow's server is unknown.
 */
export function useOAuthOutcome(outcome: { oauth?: 'connected' | 'error'; reason?: string }, clear: () => void) {
  const announced = useRef<string | undefined>(undefined);
  const key = outcome.oauth ? `${outcome.oauth}:${outcome.reason ?? ''}` : undefined;
  useEffect(() => {
    if (!key || announced.current === key) return;
    announced.current = key;
    const message = oauthOutcomeMessage(outcome);
    if (message) toast({ title: message.text, variant: message.ok ? 'success' : 'destructive' });
    clear();
  }, [key, outcome, clear]);
}
