// 知乎选题链接的形态契约(见 src/media-studio/tikhub.ts `zhihuContentUrl`)。
//
// 2026-07-25 实测:知乎搜索(fetch_article_search_v3)返回的命中【绝大多数是回答】
// (`object.type === 'answer'`,`object.id` 是回答 id),而旧代码一律拼成
// `zhuanlan.zhihu.com/p/{id}`(专栏文章地址)——回答拿这个地址打开必 404
// (「你似乎来到了没有知识存在的荒原」),选题存进池子后互动/写作都在死链上跑。
//
// 回答页链接同时是【互动区读评论】的前提:知乎评论接口按 answer_id 取,只有 /question/{qid}
// 的链接读不到任何评论。所以这里锁死:回答必须落到带 /answer/ 的地址。
import { describe, expect, it } from 'vitest';
import { zhihuContentUrl } from '../src/media-studio/tikhub.js';

describe('zhihuContentUrl — 知乎命中转可打开的网页链接', () => {
  it('回答:拼成 /question/{qid}/answer/{aid}(可打开 + 能读评论)', () => {
    const url = zhihuContentUrl(
      { type: 'answer', id: '2051990654415266562', question: { id: '2001679448794219063' } },
      '考研要努力到什么程度',
    );
    expect(url).toBe('https://www.zhihu.com/question/2001679448794219063/answer/2051990654415266562');
  });

  it('回答缺问题 id:退到 /answer/{aid}(知乎自己跳转),绝不拼成专栏地址', () => {
    const url = zhihuContentUrl({ type: 'answer', id: '2051990654415266562' }, '考研');
    expect(url).toBe('https://www.zhihu.com/answer/2051990654415266562');
    expect(url).not.toContain('zhuanlan');
  });

  it('大整数 id 原样用字符串(不过 Number,否则 ~2e18 被四舍五入成另一个 id)', () => {
    const url = zhihuContentUrl({ type: 'answer', id: '2064295804840547334' }, 'x');
    expect(url).toContain('2064295804840547334');
  });

  it('小 id 是数字类型也要能取到(tikhubFetch 只给 ≥16 位的加引号)', () => {
    const url = zhihuContentUrl({ type: 'answer', id: 2924248537, question: { id: 449908156 } }, 'x');
    expect(url).toBe('https://www.zhihu.com/question/449908156/answer/2924248537');
  });

  it('专栏文章:仍走 zhuanlan/p/{id}', () => {
    expect(zhihuContentUrl({ type: 'article', id: '123456' }, 'x')).toBe('https://zhuanlan.zhihu.com/p/123456');
  });

  it('没 id / 非内容命中(人、相关搜索):退到搜索页而不是拼出死链', () => {
    const url = zhihuContentUrl({ type: 'people', id: '7bb6e079f594c3e21aad601ea38e2987' }, '考研');
    expect(url).toBe('https://www.zhihu.com/search?type=content&q=%E8%80%83%E7%A0%94');
  });
});
