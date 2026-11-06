import { beforeEach, describe, expect, it } from 'vitest';
import { readRecentWorkspaces, RECENT_WORKSPACES_KEY, rememberWorkspace } from './recent-workspaces';

const id = (n: number) => `ws_${String(n).padStart(24, 'a')}`;

describe('recent workspaces', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the five most recent ids, newest first, without duplicates', () => {
    for (let n = 1; n <= 7; n += 1) rememberWorkspace(id(n));
    rememberWorkspace(id(5));
    expect(readRecentWorkspaces()).toEqual([id(5), id(7), id(6), id(4), id(3)]);
  });

  it('ignores invalid ids and tampered storage', () => {
    rememberWorkspace('not-a-workspace');
    expect(localStorage.getItem(RECENT_WORKSPACES_KEY)).toBeNull();
    localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify([id(1), 'https://example.com/repo.git', 42]));
    expect(readRecentWorkspaces()).toEqual([id(1)]);
    localStorage.setItem(RECENT_WORKSPACES_KEY, '{broken');
    expect(readRecentWorkspaces()).toEqual([]);
  });
});
