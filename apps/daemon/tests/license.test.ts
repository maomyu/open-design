// 功能授权机制的行为契约(src/license.ts)。生产公钥内嵌源码、私钥在
// 运营方本机,测试用自造密钥对注入验签——覆盖:验签/篡改/过期/时钟回拨/
// 无文件全放行,以及 URL→所需功能 映射表(licenseGuard 的判定核心)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LicenseFile, LicensePayload } from '@open-design/contracts';
import { loadLicenseState, requiredFeaturesFor, verifyLicenseFile } from '../src/license.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const TEST_PUB_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function signLicense(payload: LicensePayload): LicenseFile {
  const signature = cryptoSign(null, Buffer.from(JSON.stringify(payload), 'utf8'), privateKey).toString('base64');
  return { payload, signature };
}

function payloadOf(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    edition: 'custom',
    customer: '测试客户',
    features: ['article.wechat-mp', 'cap.ai'],
    issuedAt: '2026-01-01',
    expiresAt: '2099-01-01',
    ...overrides,
  };
}

describe('verifyLicenseFile', () => {
  it('正确签名的授权通过验签', () => {
    const result = verifyLicenseFile(signLicense(payloadOf()), TEST_PUB_B64);
    expect(result.ok).toBe(true);
  });

  it('篡改 payload(偷加功能)后签名失效', () => {
    const file = signLicense(payloadOf());
    (file.payload.features as string[]).push('article.zhihu');
    const result = verifyLicenseFile(file, TEST_PUB_B64);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('签名');
  });

  it('未知功能项拒绝(前向兼容:老产品读新授权)', () => {
    const payload = payloadOf();
    (payload.features as string[]).push('future.feature');
    const result = verifyLicenseFile(signLicense(payload), TEST_PUB_B64);
    expect(result.ok).toBe(false);
  });

  it('缺字段/坏结构拒绝', () => {
    expect(verifyLicenseFile({ signature: 'x' }, TEST_PUB_B64).ok).toBe(false);
    expect(verifyLicenseFile(null, TEST_PUB_B64).ok).toBe(false);
  });
});

describe('loadLicenseState', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-license-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeLicense = (d: string, file: LicenseFile) => {
    fs.writeFileSync(path.join(d, 'license.json'), JSON.stringify(file));
  };
  const freshDir = (name: string) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  it('无授权文件 → none(全功能解锁,存量安装零影响)', async () => {
    const d = freshDir('empty');
    const state = await loadLicenseState(d, Date.now, TEST_PUB_B64);
    expect(state.status).toBe('none');
  });

  it('有效授权 → valid + 功能集', async () => {
    const d = freshDir('valid');
    writeLicense(d, signLicense(payloadOf()));
    const state = await loadLicenseState(d, Date.now, TEST_PUB_B64);
    expect(state.status).toBe('valid');
    expect(state.features.has('article.wechat-mp')).toBe(true);
    expect(state.features.has('article.zhihu')).toBe(false);
    expect(state.payload?.customer).toBe('测试客户');
  });

  it('过期授权 → expired(锁功能留数据由 guard 落实)', async () => {
    const d = freshDir('expired');
    writeLicense(d, signLicense(payloadOf({ expiresAt: '2020-01-01' })));
    const state = await loadLicenseState(d, Date.now, TEST_PUB_B64);
    expect(state.status).toBe('expired');
  });

  it('时钟回拨(当前时间早于上次运行 24h 以上)→ invalid', async () => {
    const d = freshDir('clock');
    writeLicense(d, signLicense(payloadOf()));
    const t0 = Date.parse('2026-07-11T00:00:00Z');
    expect((await loadLicenseState(d, () => t0, TEST_PUB_B64)).status).toBe('valid');
    // 回拨 3 天
    const state = await loadLicenseState(d, () => t0 - 3 * 24 * 3600 * 1000, TEST_PUB_B64);
    expect(state.status).toBe('invalid');
    expect(state.reason).toContain('时间');
  });

  it('坏 JSON → invalid(不放行也不崩)', async () => {
    const d = freshDir('badjson');
    fs.writeFileSync(path.join(d, 'license.json'), '{oops');
    const state = await loadLicenseState(d, Date.now, TEST_PUB_B64);
    expect(state.status).toBe('invalid');
  });
});

