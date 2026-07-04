// Parallel/branch nodes — a stage (or a mode) can declare `branch`
// {select,pick} so its child modes become an explicit fork: single vs multi
// select, asked at runtime vs matched by input. A mode may nest one more level
// of submodes (e.g. "真抓热榜" → each scrape method). This covers both the
// runtime prompt composition and the editor-input coercion round-trip.

import { describe, expect, it } from 'vitest';

import { renderStagePromptsBlock } from '../src/plugins/stage-prompts.js';
import { coerceStages } from '../src/plugin-edit-routes.js';

const NESTED_MANIFEST = {
  od: {
    workflow: {
      stages: [
        {
          id: 'topic',
          title: '热点选题',
          gate: 'confirm',
          prompt: '给候选选题。',
          branch: { select: 'single', pick: 'ask' },
          modes: [
            { id: 'ai-suggest', label: 'AI 建议', prompt: 'AI 直接给方向。' },
            {
              id: 'scrape',
              label: '真抓热榜',
              prompt: '抓该平台热榜。',
              branch: { select: 'multi', pick: 'ask' },
              modes: [
                { id: 'bb-browser', label: 'bb-browser', prompt: '用 bb-browser 抓。' },
                { id: 'gstack', label: 'gstack 反检测', prompt: '用 gstack browse 抓。' },
              ],
            },
          ],
        },
      ],
    },
  },
};

describe('renderStagePromptsBlock branch/nested modes', () => {
  it('renders a single-select stage fork as a pick-one AskUserQuestion note', () => {
    const block = renderStagePromptsBlock(NESTED_MANIFEST);
    expect(block).toContain('模式「AI 建议」');
    expect(block).toContain('用 AskUserQuestion 让用户单选一种');
  });

  it('renders the nested multi-select submodes as a run-each-picked note', () => {
    const block = renderStagePromptsBlock(NESTED_MANIFEST);
    expect(block).toContain('模式「真抓热榜」');
    // The nested scrape methods surface as level-2 options...
    expect(block).toContain('bb-browser');
    expect(block).toContain('gstack 反检测');
    // ...under a multiSelect + run-each note.
    expect(block).toContain('用 AskUserQuestion 让用户多选');
    expect(block).toContain('各跑一遍');
  });

  it('keeps legacy flat modes (no branch) on the input-matched note', () => {
    const legacy = {
      od: { workflow: { stages: [{
        id: 'topic', title: '选题', gate: 'confirm', prompt: 'x',
        modes: [{ id: 'a', label: 'A', prompt: 'pa' }],
      }] } },
    };
    const block = renderStagePromptsBlock(legacy);
    expect(block).toContain('按相关输入值选匹配的那个执行');
  });
});

describe('coerceStages branch/nested round-trip', () => {
  it('preserves stage branch, mode branch, and level-2 submodes', () => {
    const stages = coerceStages(NESTED_MANIFEST.od.workflow.stages);
    expect(stages).not.toBeNull();
    const topic = stages![0]!;
    expect(topic.branch).toEqual({ select: 'single', pick: 'ask' });
    const scrape = topic.modes.find((m) => m.id === 'scrape')!;
    expect(scrape.branch).toEqual({ select: 'multi', pick: 'ask' });
    expect(scrape.modes?.map((s) => s.id)).toEqual(['bb-browser', 'gstack']);
    expect(scrape.modes?.[0]?.prompt).toBe('用 bb-browser 抓。');
    // A mode with no branch stays plain (no branch/modes leakage).
    const ai = topic.modes.find((m) => m.id === 'ai-suggest')!;
    expect(ai.branch).toBeUndefined();
    expect(ai.modes).toBeUndefined();
  });
});
