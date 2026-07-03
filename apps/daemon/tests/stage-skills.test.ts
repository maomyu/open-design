// Stage-level skill binding — the orchestration core: a workflow stage can
// bind global skills (`od.workflow.stages[].skills[].ref`) and the daemon
// injects each bound skill's body UNDER that step's prompt block, scoping the
// methodology to that one stage.

import { describe, expect, it } from 'vitest';

import { renderStagePromptsBlock } from '../src/plugins/stage-prompts.js';
import { coerceStages } from '../src/plugin-edit-routes.js';
import { computeSkillUsage } from '../src/skill-draft-routes.js';

const MANIFEST = {
  od: {
    workflow: {
      stages: [
        {
          id: 'topic',
          title: '选题',
          gate: 'confirm',
          prompt: '给 5 个选题。',
          skills: [{ ref: 'trend-scraper' }, { ref: 'missing-skill' }],
        },
        { id: 'copy', title: '文案', gate: 'confirm', prompt: '写脚本。' },
      ],
    },
  },
};

describe('renderStagePromptsBlock stage-bound skills', () => {
  const resolver = (id: string) =>
    id === 'trend-scraper' ? { name: '热榜抓取', body: '用 bb-browser 抓真实热榜。' } : null;

  it('injects resolved skill bodies under the owning stage only', () => {
    const block = renderStagePromptsBlock(MANIFEST, resolver);
    expect(block).toContain('本步技能「热榜抓取」');
    expect(block).toContain('用 bb-browser 抓真实热榜。');
    // The binding renders inside step 1's section, before step 2 begins.
    const skillIdx = block.indexOf('热榜抓取');
    const step2Idx = block.indexOf('步骤 2');
    expect(skillIdx).toBeGreaterThan(-1);
    expect(skillIdx).toBeLessThan(step2Idx);
  });

  it('skips unresolvable refs silently', () => {
    const block = renderStagePromptsBlock(MANIFEST, resolver);
    expect(block).not.toContain('missing-skill');
  });

  it('renders no skill block without a resolver (backwards compatible)', () => {
    const block = renderStagePromptsBlock(MANIFEST);
    expect(block).toContain('给 5 个选题。');
    expect(block).not.toContain('本步技能');
  });
});

describe('coerceStages skills round-trip shape', () => {
  it('accepts editor string ids and manifest ref objects, deduped', () => {
    const stages = coerceStages([
      {
        id: 'topic',
        title: 'T',
        gate: 'confirm',
        prompt: 'p',
        modes: [],
        skills: ['a-skill', { ref: 'b-skill' }, 'a-skill', '', 42],
      },
    ]);
    expect(stages?.[0]?.skills).toEqual(['a-skill', 'b-skill']);
  });

  it('defaults to an empty list when absent', () => {
    const stages = coerceStages([{ id: 'x', title: 'X', gate: 'none', prompt: '', modes: [] }]);
    expect(stages?.[0]?.skills).toEqual([]);
  });
});

describe('computeSkillUsage', () => {
  it('collects context refs and stage bindings, deduped per plugin', () => {
    const usage = computeSkillUsage([
      {
        id: 'plugin-a',
        manifest: {
          od: {
            context: { skills: [{ ref: 'copywriter' }, { path: './SKILL.md' }] },
            workflow: { stages: [
              { id: 's1', skills: [{ ref: 'trend-scraper' }, { ref: 'copywriter' }] },
              { id: 's2', skills: ['trend-scraper'] },
            ] },
          },
        },
      },
      { id: 'plugin-b', manifest: { od: { context: { skills: [{ ref: 'copywriter' }] } } } },
      { id: 'plugin-c', manifest: {} },
    ]);
    expect(usage['copywriter']).toEqual(['plugin-a', 'plugin-b']);
    expect(usage['trend-scraper']).toEqual(['plugin-a']);
    // Path-based local skill refs are not library references.
    expect(usage['./SKILL.md']).toBeUndefined();
  });
});
