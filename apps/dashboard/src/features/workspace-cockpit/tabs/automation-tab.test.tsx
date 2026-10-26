import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from '@/lib/api-client';
import type { CockpitTabProps } from '../cockpit-tab-registry';
import AutomationTab from './automation-tab';

const CONTENT_SHA = 'c'.repeat(64);
const MANIFEST_SHA = 'd'.repeat(64);
const WORKSPACE = 'ws_automation';

function renderTab(run: () => Promise<unknown>) {
  vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => (path.endsWith('/skills')
    ? { data: { skills: [{ name: 'lint', contentSha256: CONTENT_SHA }] } }
    : { data: { hooks: [{ name: 'format', events: ['manual'], active: false }], manifestSha256: MANIFEST_SHA } }) as never);
  const request = vi.spyOn(apiClient, 'request').mockImplementation(run as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const props = { workspaceId: WORKSPACE, search: {}, onSearch: () => undefined } as unknown as CockpitTabProps;
  render(<QueryClientProvider client={client}><AutomationTab {...props} /></QueryClientProvider>);
  return request;
}

// jsdom's name computation drops the space that opens each button's screen-reader suffix.
async function runScript(script: string) {
  fireEvent.click(await screen.findByRole('button', { name: /^Run script\s*of lint$/ }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Script'), { target: { value: script } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Run script' }));
}

describe('Automation tab', () => {
  it('runs a skill script fenced by the content digest the list reports', async () => {
    const request = renderTab(async () => ({ data: { exitCode: 0, executionMode: 'helper-container', output: 'clean' } }));
    await runScript('check.sh');
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/workspaces/${WORKSPACE}/skills/lint/run`, {
      method: 'POST', body: { script: 'check.sh', expectedContentSha256: CONTENT_SHA }
    }));
    const result = await screen.findByRole('region', { name: 'lint · check.sh' });
    expect(within(result).getByText('Disposable helper container')).toBeInTheDocument();
    expect(within(result).getByText('clean')).toBeInTheDocument();
    expect(within(result).queryByText('Exited with an error')).toBeNull();
  });

  it('shows the exit code, where it ran, the stopping signal and output of a script that failed', async () => {
    renderTab(async () => {
      throw new ApiError(422, 'The skill script exited with an error.', 'execution_failed', { exitCode: 124, executionMode: 'helper-container', signal: 'SIGTERM', output: 'timed out' });
    });
    await runScript('slow.sh');
    const result = await screen.findByRole('region', { name: 'lint · slow.sh' });
    expect(within(result).getByText('Exited with an error')).toBeInTheDocument();
    expect(within(result).getByText('124')).toBeInTheDocument();
    expect(within(result).getByText('Disposable helper container')).toBeInTheDocument();
    expect(within(result).getByText('SIGTERM')).toBeInTheDocument();
    expect(within(result).getByText('timed out')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps any other refusal in the dialog', async () => {
    renderTab(async () => { throw new ApiError(400, 'The script name is not valid.', 'invalid_input'); });
    await runScript('nope.sh');
    expect(await screen.findByText('The script name is not valid.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers a one-off manual run of an inactive hook', async () => {
    const request = renderTab(async () => ({ data: { exitCode: 0, output: '' } }));
    const button = await screen.findByRole('button', { name: /^Run hook\s*format at Manual$/ });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/This hook is not active: this is a one-off run/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run hook' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/workspaces/${WORKSPACE}/hooks/run`, {
      method: 'POST', body: { name: 'format', event: 'manual', expectedManifestSha256: MANIFEST_SHA }
    }));
  });
});
