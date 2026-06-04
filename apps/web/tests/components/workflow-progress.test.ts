import { describe, expect, it } from 'vitest';
import { deriveWorkflowProgress } from '../../src/components/workflow/deriveProgress';
import type { TodoItem } from '../../src/runtime/todos';

const STAGES = [
  { id: 'topic', title: '热点选题' },
  { id: 'copy', title: '文案脚本' },
  { id: 'video', title: '视频生成' },
  { id: 'review', title: '成片复盘' },
];

function todo(content: string, status: TodoItem['status']): TodoItem {
  return { content, status };
}

describe('deriveWorkflowProgress', () => {
  it('returns all pending when there are no todos', () => {
    expect(deriveWorkflowProgress(STAGES, [])).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('maps todo status to stage status by title match', () => {
    const todos = [
      todo('热点选题', 'completed'),
      todo('文案脚本', 'in_progress'),
      todo('视频生成', 'pending'),
      todo('成片复盘', 'pending'),
    ];
    expect(deriveWorkflowProgress(STAGES, todos)).toEqual(['done', 'active', 'pending', 'pending']);
  });

  it('matches when todo content embeds the stage title', () => {
    const todos = [
      todo('热点选题：找 5 个潜力选题', 'completed'),
      todo('写文案脚本（强钩子）', 'in_progress'),
    ];
    const out = deriveWorkflowProgress(STAGES, todos);
    expect(out[0]).toBe('done');
    expect(out[1]).toBe('active');
  });

  it('falls back to positional alignment when wording does not match but counts line up', () => {
    const todos = [
      todo('Step one', 'completed'),
      todo('Step two', 'completed'),
      todo('Step three', 'in_progress'),
      todo('Step four', 'pending'),
    ];
    expect(deriveWorkflowProgress(STAGES, todos)).toEqual(['done', 'done', 'active', 'pending']);
  });

  it('marks the first pending after the last done as active when nothing is explicitly in_progress', () => {
    const todos = [
      todo('热点选题', 'completed'),
      todo('文案脚本', 'pending'),
      todo('视频生成', 'pending'),
    ];
    const out = deriveWorkflowProgress(STAGES, todos);
    expect(out[0]).toBe('done');
    expect(out[1]).toBe('active');
    expect(out[2]).toBe('pending');
  });

  it('returns empty for no stages', () => {
    expect(deriveWorkflowProgress([], [todo('x', 'completed')])).toEqual([]);
  });
});
