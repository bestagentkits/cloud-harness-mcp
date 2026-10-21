import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { defineDeweeChat, type DeweeChatElement } from 'dewee-webchat';
import { useEffect, useRef, useState } from 'react';
import { useCurrentPage } from '@/app/route-identity';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { API_BASE_PATH, apiClient } from '@/lib/api-client';
import { usePageActionsVersion } from '@/lib/page-actions';
import { usePreferences } from '@/lib/preferences';
import { createAssistantController, type PendingRequest } from './assistant-controller';
import { adoptWidgetStyles, createWidgetFetch, DEWEE_ENDPOINT, scrubWidgetSession } from './widget-host-setup';

function createWidgetElement(): DeweeChatElement {
  defineDeweeChat();
  const element = document.createElement('dewee-chat') as DeweeChatElement;
  adoptWidgetStyles(element);
  return element;
}

/**
 * The embedded Dewee assistant (lazy chunk: the widget and zod load only when the owner first
 * opens it). It mounts `<dewee-chat>` against the BFF with the in-memory CSRF header,
 * advertises the page actions for the current route, and renders the confirmation dialog
 * through which every prepared request must pass (`assistant-controller.ts`).
 */
export default function DeweeAssistant({ openSignal }: { openSignal: number }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const current = useCurrentPage();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.search as Record<string, unknown> });
  const registryVersion = usePageActionsVersion();
  const [preferences] = usePreferences();
  const hostRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingRequest | undefined>();
  const [controller] = useState(() => createAssistantController({ queryClient, onPending: setPending }));
  // Created detached so its styles can be lifted before it ever connects.
  const [element] = useState(createWidgetElement);

  // Mount once, then attach.
  useEffect(() => {
    element.configure({
      endpoint: DEWEE_ENDPOINT,
      mode: 'floating',
      title: 'Assistant',
      subtitle: 'Cloud Harness operator',
      placeholder: 'Ask about this page, or what to do next',
      hideBranding: true,
      allowAgentSwitch: false,
      showReasoning: false,
      headers: () => apiClient.csrfHeaders(),
      fetch: createWidgetFetch(),
      getPageContext: () => controller.pageContext(),
      confirm: (action, args) => controller.confirm(action.name, action.callId, args)
    });
    scrubWidgetSession();
    hostRef.current?.append(element);
    window.addEventListener('pagehide', scrubWidgetSession);
    return () => {
      window.removeEventListener('pagehide', scrubWidgetSession);
      controller.dispose();
      element.remove();
      scrubWidgetSession();
    };
  }, [controller, element]);

  // Keep the catalog's view of the page current, and re-advertise on every route change.
  useEffect(() => {
    controller.setDeps({
      current,
      location: { pathname, search },
      queryClient,
      navigate: async ({ to, params, search: nextSearch, replace }) => {
        await router.navigate({ to: to as never, params: (params ?? {}) as never, search: (nextSearch ?? {}) as never, ...(replace ? { replace } : {}) });
      }
    });
    element.configure({ actions: controller.actions() });
  }, [controller, element, current, pathname, search, queryClient, router, registryVersion]);

  useEffect(() => {
    element.configure({ theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light' });
  }, [element, preferences.theme]);

  useEffect(() => {
    if (openSignal > 0) element.toggle();
  }, [element, openSignal]);

  return (
    <>
      <div ref={hostRef} data-testid="dewee-assistant-host" />
      {pending ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) controller.deny(pending); }}
          title={pending.mutation.title}
          description={`${pending.mutation.description} The assistant prepared this request; nothing is sent until you confirm.${pending.mutation.destructive && !/undone/.test(pending.mutation.description) ? ' This cannot be undone.' : ''}`}
          {...(pending.mutation.target ? { target: pending.mutation.target } : {})}
          details={(
            <div className="grid gap-1" data-testid="prepared-request">
              <p className="font-mono text-xs"><span className="font-semibold">{pending.mutation.method}</span> {API_BASE_PATH}{pending.mutation.path}</p>
              <pre className="max-h-48 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs" aria-label="Request body" tabIndex={0}>
                {pending.mutation.body === undefined ? '(no body)' : JSON.stringify(pending.mutation.body, null, 2)}
              </pre>
            </div>
          )}
          confirmLabel={pending.mutation.confirmLabel}
          destructive={pending.mutation.destructive}
          onConfirm={() => controller.approve(pending)}
        />
      ) : null}
    </>
  );
}
