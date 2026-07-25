// 「自动直发」的安全闸门契约(见 src/media-studio/interaction-reply.ts `pickAutoSendCandidates`)。
// 这个函数决定【哪些评论回复会在无人审核下自动外发】——是防平台风控的第一道闸,行为必须锁死:
// 只有【安全正向类(夸赞/提问/共鸣/开场)+ AI 判 should_reply=true + 有文案】才可自动发;负面/水军/
// 需人工/求链接一律不自动发;按 confidence 降序截到上限;已发过的(dedup 集)排除。
// 「开场」是 2026-07-22 起有意放行的:它是给【没人评论的笔记】写的一条首评(抢首评引流),不是回
// 某个具体的人,开场提示词自带铁律(不甩链接/不求关注/敏感笔记直接空),风险与夸赞类同级。
import { describe, expect, it } from 'vitest';
import { pickAutoSendCandidates, SAFE_AUTO_REPLY_CATEGORIES } from '../src/media-studio/interaction-reply.js';

type Draft = { id: string; should_reply?: boolean; category?: string; reply?: string; confidence?: number; author?: string };

const draft = (over: Partial<Draft> & { id: string }): Draft => ({ should_reply: true, category: '共鸣', reply: '接住你的情绪～', confidence: 0.9, ...over });

describe('pickAutoSendCandidates — 自动直发安全闸门', () => {
  it('只放行安全正向类(夸赞/提问/共鸣/开场)', () => {
    const drafts: Draft[] = [
      draft({ id: 'a', category: '夸赞' }),
      draft({ id: 'b', category: '提问' }),
      draft({ id: 'c', category: '共鸣' }),
    ];
    const out = pickAutoSendCandidates(drafts, 10);
    expect(out.map((c) => c.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('负面/水军/需人工/求链接 即使 should_reply=true 也绝不自动发', () => {
    const drafts: Draft[] = [
      draft({ id: 'neg', category: '负面', should_reply: true }),
      draft({ id: 'spam', category: '水军', should_reply: true }),
      draft({ id: 'manual', category: '需人工', should_reply: true }),
      draft({ id: 'link', category: '求链接', should_reply: true, reply: '私信我发你哈' }),
      draft({ id: 'other', category: '其他', should_reply: true }),
    ];
    expect(pickAutoSendCandidates(drafts, 10)).toEqual([]);
  });

  it('should_reply=false 或空文案 一律排除', () => {
    const drafts: Draft[] = [
      draft({ id: 'no', category: '共鸣', should_reply: false }),
      draft({ id: 'empty', category: '提问', reply: '   ' }),
    ];
    expect(pickAutoSendCandidates(drafts, 10)).toEqual([]);
  });

  it('按 confidence 降序截到上限(先发最有把握的)', () => {
    const drafts: Draft[] = [
      draft({ id: 'lo', category: '共鸣', confidence: 0.2 }),
      draft({ id: 'hi', category: '共鸣', confidence: 0.95 }),
      draft({ id: 'mid', category: '提问', confidence: 0.6 }),
    ];
    const out = pickAutoSendCandidates(drafts, 2);
    expect(out.map((c) => c.id)).toEqual(['hi', 'mid']);
  });

  it('安全白名单就是 夸赞/提问/共鸣/开场 四类(锁死,别悄悄放宽;开场见文件头说明)', () => {
    expect([...SAFE_AUTO_REPLY_CATEGORIES].sort()).toEqual(['共鸣', '夸赞', '开场', '提问']);
  });

  it('携带 author、trim 文案', () => {
    const out = pickAutoSendCandidates([draft({ id: 'a', category: '夸赞', reply: '  谢谢你～  ', author: '小王' })], 5);
    expect(out[0]).toMatchObject({ id: 'a', reply: '谢谢你～', category: '夸赞', author: '小王' });
  });
});
