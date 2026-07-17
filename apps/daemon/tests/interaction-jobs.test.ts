// 互动执行派发总线的行为契约（见 src/media-studio/interaction-jobs.ts）。
// 与 handoff/collect 同构:测总线本体(无订阅者拒建/认领竞态/进度唤醒长轮询/终态幂等)。
import { describe, expect, it } from 'vitest';
import { createInteractionBus, InteractionError } from '../src/media-studio/interaction-jobs.js';
import type { CreateStudioInteractionRequest, StudioInteractionJob } from '@open-design/contracts';

const REQ: CreateStudioInteractionRequest = {
  platform: 'xiaohongshu',
  account: 'acctA',
  action: 'reply',
  targetRef: 'https://www.xiaohongshu.com/explore/n1',
  text: '谢谢支持～',
};

describe('interaction bus', () => {
  it('无订阅者(桌面端没开)时 create 直接失败,给可行动的报错', () => {
    const bus = createInteractionBus();
    expect(() => bus.create(REQ)).toThrowError(InteractionError);
    expect(() => bus.create(REQ)).toThrowError(/桌面端未连接/);
  });

  it('订阅后 create 立即广播;后连的订阅者补发 pending,已认领的不补发', () => {
    const bus = createInteractionBus();
    const got: StudioInteractionJob[] = [];
    bus.subscribe((job) => got.push(job));
    const job = bus.create(REQ);
    expect(got.map((j) => j.id)).toEqual([job.id]);
    expect(job.id.startsWith('ix-')).toBe(true);

    const late: StudioInteractionJob[] = [];
    bus.subscribe((j) => late.push(j));
    expect(late.map((j) => j.id)).toEqual([job.id]);

    bus.claim(job.id);
    const afterClaim: StudioInteractionJob[] = [];
    bus.subscribe((j) => afterClaim.push(j));
    expect(afterClaim).toEqual([]);
  });

  it('claim 竞态先到先得:第二个认领者拿 null', () => {
    const bus = createInteractionBus();
    bus.subscribe(() => {});
    const job = bus.create(REQ);
    expect(bus.claim(job.id)?.status).toBe('claimed');
    expect(bus.claim(job.id)).toBeNull();
  });

  it('progress 追加并唤醒挂着的 wait;wait 按 since 取增量', async () => {
    const bus = createInteractionBus();
    bus.subscribe(() => {});
    const job = bus.create(REQ);
    bus.claim(job.id);

    const waiting = bus.wait(job.id, 0, 5_000);
    bus.progress(job.id, '打开笔记页');
    const snap = await waiting;
    expect(snap?.job.progress).toEqual(['打开笔记页']);
    expect(snap?.cursor).toBe(1);
    expect(snap?.job.status).toBe('running');
  });

  it('complete 落终态且幂等;终态后 progress 拒绝', () => {
    const bus = createInteractionBus();
    bus.subscribe(() => {});
    const job = bus.create(REQ);
    bus.claim(job.id);
    expect(bus.complete(job.id, true, '已回复')?.status).toBe('done');
    // 幂等:再 complete 不翻转
    expect(bus.complete(job.id, false, '晚到的失败')?.status).toBe('done');
    // 终态后 progress 无效
    expect(bus.progress(job.id, '晚到进度')).toBeNull();
  });

  it('携带账号/动作/目标/文本原样透传', () => {
    const bus = createInteractionBus();
    bus.subscribe(() => {});
    const job = bus.create({ platform: 'weibo', account: null, action: 'dm', targetRef: 'user9', text: '你好' });
    expect(job.platform).toBe('weibo');
    expect(job.account).toBeNull();
    expect(job.action).toBe('dm');
    expect(job.targetRef).toBe('user9');
    expect(job.text).toBe('你好');
  });
});
