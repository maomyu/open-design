// 互动匹配规则引擎的行为契约(自动评论回复的大脑)。纯匹配(matchInteractionRule)与库层
// CRUD/账号作用域分开测:前者验各匹配模式+优先级+占位符,后者验增删改查+通用/账号规则合并。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db.js';
import {
  listInteractionRules,
  createInteractionRule,
  updateInteractionRule,
  deleteInteractionRule,
} from '../src/media-studio/store.js';
import { matchInteractionRule, renderReplyTemplate } from '../src/media-studio/interaction-rules.js';
import type { InteractionRule } from '@open-design/contracts';

function rule(p: Partial<InteractionRule>): InteractionRule {
  return {
    id: p.id ?? 'r' + Math.round((p.priority ?? 0) * 1000 + (p.createdAt ?? 0)),
    platform: 'xiaohongshu',
    accountId: p.accountId ?? null,
    name: p.name ?? 'rule',
    keywords: p.keywords ?? [],
    matchMode: p.matchMode ?? 'contains',
    replyTemplate: p.replyTemplate ?? '谢谢～',
    ...(p.replyMode ? { replyMode: p.replyMode } : {}),
    action: p.action ?? 'reply',
    priority: p.priority ?? 0,
    enabled: p.enabled ?? true,
    createdAt: p.createdAt ?? 0,
  };
}

describe('matchInteractionRule（纯匹配）', () => {
  it('contains 命中任一关键词,回传命中的关键词', () => {
    const m = matchInteractionRule([rule({ keywords: ['价格', '多少钱'], replyTemplate: '私信你啦' })], { text: '请问这个多少钱呀' });
    expect(m?.reply).toBe('私信你啦');
    expect(m?.matchedKeyword).toBe('多少钱');
  });

  it('contains 大小写不敏感(英文关键词)', () => {
    const m = matchInteractionRule([rule({ keywords: ['Link'] })], { text: 'where is the LINK?' });
    expect(m?.matchedKeyword).toBe('Link');
  });

  it('exact 只在评论==关键词时命中', () => {
    const r = [rule({ keywords: ['1'], matchMode: 'exact', replyTemplate: '收到' })];
    expect(matchInteractionRule(r, { text: '1' })?.reply).toBe('收到');
    expect(matchInteractionRule(r, { text: '11' })).toBeNull();
  });

  it('regex 用首关键词作正则,回传匹配子串', () => {
    const m = matchInteractionRule([rule({ keywords: ['\\d{11}'], matchMode: 'regex', replyTemplate: '别留手机号哦' })], { text: '加我13800138000' });
    expect(m?.reply).toBe('别留手机号哦');
    expect(m?.matchedKeyword).toBe('13800138000');
  });

  it('坏正则当不命中,不炸', () => {
    expect(matchInteractionRule([rule({ keywords: ['('], matchMode: 'regex' })], { text: 'x(' })).toBeNull();
  });

  it('优先级高者先命中(同评论命中多条)', () => {
    const rules = [
      rule({ id: 'lo', keywords: ['谢谢'], replyTemplate: '低优', priority: 1 }),
      rule({ id: 'hi', keywords: ['谢谢'], replyTemplate: '高优', priority: 10 }),
    ];
    expect(matchInteractionRule(rules, { text: '谢谢分享' })?.reply).toBe('高优');
  });

  it('禁用的规则不参与匹配', () => {
    expect(matchInteractionRule([rule({ keywords: ['价格'], enabled: false })], { text: '价格多少' })).toBeNull();
  });

  it('都不命中返回 null(=不回复)', () => {
    expect(matchInteractionRule([rule({ keywords: ['价格'] })], { text: '拍得真好看' })).toBeNull();
  });

  it('占位符 {author}/{keyword} 渲染', () => {
    const m = matchInteractionRule([rule({ keywords: ['教程'], replyTemplate: '@{author} 「{keyword}」私信发你' })], { text: '求教程', author: '小明' });
    expect(m?.reply).toBe('@小明 「教程」私信发你');
  });
});

describe('renderReplyTemplate', () => {
  it('缺省变量替换成空串', () => {
    expect(renderReplyTemplate('你好 {author}{keyword}', {})).toBe('你好 ');
  });
});

