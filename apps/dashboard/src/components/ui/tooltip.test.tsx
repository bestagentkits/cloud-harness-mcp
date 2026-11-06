import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
import { tooltipStore } from './tooltip-store';

function Tips() {
  return (
    <TooltipProvider delayDuration={50}>
      <Tooltip>
        <TooltipTrigger asChild><button type="button">Collapse</button></TooltipTrigger>
        <TooltipContent side="right">Collapse sidebar</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild><button type="button">Theme</button></TooltipTrigger>
        <TooltipContent>Dark theme</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

afterEach(() => { act(() => tooltipStore.close()); });

describe('Tooltip', () => {
  it('opens on keyboard focus, describes its trigger, and closes on Escape without remounting the trigger', async () => {
    const user = userEvent.setup();
    render(<Tips />);
    const trigger = screen.getByRole('button', { name: 'Collapse' });
    await user.tab();
    expect(trigger).toHaveFocus();
    const tip = await screen.findByText('Collapse sidebar');
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
    // The lazily loaded layer never replaces the trigger element or moves focus.
    expect(screen.getByRole('button', { name: 'Collapse' })).toBe(trigger);
    expect(trigger).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Collapse sidebar')).toBeNull());
    expect(trigger).not.toHaveAttribute('aria-describedby');
    expect(trigger).toHaveFocus();
  });

  it('waits for the hover delay, then moves straight to the next trigger', async () => {
    // Let the previous test's close fall outside the skip-delay window.
    await new Promise((resolve) => setTimeout(resolve, 350));
    render(<Tips />);
    const collapse = screen.getByRole('button', { name: 'Collapse' });
    fireEvent.pointerEnter(collapse, { pointerType: 'mouse' });
    expect(screen.queryByText('Collapse sidebar')).toBeNull();
    expect(await screen.findByText('Collapse sidebar')).toBeInTheDocument();
    fireEvent.pointerLeave(collapse, { pointerType: 'mouse' });
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Theme' }), { pointerType: 'mouse' });
    expect(await screen.findByText('Dark theme')).toBeInTheDocument();
    expect(screen.queryByText('Collapse sidebar')).toBeNull();
  });

  it('does not open for a pointer press or touch, and closes on blur', async () => {
    render(<Tips />);
    const trigger = screen.getByRole('button', { name: 'Collapse' });
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' });
    fireEvent.pointerDown(trigger, { pointerType: 'touch' });
    fireEvent.focus(trigger);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tooltipStore.current()).toBeNull();
    fireEvent.pointerUp(document);
    fireEvent.blur(trigger);
    fireEvent.focus(trigger);
    expect(await screen.findByText('Collapse sidebar')).toBeInTheDocument();
    fireEvent.blur(trigger);
    await waitFor(() => expect(screen.queryByText('Collapse sidebar')).toBeNull());
  });
});
