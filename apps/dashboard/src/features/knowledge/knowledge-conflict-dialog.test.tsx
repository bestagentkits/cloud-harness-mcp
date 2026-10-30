import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeConflictDialog } from './knowledge-conflict-dialog';

function setup(server = { generation: 4, content: 'server text' }) {
  const onLoadServer = vi.fn();
  const onOpenChange = vi.fn();
  render(<KnowledgeConflictDialog open onOpenChange={onOpenChange} base={{ generation: 3, content: 'base text' }} server={server} serverError={false} draft="my <b>draft</b>" onLoadServer={onLoadServer} />);
  return { onLoadServer, onOpenChange };
}

describe('knowledge conflict dialog', () => {
  it('shows base, server and draft versions as text', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'This entry changed elsewhere' });
    expect(screen.getByRole('heading', { name: 'Base version (generation 3)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Current on server (generation 4)' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('server text');
    expect(dialog).toHaveTextContent('my <b>draft</b>');
    expect(dialog.querySelector('b')).toBeNull();
  });

  it('loads the server version only after a second confirmation (R10)', async () => {
    const user = userEvent.setup();
    const { onLoadServer } = setup();
    await user.click(screen.getByRole('button', { name: 'Load server version' }));
    expect(onLoadServer).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog', { name: /Discard your draft/ });
    expect(confirm).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onLoadServer).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Load server version' }));
    await user.click(screen.getByRole('button', { name: 'Discard draft and load' }));
    expect(onLoadServer).toHaveBeenCalledWith({ generation: 4, content: 'server text' });
  });

  it('keeps the draft on close and cannot load before the server version arrives', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<KnowledgeConflictDialog open onOpenChange={onOpenChange} base={{ generation: 3, content: undefined }} server={undefined} serverError={false} draft="d" onLoadServer={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Load server version' })).toBeDisabled();
    expect(screen.getByText('Loading the server version…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep my draft' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