describe('interaction rules store（CRUD + 账号作用域）', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'irules-'));
    db = openDatabase(dir);
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('增查改删 + 优先级降序', () => {
    createInteractionRule(db, { platform: 'xiaohongshu', name: 'A', keywords: ['价格'], replyTemplate: '私信', priority: 1 });
    const b = createInteractionRule(db, { platform: 'xiaohongshu', name: 'B', keywords: ['教程'], replyTemplate: '发你', priority: 5 });
    let list = listInteractionRules(db, 'xiaohongshu');
    expect(list.map((r) => r.name)).toEqual(['B', 'A']); // priority 降序
    updateInteractionRule(db, b.id, { enabled: false, priority: 0 });
    list = listInteractionRules(db, 'xiaohongshu');
    expect(list.find((r) => r.id === b.id)?.enabled).toBe(false);
    expect(deleteInteractionRule(db, b.id)).toBe(true);
    expect(listInteractionRules(db, 'xiaohongshu')).toHaveLength(1);
  });

  it('账号作用域:通用规则(null)对所有账号可见;查具体账号返回通用+该账号', () => {
    createInteractionRule(db, { platform: 'xiaohongshu', accountId: null, name: '通用', keywords: ['价格'], replyTemplate: 'x' });
    createInteractionRule(db, { platform: 'xiaohongshu', accountId: '茂宇', name: '茂宇专属', keywords: ['合作'], replyTemplate: 'y' });
    createInteractionRule(db, { platform: 'xiaohongshu', accountId: '别人', name: '别人的', keywords: ['z'], replyTemplate: 'z' });
    expect(listInteractionRules(db, 'xiaohongshu', null).map((r) => r.name)).toEqual(['通用']); // 只通用
    const forMaoyu = listInteractionRules(db, 'xiaohongshu', '茂宇').map((r) => r.name).sort();
    expect(forMaoyu).toEqual(['茂宇专属', '通用']); // 通用+本账号,不含别人的
  });

  it('存回后能被匹配器直接吃(端到端:库→匹配)', () => {
    createInteractionRule(db, { platform: 'xiaohongshu', name: '问价', keywords: ['多少钱', '价格'], replyTemplate: '私信报价给你～', priority: 10 });
    const rules = listInteractionRules(db, 'xiaohongshu', '茂宇');
    expect(matchInteractionRule(rules, { text: '这条项链多少钱' })?.reply).toBe('私信报价给你～');
  });

  // 关键词规则的【AI 意图模式】:关键词负责挑出该回的人,AI 负责把话说得像人(同一条模板刷屏
  // 最容易被平台判机器人)。存回来的 replyMode 必须原样带到匹配结果上——调用方就是靠它决定
  // 「直接发」还是「先交给 AI 现写」;丢了这一位,意图文本就会被当成文案发出去。
  it('replyMode 存得回来、也带到匹配结果上', () => {
    createInteractionRule(db, {
      platform: 'xiaohongshu', name: '问价走AI', keywords: ['多少钱'],
      replyTemplate: '热情引导私信,别在评论区甩链接', replyMode: 'ai', priority: 20,
    });
    const rules = listInteractionRules(db, 'xiaohongshu', null);
    expect(rules[0]?.replyMode).toBe('ai');
    expect(matchInteractionRule(rules, { text: '这条多少钱' })?.replyMode).toBe('ai');
  });

  it('没写 replyMode 的历史规则一律当 template(存量库补列后默认值)', () => {
    createInteractionRule(db, { platform: 'xiaohongshu', name: '老规则', keywords: ['价格'], replyTemplate: '私信你啦' });
    const rules = listInteractionRules(db, 'xiaohongshu', null);
    expect(rules[0]?.replyMode).toBe('template');
    expect(matchInteractionRule(rules, { text: '价格多少' })?.replyMode).toBe('template');
  });

  it('改规则能把 template 切成 ai', () => {
    const created = createInteractionRule(db, { platform: 'xiaohongshu', name: 'r', keywords: ['价格'], replyTemplate: '私信你啦' });
    const updated = updateInteractionRule(db, created.id, { replyMode: 'ai', replyTemplate: '引导私信,别甩链接' });
    expect(updated?.replyMode).toBe('ai');
    expect(updated?.replyTemplate).toBe('引导私信,别甩链接');
  });
});
