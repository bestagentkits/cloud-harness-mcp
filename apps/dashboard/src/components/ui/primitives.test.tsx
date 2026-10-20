import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ActionButton } from './button';
import { Combobox } from './combobox';
import { ConfirmDialog } from './confirm-dialog';
import { type DialogGuard, ManagedDialog } from './managed-dialog';
import { DialogTitle } from './dialog';
import { Progress } from './progress';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('ActionButton', () => {
  it('runs the action once however fast it is clicked, and shows pending then success', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const action = vi.fn(() => pending.promise);
    render(<ActionButton onAction={action} pendingLabel="Saving…" successLabel="Saved">Save</ActionButton>);
    const button = screen.getByRole('button', { name: 'Save' });
    await user.dblClick(button);
    await user.click(button);
    expect(action).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Saving…');
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(button).toHaveAttribute('data-state', 'success');
    expect(button).toHaveTextContent('Saved');
  });

  it('shows the error state and accepts a new attempt afterwards', async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(undefined);
    render(<ActionButton onAction={action} errorLabel="Failed">Run</ActionButton>);
    await user.click(screen.getByRole('button'));
    expect(await screen.findByRole('button', { name: 'Failed' })).toHaveAttribute('data-state', 'error');
    await user.click(screen.getByRole('button'));
    expect(action).toHaveBeenCalledTimes(2);
  });
});

function GuardedDialog({ guard, onClose }: { guard: DialogGuard; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Invoker</button>
      <ManagedDialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) onClose(); }} guard={guard}>
        <DialogTitle>Guarded</DialogTitle>
        <button type="button" onClick={() => { setOpen(false); onClose(); }}>I have saved it</button>
      </ManagedDialog>
    </>
  );
}

describe('ManagedDialog', () => {
  it('dismisses on Escape and restores focus to the invoker', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<GuardedDialog guard={{}} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Invoker' }));
    expect(screen.getByRole('dialog', { name: 'Guarded' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Invoker' })).toHaveFocus());
  });

  it('asks before discarding a dirty form', async () => {
    const user = userEvent.setup();
    render(<GuardedDialog guard={{ dirty: true }} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Invoker' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Guarded' })).toBeInTheDocument();
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('dialog', { name: 'Guarded' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([['locked', { locked: true }], ['reveal', { reveal: true }]] as const)('refuses Escape and the close button when %s', async (_label, guard) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<GuardedDialog guard={guard} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Invoker' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Guarded' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

function Confirming({ onConfirm, onError }: { onConfirm: () => Promise<unknown>; onError?: (error: unknown) => void }) {
  const [open, setOpen] = useState(true);
  return <ConfirmDialog open={open} onOpenChange={setOpen} title="Delete key?" description="It stops working at once." target="chk_1" confirmLabel="Delete" pendingLabel="Deleting…" onConfirm={onConfirm} {...(onError ? { onError } : {})} />;
}

describe('ConfirmDialog', () => {
  it('focuses Cancel first and cancels on Escape', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<Confirming onConfirm={onConfirm} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('locks while the action runs, then closes', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    render(<Confirming onConfirm={() => pending.promise} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: 'Delete key?' })).toBeInTheDocument();
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('closes on failure and hands the error to the page', async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    render(<Confirming onConfirm={async () => { throw new Error('denied'); }} onError={onError} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('Combobox', () => {
  it('filters, moves with the arrow keys and chooses with Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Combobox label="Pages" items={[{ value: 'a', label: 'Agents' }, { value: 'b', label: 'Activity' }, { value: 'c', label: 'Secrets' }]} onSelect={onSelect} />);
    const input = screen.getByRole('combobox', { name: 'Pages' });
    await user.type(input, 'a');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]?.id);
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: 'b' }));
  });
});

describe('Progress', () => {
  it('is determinate only when a value is known', () => {
    const { rerender } = render(<Progress label="Upload" value={40} />);
    expect(screen.getByRole('progressbar', { name: 'Upload' })).toHaveAttribute('aria-valuenow', '40');
    rerender(<Progress label="Upload" />);
    expect(screen.getByRole('progressbar', { name: 'Upload' })).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByRole('progressbar', { name: 'Upload' })).toHaveAttribute('data-indeterminate');
  });
});
