import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api-client';
import { SkillImportProgress } from './skill-import-progress';
import type { Skill } from './skill-model';
import { SkillsLibrary } from './skills-library';

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const noop = () => undefined;
const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';

function library(skills: Skill[]) {
  return wrap(
    <SkillsLibrary body={{ data: { skills } }} filters={{}} onFilters={noop} onOpenSkill={noop} onCreate={noop} onDiscover={noop} onConflict={noop} />
  );
}

describe('skills library', () => {
  it('renders the installed-skills table by role and name', () => {
    render(library([{ id: `sk_${'1'.repeat(20)}`, slug: 'deploy', displayName: 'Deploy', provider: 'custom', state: 'enabled' }]));
    const table = screen.getByRole('table', { name: 'Installed skills' });
    expect(within(table).getByRole('button', { name: 'Deploy' })).toBeInTheDocument();
    expect(within(table).getByRole('checkbox', { name: 'Select Deploy' })).toBeInTheDocument();
    expect(screen.getByTestId('skills-library-count')).toHaveTextContent('1 skill');
  });

  it('shows the empty-library state with its remedy', () => {
    render(library([]));
    expect(screen.getByText('No skills yet', { selector: 'p.font-medium' })).toBeInTheDocument();
    expect(screen.getByText(/Import one from Discover/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discover skills' })).toBeInTheDocument();
  });

  it('renders hostile skill names, slugs and descriptions as text', () => {
    delete (window as unknown as { __pwned?: number }).__pwned;
    const { container } = render(library([{ id: `sk_${'2'.repeat(20)}`, slug: HOSTILE, displayName: HOSTILE, description: HOSTILE, provider: HOSTILE, kind: HOSTILE, state: HOSTILE }]));
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(screen.getAllByText(HOSTILE).length).toBeGreaterThan(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('import progress', () => {
  const JOB = `skjob_${'f'.repeat(20)}`;
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('polls while the job is non-terminal and stops on the terminal state', async () => {
    const states = ['queued', 'running', 'succeeded'];
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async () => ({ data: { id: JOB, state: states.shift() ?? 'succeeded', sourceRef: 'o/r' } }) as never);
    render(wrap(<SkillImportProgress jobId={JOB} onRetry={async () => undefined} />));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Import finished'), { timeout: 10_000 });
    const calls = get.mock.calls.filter(([path]) => path === `/skill-imports/${JOB}`).length;
    expect(calls).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(get.mock.calls.filter(([path]) => path === `/skill-imports/${JOB}`).length).toBe(3);
  });

  it('stops polling on unmount', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { id: JOB, state: 'running' } } as never);
    const view = render(wrap(<SkillImportProgress jobId={JOB} onRetry={async () => undefined} />));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('cancels with the generation read from the job', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { id: JOB, state: 'running', generation: 4 } } as never);
    const request = vi.spyOn(apiClient, 'request').mockResolvedValue({ data: { id: JOB, state: 'cancelled' } } as never);
    render(wrap(<SkillImportProgress jobId={JOB} onRetry={async () => undefined} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel import' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/skill-imports/${JOB}/cancel`, { method: 'POST', body: { expectedGeneration: 4 } }));
  });
});
