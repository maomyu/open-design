// 浏览器注入发布派发总线的行为契约(见 src/media-studio/handoff-jobs.ts)。
// 测总线本体不走 HTTP:路由层只是薄封装,总线语义(无订阅者拒建/认领竞态/
// 进度唤醒长轮询/终态幂等/TTL 清扫)才是会咬人的部分。
import { describe, expect, it } from 'vitest';
import { createHandoffBus, HandoffError } from '../src/media-studio/handoff-jobs.js';
import type { StudioHandoffJob } from '@open-design/contracts';

const REQ = {
  platform: 'zhihu' as const,
  articleId: 'a1',
  articlePlatform: 'zhihu',
  autoPublish: false,
};

describe('handoff bus', () => {
  it('无订阅者(桌面端没开)时 create 直接失败,给可行动的报错', () => {
    const bus = createHandoffBus();
    expect(() => bus.create(REQ)).toThrowError(HandoffError);
    expect(() => bus.create(REQ)).toThrowError(/桌面端未连接/);
  });

  it('订阅后 create 立即广播;后连的订阅者补发 pending', () => {
    const bus = createHandoffBus();
    const got: StudioHandoffJob[] = [];
    bus.subscribe((job) => got.push(job));
    const job = bus.create(REQ);
    expect(got.map((j) => j.id)).toEqual([job.id]);

    const late: StudioHandoffJob[] = [];
    bus.subscribe((job) => late.push(job));
    expect(late.map((j) => j.id)).toEqual([job.id]); // pending 补发

    bus.claim(job.id);
    const afterClaim: StudioHandoffJob[] = [];
    bus.subscribe((j) => afterClaim.push(j));
    expect(afterClaim).toEqual([]); // 已认领的不再补发
  });

  it('claim 竞态先到先得:第二个认领者拿 null', () => {
    const bus = createHandoffBus();
    bus.subscribe(() => {});
    const job = bus.create(REQ);
    expect(bus.claim(job.id)?.status).toBe('claimed');
    expect(bus.claim(job.id)).toBeNull();
  });

  it('progress 追加并唤醒挂着的 wait;wait 按 since 取增量', async () => {
    const bus = createHandoffBus();
    bus.subscribe(() => {});
    const job = bus.create(REQ);
    bus.claim(job.id);

    const waiting = bus.wait(job.id, 0, 5_000);
    bus.progress(job.id, '打开面板');
    const snap = await waiting;
    expect(snap?.job.progress).toEqual(['打开面板']);
    expect(snap?.cursor).toBe(1);
    expect(snap?.job.status).toBe('running');

    bus.progress(job.id, '填标题');
    const inc = await bus.wait(job.id, snap!.cursor, 5_000);
    expect(inc?.job.progress).toEqual(['填标题']); // 只给增量
    expect(inc?.cursor).toBe(2);
  });

  it('complete 后 wait 立即返回终态;complete 幂等不覆盖首个终态', async () => {
    const bus = createHandoffBus();
    bus.subscribe(() => {});
    const job = bus.create(REQ);
    bus.claim(job.id);
    bus.complete(job.id, true, '已填好待发');
    const snap = await bus.wait(job.id, 0, 5_000);
    expect(snap?.job.status).toBe('done');
    expect(snap?.job.detail).toBe('已填好待发');

    const again = bus.complete(job.id, false, '晚到的失败');
    expect(again?.status).toBe('done'); // 幂等:不被晚到的 complete 翻转
    expect(again?.detail).toBe('已填好待发');
    expect(bus.progress(job.id, '晚到的进度')).toBeNull(); // 终态拒进度
  });

  it('TTL 清扫:终态 job 过期后被 sweep,get 拿 null', () => {
    let t = 1_000;
    const bus = createHandoffBus(() => t);
    bus.subscribe(() => {});
    const job = bus.create(REQ);
    bus.complete(job.id, true, 'ok');
    t += 11 * 60_000; // 超过终态 TTL(10min)
    bus.create({ ...REQ, articleId: 'a2' }); // create 触发 sweep
    expect(bus.get(job.id)).toBeNull();
  });
});
