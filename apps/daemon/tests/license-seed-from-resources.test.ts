// 定制包「客户双击装完即按合同裁剪」的契约(见 src/license.ts `seedLicenseFromResources`)。
//
// 背景(2026-07-26 实测):license 原来只被拷进本地打包运行时目录,【不进安装包】——交付得让
// 客户装完再跑一次 `license import`。实际结果是客户双击装完看到的是全功能超集:公众号、
// 抖音、快手、B站、视频号这些合同外的平台全露着(`无授权文件 = 全功能解锁`)。现在定制包把
// license 打进资源树,daemon 首启动播种到数据目录。
//
// 最要命的一条是「已有授权绝不覆盖」:客户续期时 import 的新 license 写在数据目录,如果每次
// 启动都用包里的旧 license 盖掉,客户一升级就被打回旧授权甚至过期。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedLicenseFromResources } from '../src/license.js';

let dataDir = '';
let resourceRoot = '';

const BUNDLED = JSON.stringify({ payload: { customer: '油炸老总', features: ['note.xiaohongshu'] }, signature: 'a' });
const RENEWED = JSON.stringify({ payload: { customer: '油炸老总', features: ['note.xiaohongshu', 'article.zhihu'] }, signature: 'b' });

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'od-lic-data-'));
  resourceRoot = await mkdtemp(path.join(tmpdir(), 'od-lic-res-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(resourceRoot, { recursive: true, force: true });
});

describe('seedLicenseFromResources — 安装包内嵌授权的首启动播种', () => {
  it('数据目录没授权 + 包里有 → 播种(客户双击装完即合同范围)', async () => {
    await writeFile(path.join(resourceRoot, 'license.json'), BUNDLED, 'utf8');
    await seedLicenseFromResources(dataDir, resourceRoot);
    expect(await readFile(path.join(dataDir, 'license.json'), 'utf8')).toBe(BUNDLED);
  });

  it('数据目录已有授权 → 绝不覆盖(客户续期导入的必须赢过包里的旧授权)', async () => {
    await writeFile(path.join(resourceRoot, 'license.json'), BUNDLED, 'utf8');
    await writeFile(path.join(dataDir, 'license.json'), RENEWED, 'utf8');
    await seedLicenseFromResources(dataDir, resourceRoot);
    expect(await readFile(path.join(dataDir, 'license.json'), 'utf8')).toBe(RENEWED);
  });

  it('包里没内嵌授权(开发/超集包) → 什么都不做,维持无授权=全解锁', async () => {
    await seedLicenseFromResources(dataDir, resourceRoot);
    await expect(readFile(path.join(dataDir, 'license.json'), 'utf8')).rejects.toThrow();
  });

  it('dev(resourceRoot=null) → 直接跳过', async () => {
    await seedLicenseFromResources(dataDir, null);
    await expect(readFile(path.join(dataDir, 'license.json'), 'utf8')).rejects.toThrow();
  });
});
