import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api-client';
import type { CockpitTabProps } from '../cockpit-tab-registry';
import FilesTab from './files-tab';

// The router `Link` needs a router; a plain anchor is enough for the open-file view.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className} href="#files">{children}</a>,
  useNavigate: () => () => Promise.resolve()
}));

const SHA = 'a'.repeat(64);
const WORKSPACE = 'ws_files';
const CONTENT_PATH = `/workspaces/${WORKSPACE}/files/content`;

function renderFile(read: Record<string, unknown>) {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { path: 'big.txt', content: 'head of the file', sha256: SHA, ...read } } as never);
  const request = vi.spyOn(apiClient, 'request').mockResolvedValue({ data: { path: 'big.txt', sha256: 'b'.repeat(64) } } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const props = { workspaceId: WORKSPACE, search: { file: 'big.txt' }, onSearch: () => undefined } as unknown as CockpitTabProps;
  render(<QueryClientProvider client={client}><FilesTab {...props} /></QueryClientProvider>);
  return request;
}

const writes = (request: ReturnType<typeof renderFile>, method: string) => request.mock.calls.filter(([, options]) => options?.method === method);

describe('Files tab open file', () => {
  it('makes a partial read read-only with no whole-file save, while the text patch still works', async () => {
    const request = renderFile({ bytesReturned: 65_536, totalBytes: 200_000, eof: false });
    const editor = await screen.findByLabelText('File content (read-only, partial)');
    expect(editor).toHaveAttribute('readonly');
    expect(screen.getByRole('status')).toHaveTextContent('Showing the first 64 KB of 195 KB.');
    expect(screen.queryByRole('button', { name: 'Save file' })).toBeNull();

    // A submit that bypasses the missing button is refused too: nothing is written.
    const form = editor.closest('form');
    if (!form) throw new Error('expected the editor form');
    fireEvent.submit(form);
    expect(writes(request, 'PUT')).toEqual([]);

    fireEvent.change(screen.getByLabelText('Text to replace'), { target: { value: 'head' } });
    fireEvent.change(screen.getByLabelText('Replacement text'), { target: { value: 'top' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply text patch' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(CONTENT_PATH, {
      method: 'PATCH', body: { path: 'big.txt', oldText: 'head', newText: 'top', expectedSha256: SHA }
    }));
    expect(screen.getByRole('button', { name: 'Delete file' })).toBeEnabled();
  });

  it('treats a read without eof as partial', async () => {
    renderFile({});
    expect(await screen.findByLabelText('File content (read-only, partial)')).toHaveAttribute('readonly');
    expect(screen.getByRole('status')).toHaveTextContent('The runner did not confirm this is the whole file.');
    expect(screen.queryByRole('button', { name: 'Save file' })).toBeNull();
  });

  it('makes a binary read read-only with no save, while patch and delete stay available', async () => {
    const request = renderFile({ bytesReturned: 16, totalBytes: 16, eof: true, binary: true });
    const editor = await screen.findByLabelText('File content (read-only, binary)');
    expect(editor).toHaveAttribute('readonly');
    expect(screen.getByRole('status')).toHaveTextContent('This file is binary or not valid UTF-8 text');
    expect(screen.queryByRole('button', { name: 'Save file' })).toBeNull();

    const form = editor.closest('form');
    if (!form) throw new Error('expected the editor form');
    fireEvent.submit(form);
    expect(writes(request, 'PUT')).toEqual([]);

    expect(screen.getByRole('button', { name: 'Apply text patch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete file' })).toBeEnabled();
  });

  it('saves a whole-file read against the version it opened', async () => {
    const request = renderFile({ bytesReturned: 16, totalBytes: 16, eof: true });
    const editor = await screen.findByLabelText('File content');
    expect(editor).not.toHaveAttribute('readonly');
    fireEvent.change(editor, { target: { value: 'new content' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(CONTENT_PATH, {
      method: 'PUT', body: { path: 'big.txt', content: 'new content', expectedSha256: SHA }
    }));
  });
});
