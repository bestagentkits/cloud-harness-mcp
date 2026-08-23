export const MAILBOX_PROBE_RESOURCE_URI = 'ui://cloud-harness/mailbox-probe.html';
export const MCP_APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export function mailboxProbeWidgetHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cloud Harness Mailbox Probe</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 16px; background: Canvas; color: CanvasText; }
    main { display: grid; gap: 12px; }
    code { overflow-wrap: anywhere; }
    .status { padding: 10px 12px; border: 1px solid color-mix(in oklab, CanvasText 20%, transparent); border-radius: 10px; }
  </style>
</head>
<body>
  <main>
    <strong>Cloud Harness mailbox capability probe</strong>
    <div id="status" class="status">booting</div>
    <code id="request"></code>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const requestEl = document.getElementById('request');
    const log = (message) => { statusEl.textContent = message; };
    const openai = window.openai;
    const metadata = openai?.toolResponseMetadata?.mcp_tool_result?._meta
      ?? openai?.toolResponseMetadata?.call_tool_result?._meta
      ?? openai?.toolResponseMetadata?._meta
      ?? {};
    const sessionId = metadata.mailboxProbeSessionId;
    const capability = metadata.mailboxProbeCapability;
    const dispatchedRequestIds = new Set(Array.isArray(openai?.widgetState?.dispatchedRequestIds) ? openai.widgetState.dispatchedRequestIds : []);
    let displayModeRequested = false;

    async function receiveOnce() {
      if (!openai?.callTool) throw new Error('ChatGPT bridge missing callTool');
      const result = await openai.callTool('mailbox_probe_receive', { sessionId, capability, waitMs: 20000 });
      const payload = result?.structuredContent ?? {};
      if (!payload.received) return false;
      requestEl.textContent = JSON.stringify(payload.request, null, 2);
      if (!dispatchedRequestIds.has(payload.request.id)) {
        dispatchedRequestIds.add(payload.request.id);
        openai.setWidgetState?.({ dispatchedRequestIds: Array.from(dispatchedRequestIds) });
        if (!displayModeRequested) {
          displayModeRequested = true;
          await openai.requestDisplayMode?.({ mode: 'picture-in-picture' });
        }
        if (!openai.sendFollowUpMessage) throw new Error('ChatGPT bridge missing sendFollowUpMessage');
        await openai.sendFollowUpMessage({ prompt: payload.request.prompt + '\\n\\nUse requestId ' + payload.request.id + ' in the required agent_probe_submit call. Do not include or ask for any widget capability.', scrollToBottom: false });
        log('follow-up sent for ' + payload.request.id + '; waiting for strict submit');
      } else {
        log('request already dispatched; waiting for strict submit');
      }
      return true;
    }

    async function loop() {
      if (!sessionId || !capability) throw new Error('missing widget-private probe capability');
      log('polling');
      for (;;) {
        await receiveOnce();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    loop().catch((error) => {
      log(error instanceof Error ? error.message : String(error));
    });
  </script>
</body>
</html>`;
}
