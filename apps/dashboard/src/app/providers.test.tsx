import { QueryClient } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { toast } from '@/components/ui/toast-store';
import { AppProviders } from './providers';

describe('AppProviders', () => {
  it('loads the toast view with the first toast and keeps it for the next', async () => {
    render(<AppProviders queryClient={new QueryClient()}><p>page</p></AppProviders>);
    expect(screen.queryByRole('region', { name: /notifications/i })).toBeNull();
    act(() => { toast({ title: 'Theme not saved' }); });
    expect(await screen.findByText('Theme not saved')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /notifications/i })).toBeInTheDocument();
  });
});
