// Parallel/branch nodes — a stage (or a mode) can declare `branch`
// {select,pick} so its child modes become an explicit fork: single vs multi
// select, asked at runtime vs matched by input. A mode may nest one more level
// of submodes (e.g. "真抓热榜" → each scrape method). This covers both the
// runtime prompt composition and the editor-input coercion round-trip.

import { describe, expect, it } from 'vitest';

import { renderStagePromptsBlock } from '../src/plugins/stage-prompts.js';
import { coerceStages, readStages } from '../src/plugin-edit-routes.js';

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

describe('readStages mode theme color', () => {
  // Visual options (e.g. 排版皮肤) carry a theme color the editor renders as a
  // swatch. Hex only — the value lands in an inline style, so anything else
  // must be dropped, not passed through.
  it('surfaces a hex mode color to the editor view and drops non-hex values', () => {
    const manifest = {
      od: { workflow: { stages: [{
        id: 'render', title: '排版', gate: 'none', prompt: '排版。',
        branch: { select: 'single', pick: 'input' },
        modes: [
          { id: 'kaiti', label: 'kaiti · 深红棕楷体', color: '#8B1E22', prompt: '楷体皮肤。' },
          { id: 'purple', label: 'purple', color: 'url(javascript:x)', prompt: '紫。' },
          { id: 'github', label: 'github', prompt: '灰。' },
        ],
      }] } },
    };
    const stages = readStages(manifest);
    const render = stages.find((s) => s.id === 'render')!;
    expect(render.modes.find((m) => m.id === 'kaiti')?.color).toBe('#8B1E22');
    expect(render.modes.find((m) => m.id === 'purple')?.color).toBeUndefined();
    expect(render.modes.find((m) => m.id === 'github')?.color).toBeUndefined();
  });
});

describe('renderStagePromptsBlock 自动模式', () => {
  it('replaces ask gates/forks with auto-advance notes and keeps the publish exception', () => {
    const block = renderStagePromptsBlock(NESTED_MANIFEST, undefined, { autoMode: true });
    // Pacing header flips from "don't run straight through" to auto protocol.
    expect(block).toContain('自动模式');
    expect(block).not.toContain('不要一口气跑完');
    // gate: 'confirm' no longer demands an AskUserQuestion confirmation…
    expect(block).not.toContain('让用户确认/驳回');
    // …and ask-forks (single AND nested multi) collapse to self-resolve.
    expect(block).not.toContain('让用户单选一种');
    expect(block).not.toContain('让用户多选');
    expect(block).toContain('选默认或你判断最合适的一种');
    // The outward-publish confirmation survives as the one kept gate.
    expect(block).toContain('对外发布');
  });

  it('default (no options) keeps the ask semantics unchanged', () => {
    const block = renderStagePromptsBlock(NESTED_MANIFEST);
    expect(block).toContain('用 AskUserQuestion 让用户单选一种');
    expect(block).toContain('不要一口气跑完');
  });
});