describe('requiredFeaturesFor(URL→功能映射)', () => {
  const f = requiredFeaturesFor;

  it('文章平台端点 → article.*(all)', () => {
    expect(f('GET', '/wechat-mp/articles')).toEqual({ all: ['article.wechat-mp'] });
    expect(f('POST', '/zhihu/articles')).toEqual({ all: ['article.zhihu'] });
    expect(f('PATCH', '/weibo/articles/x1')).toEqual({ all: ['article.weibo'] });
  });

  it('笔记 → note.xiaohongshu;短视频 studio 级 → 任一 sv.*(anyOf)', () => {
    expect(f('GET', '/note/articles')).toEqual({ all: ['note.xiaohongshu'] });
    expect(f('POST', '/short-video/articles/x/upload-video')).toEqual({
      all: [],
      anyOf: ['sv.douyin', 'sv.kuaishou', 'sv.shipinhao', 'sv.bilibili', 'sv.xiaohongshu'],
    });
  });

  it('知识库任何平台段 = 任一 kb.*(2026-07-16 拆 kb.personal/kb.enterprise 后跟 kb 走)', () => {
    expect(f('GET', '/wechat-mp/knowledge')).toEqual({ all: [], anyOf: ['kb.personal', 'kb.enterprise'] });
    expect(f('POST', '/note/knowledge')).toEqual({ all: [], anyOf: ['kb.personal', 'kb.enterprise'] });
    expect(f('DELETE', '/zhihu/knowledge/k1')).toEqual({ all: [], anyOf: ['kb.personal', 'kb.enterprise'] });
  });

  it('能力后缀叠加:ai-task/images/tts/publish*', () => {
    expect(f('POST', '/wechat-mp/ai-task')).toEqual({ all: ['article.wechat-mp', 'cap.ai'] });
    expect(f('POST', '/zhihu/articles/x/images')).toEqual({ all: ['article.zhihu', 'cap.image'] });
    expect(f('POST', '/short-video/articles/x/tts')).toEqual({ all: ['cap.tts'], anyOf: ['sv.douyin', 'sv.kuaishou', 'sv.shipinhao', 'sv.bilibili', 'sv.xiaohongshu'] });
    expect(f('POST', '/wechat-mp/articles/x/publish')).toEqual({ all: ['article.wechat-mp', 'cap.publish'] });
    expect(f('POST', '/note/articles/x/publish-note')).toEqual({ all: ['note.xiaohongshu', 'cap.publish'] });
  });

  it('handoff 创建:cap.handoff(all) + 目标平台(anyOf);小红书歧义两者其一', () => {
    expect(f('POST', '/handoff', { platform: 'zhihu' })).toEqual({ all: ['cap.handoff'], anyOf: ['article.zhihu'] });
    expect(f('POST', '/handoff', { platform: 'douyin' })).toEqual({ all: ['cap.handoff'], anyOf: ['sv.douyin'] });
    expect(f('POST', '/handoff', { platform: 'xiaohongshu' })).toEqual({ all: ['cap.handoff'], anyOf: ['note.xiaohongshu', 'sv.xiaohongshu'] });
    expect(f('POST', '/handoff/hj-1/claim')).toEqual({ all: [] });
    expect(f('GET', '/handoff/hj-1/wait')).toEqual({ all: [] });
  });

  it('资产/无状态排版/皮肤/浏览器地址表 放行', () => {
    expect(f('GET', '/assets/a1/img.png')).toEqual({ all: [] });
    expect(f('POST', '/render')).toEqual({ all: [] });
    expect(f('GET', '/wechat-mp/skins')).toEqual({ all: [] });
    expect(f('GET', '/browser/urls')).toEqual({ all: [] });
  });

  it('browser/open 按目标平台拦(anyOf)', () => {
    expect(f('POST', '/browser/open', { platform: 'zhihu' })).toEqual({ all: [], anyOf: ['article.zhihu'] });
    expect(f('POST', '/browser/open', { platform: 'xiaohongshu' })).toEqual({ all: [], anyOf: ['note.xiaohongshu', 'sv.xiaohongshu'] });
  });
});
