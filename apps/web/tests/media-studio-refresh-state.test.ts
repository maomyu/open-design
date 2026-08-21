import { describe, expect, it } from 'vitest';
import { keepMediaStudioListOnLoadFailure } from '../src/components/media-studio/refresh-state.js';

describe('media studio refresh state', () => {
  it('keeps visible topics and articles when the daemon is temporarily unavailable', () => {
    const visible = [{ id: 'existing', title: '不能消失的记录' }];
    expect(keepMediaStudioListOnLoadFailure(visible, null)).toBe(visible);
  });

  it('accepts a successful empty response because it represents real database state', () => {
    const visible = [{ id: 'existing', title: '旧记录' }];
    expect(keepMediaStudioListOnLoadFailure(visible, [])).toEqual([]);
  });

  it('replaces visible state after a successful non-empty refresh', () => {
    const visible = [{ id: 'old', title: '旧记录' }];
    const loaded = [{ id: 'new', title: '新记录' }];
    expect(keepMediaStudioListOnLoadFailure(visible, loaded)).toBe(loaded);
  });
});
