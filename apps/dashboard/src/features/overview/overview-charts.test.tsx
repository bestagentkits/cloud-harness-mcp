import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BarTable, StackedBarChart } from './overview-charts';

describe('StackedBarChart', () => {
  const buckets = [{ key: 'b1', label: '10:00', segments: { succeeded: 3, attention: 1, cancelled: 0, running: 0 } }];

  it('names every category in text and carries the numbers as a captioned table', () => {
    const { container } = render(<StackedBarChart buckets={buckets} caption="Execution health" emptyNote="none" />);
    const legend = screen.getByRole('list', { name: 'Legend' });
    for (const label of ['Succeeded', 'Failed / limit', 'Cancelled', 'Running']) expect(within(legend).getByText(label)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Execution health', hidden: true });
    expect(within(table).getByRole('columnheader', { name: 'Failed / limit', hidden: true })).toBeInTheDocument();
    expect(container.querySelector('title')?.textContent).toBe('10:00: Succeeded 3, Failed / limit 1, Cancelled 0, Running 0');
    // Zero segments are not drawn; no inline style anywhere.
    expect(container.querySelectorAll('rect[data-segment]')).toHaveLength(2);
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('explains an empty series instead of drawing an axis', () => {
    const { container } = render(<StackedBarChart buckets={[]} caption="Execution health" emptyNote="No agents are on record yet." />);
    expect(screen.getByText('No agents are on record yet.')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('BarTable', () => {
  it('renders hostile labels as text, with value and note', () => {
    const { container } = render(<BarTable caption="MCP reliability by server" valueLabel="Calls" emptyNote="none" rows={[{ key: 'k', label: '<img src=x onerror=alert(1)>', value: 4, display: '4', note: '1 error(s)' }]} />);
    const table = screen.getByRole('table', { name: 'MCP reliability by server' });
    expect(within(table).getByRole('rowheader')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(within(table).getByText('1 error(s)')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('never divides by zero', () => {
    const { container } = render(<BarTable caption="Flat" valueLabel="Value" emptyNote="none" rows={[{ key: 'a', label: 'a', value: 0, display: '0', note: '' }]} />);
    expect(container.querySelector('rect')?.getAttribute('width')).toBe('0');
  });
});
