// 互动区人设的来源契约(见 src/media-studio/interaction-reply-run.ts `resolveAccountPersona`)。
//
// 账号的写作人设本来就存在【账号中心】的账号档案里(`style.persona`,创作台写作一直在用)。互动区
// 原来要求在互动页再手填一遍语气——同一个账号两处填、还容易不一致(写作一个调、回评论另一个调)。
// 兜底做在 daemon 而不是界面上,是为了让 UI 和 `od studio gen-reply/ai-auto-reply`(不带 --persona)
// 拿到同一份人设。
//
// 铁律:显式传的人设永远优先(临时换语气);查不到就返回空串,行为与加这个功能之前完全一致。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAccountPersona } from '../src/media-studio/interaction-reply-run.js';

let dataDir = '';

const seed = async (config: unknown): Promise<void> => {
  await writeFile(path.join(dataDir, 'app-config.json'), JSON.stringify(config), 'utf8');
};

const CONFIG = {
  platformAccounts: {
    xiaohongshu: [
      { id: 'a1', name: '报考日记', style: { persona: '专注考研上岸,真诚不鸡汤' } },
      { id: 'a2', name: '没填人设的号' },
    ],
    zhihu: [{ id: 'z1', name: '报考日记', style: { persona: '知乎语气:先给结论再给依据' } }],
  },
};

describe('resolveAccountPersona — 互动人设自动取账号中心', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-persona-'));
    await seed(CONFIG);
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('没显式给人设 → 用该平台该账号的人设', async () => {
    expect(await resolveAccountPersona(dataDir, 'xiaohongshu', '报考日记', '')).toBe('专注考研上岸,真诚不鸡汤');
  });

  it('同名账号按【平台】各取各的(账号是按平台分的)', async () => {
    expect(await resolveAccountPersona(dataDir, 'zhihu', '报考日记', '')).toBe('知乎语气:先给结论再给依据');
  });

  it('显式给了人设 → 永远以显式的为准(临时换语气)', async () => {
    expect(await resolveAccountPersona(dataDir, 'xiaohongshu', '报考日记', '这次走俏皮风')).toBe('这次走俏皮风');
  });

  it('账号没填人设 / 账号不存在 / 没选账号 → 空串(与加此功能前行为一致)', async () => {
    expect(await resolveAccountPersona(dataDir, 'xiaohongshu', '没填人设的号', '')).toBe('');
    expect(await resolveAccountPersona(dataDir, 'xiaohongshu', '查无此号', '')).toBe('');
    expect(await resolveAccountPersona(dataDir, 'xiaohongshu', null, '')).toBe('');
    expect(await resolveAccountPersona(dataDir, '', '报考日记', '')).toBe('');
  });

  it('配置读不出来也不能抛(拟稿链路不该因为读配置失败整条断掉)', async () => {
    await writeFile(path.join(dataDir, 'app-config.json'), '{ 这不是 json', 'utf8');
    expect(await resolveAccountPersona(dataDir, 'xiaohongshu', '报考日记', '')).toBe('');
  });
});
