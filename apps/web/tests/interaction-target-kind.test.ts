// 互动采集池的「这条链接拿来能干什么」判定契约（见 src/providers/media-studio.ts
// `interactionTargetKind`）。
//
// 背景（2026-08-04 用户反馈「互动模块的采集池针对知乎的是不是不对」）：互动区把创作台的选题
// 候选池直接端上来，但同一平台不同来源产出的链接根本不是一回事——知乎热榜给的是【问题页】
// （评论挂在具体回答下，问题页读不到评论）、搜知乎给的才是【回答页】、微博热榜给的是 #话题#
// 搜索页而不是帖子。混在一张列表里，用户点进去多半读不到评论，看着就像采集池坏了。
//
// 这里的判定口径必须与【引擎实际能力】严格一致（bakuan-engine/scripts/fetch_comments.py 的
// `_zhihu_id` / `_weibo_id` / `_note_id`）。判宽了更糟：界面承诺能逐条回复，后端却读到 0 条。
import { describe, expect, it } from 'vitest';
import { interactionTargetKind } from '../src/providers/media-studio';

describe('interactionTargetKind — 采集池链接的互动可用性', () => {
  describe('知乎', () => {
    it('回答页 → 能读评论（评论接口按 answer_id 取）', () => {
      expect(interactionTargetKind('zhihu', 'https://www.zhihu.com/question/123/answer/456')).toBe('commentable');
      expect(interactionTargetKind('zhihu', 'https://www.zhihu.com/answer/456')).toBe('commentable');
    });

    it('只有问题页 → 读不到评论，只能发开场评论（不是坏了，是知乎的结构如此）', () => {
      expect(interactionTargetKind('zhihu', 'https://www.zhihu.com/question/2064289475916560021')).toBe('opening-only');
    });

    it('专栏文章 → 暂无评论接口，同样只能开场', () => {
      expect(interactionTargetKind('zhihu', 'https://zhuanlan.zhihu.com/p/716968117')).toBe('opening-only');
    });

    it('搜索页 → 根本不是一条内容，不该进互动列表', () => {
      expect(interactionTargetKind('zhihu', 'https://www.zhihu.com/search?type=content&q=%E8%80%83%E7%A0%94')).toBe('unusable');
    });
  });

  describe('微博', () => {
    it('帖子页两种形态都能读评论（接口 bid62 与 mid 都认）', () => {
      expect(interactionTargetKind('weibo', 'https://weibo.com/2656274875/R9FN1hm00')).toBe('commentable');
      expect(interactionTargetKind('weibo', 'https://weibo.com/detail/5324506904397429')).toBe('commentable');
    });

    it('#话题#/搜索页 → 不是帖子，排除（热榜给的正是这种）', () => {
      expect(interactionTargetKind('weibo', 'https://s.weibo.com/weibo?q=%23%E7%94%B5%E5%BD%B1%23')).toBe('unusable');
    });
  });

  describe('小红书', () => {
    it('笔记页能读评论；非笔记链接排除', () => {
      expect(interactionTargetKind('xiaohongshu', 'https://www.xiaohongshu.com/explore/abc123')).toBe('commentable');
      expect(interactionTargetKind('xiaohongshu', 'https://www.xiaohongshu.com/user/profile/xyz')).toBe('unusable');
    });
  });

  it('跨平台链接一律排除（知乎列表里不该混进微博帖子）', () => {
    expect(interactionTargetKind('zhihu', 'https://weibo.com/2656274875/R9FN1hm00')).toBe('unusable');
    expect(interactionTargetKind('weibo', 'https://www.zhihu.com/question/1/answer/2')).toBe('unusable');
  });

  it('空链接（AI 选题常没有真实 URL）一律排除', () => {
    expect(interactionTargetKind('zhihu', '')).toBe('unusable');
    expect(interactionTargetKind('zhihu', null)).toBe('unusable');
    expect(interactionTargetKind('zhihu', undefined)).toBe('unusable');
  });
});
