import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActivityEventRow } from './activity-event-row';

describe('ActivityEventRow', () => {
  it('renders a hostile payload as text and renders no link for an unknown href', () => {
    const { container } = render(
      <ul>
        <ActivityEventRow event={{ at: 'not a date', category: 'agents', status: '<b>running</b>', actor: '<script>alert(1)</script>', summary: '<img src=x onerror=alert(1)>', href: 'javascript:alert(1)', durable: false }} />
      </ul>
    );
    expect(container.querySelector('script, img, b')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText('Time not reported')).toBeInTheDocument();
    expect(screen.getByTestId('activity-durability')).toHaveTextContent('Live runtime');
  });

  it('labels a durable row as retained audit, in words', () => {
    render(<ul><ActivityEventRow event={{ at: '2026-10-20T00:00:00.000Z', category: 'audit', status: 'recorded', summary: 'workspace_open', durable: true }} /></ul>);
    expect(screen.getByTestId('activity-durability')).toHaveTextContent('Retained audit');
    expect(screen.getByText('Not reported')).toBeInTheDocument();
    expect(document.querySelector('time')).toHaveAttribute('dateTime', '2026-10-20T00:00:00.000Z');
  });
});
