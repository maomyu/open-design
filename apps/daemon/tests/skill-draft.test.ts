import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSkillDraftJson, validateSkillDraft } from '../src/skill-draft-routes.js';
import { coerceSkillEvals, importUserSkill } from '../src/skills.js';

describe('parseSkillDraftJson', () => {
  it('parses a clean JSON object', () => {
    const parsed = parseSkillDraftJson(
      JSON.stringify({
        name: 'xhs-weekly-copy',
        description: '为小红书母婴账号写周更图文文案。Use when 用户提到小红书、周更、图文笔记。',
        triggers: ['小红书文案', '周更笔记'],
        body: '# 工作流\n\n1. 先问账号定位。',
        evals: [{ id: 1, prompt: '帮我写一篇小红书辅食笔记', expected_output: '一篇带标题和正文的笔记' }],
      }),
    );
    expect(parsed?.name).toBe('xhs-weekly-copy');
    expect(parsed?.triggers).toEqual(['小红书文案', '周更笔记']);
    expect(parsed?.evals).toEqual([
      { id: 1, prompt: '帮我写一篇小红书辅食笔记', expectedOutput: '一篇带标题和正文的笔记' },
    ]);
  });

  it('strips code fences and surrounding prose', () => {
    const parsed = parseSkillDraftJson(
      '好的,草稿如下:\n```json\n{"name":"a-skill","description":"d","body":"b"}\n```\n',
    );
    expect(parsed?.name).toBe('a-skill');
    expect(parsed?.body).toBe('b');
  });

  it('returns null for unparseable text', () => {
    expect(parseSkillDraftJson('not json at all')).toBeNull();
    expect(parseSkillDraftJson('')).toBeNull();
  });

  it('drops eval entries without a prompt and renumbers ids', () => {
    const parsed = parseSkillDraftJson(
      JSON.stringify({
        name: 'x',
        description: 'd',
        body: 'b',
        evals: [{ id: 7, prompt: '', expected_output: 'skip' }, { id: 9, prompt: 'real one' }],
      }),
    );
    expect(parsed?.evals).toEqual([{ id: 1, prompt: 'real one', expectedOutput: '' }]);
  });
});

describe('validateSkillDraft', () => {
  const valid = {
    name: 'short-video-hooks',
    description:
      '为短视频生成开头 3 秒钩子文案。Use when 用户提到钩子、开头、留人率、短视频开场,即使没点名要这个技能。',
    triggers: ['短视频钩子', '开头文案'],
    body: '# 流程\n\n1. 先确认平台与赛道。',
  };

  it('passes a spec-conformant draft with no diagnostics', () => {
    expect(validateSkillDraft(valid)).toEqual([]);
  });

  it('errors on missing name / invalid slug', () => {
    expect(validateSkillDraft({ ...valid, name: '' }).map((d) => d.code)).toContain('NAME_REQUIRED');
    expect(validateSkillDraft({ ...valid, name: 'Bad Name!' }).map((d) => d.code)).toContain('NAME_INVALID');
  });

  it('errors on missing description and body', () => {
    const codes = validateSkillDraft({ name: 'ok-name' }).map((d) => d.code);
    expect(codes).toContain('DESCRIPTION_REQUIRED');
    expect(codes).toContain('BODY_REQUIRED');
  });

  it('warns on a description too short to carry trigger context', () => {
    const diags = validateSkillDraft({ ...valid, description: '写文案' });
    const short = diags.find((d) => d.code === 'DESCRIPTION_SHORT');
    expect(short?.severity).toBe('warning');
  });

  it('warns when the body exceeds the 500-line progressive-disclosure guideline', () => {
    const body = Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n');
    const diags = validateSkillDraft({ ...valid, body });
    const long = diags.find((d) => d.code === 'BODY_TOO_LONG');
    expect(long?.severity).toBe('warning');
  });

  it('warns when no triggers are provided', () => {
    const diags = validateSkillDraft({ ...valid, triggers: [] });
    expect(diags.map((d) => d.code)).toContain('NO_TRIGGERS');
  });
});

describe('coerceSkillEvals', () => {
  it('accepts both camelCase and snake_case expected output', () => {
    expect(
      coerceSkillEvals([
        { prompt: 'a', expectedOutput: 'A' },
        { prompt: 'b', expected_output: 'B' },
      ]),
    ).toEqual([
      { id: 1, prompt: 'a', expected_output: 'A', files: [] },
      { id: 2, prompt: 'b', expected_output: 'B', files: [] },
    ]);
  });

  it('returns null when nothing valid remains', () => {
    expect(coerceSkillEvals([{ prompt: '' }, 'junk', null])).toBeNull();
    expect(coerceSkillEvals('not-an-array')).toBeNull();
  });
});

describe('importUserSkill evals seed', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('writes evals/evals.json in the skill-creator schema on import', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'od-skill-draft-'));
    const result = await importUserSkill(root, {
      name: 'hook-writer',
      description: 'Writes short-video hooks. Use when the user asks for hooks.',
      body: '# Flow\n\n1. Ask for the platform.',
      triggers: ['hooks'],
      evals: [{ id: 1, prompt: 'write a hook for a coffee brand', expectedOutput: 'a 3s hook line' }],
    });
    const evalsPath = path.join(result.dir, 'evals', 'evals.json');
    const written = JSON.parse(readFileSync(evalsPath, 'utf8'));
    expect(written).toEqual({
      skill_name: 'hook-writer',
      evals: [{ id: 1, prompt: 'write a hook for a coffee brand', expected_output: 'a 3s hook line', files: [] }],
    });
  });

  it('skips the evals file entirely when no valid evals are supplied', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'od-skill-draft-'));
    const result = await importUserSkill(root, {
      name: 'no-evals-skill',
      description: 'd',
      body: 'b',
    });
    expect(() => readFileSync(path.join(result.dir, 'evals', 'evals.json'), 'utf8')).toThrow();
  });
});
