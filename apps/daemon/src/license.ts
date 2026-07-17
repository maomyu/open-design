// 功能授权:加载/验签/强制(2026-07-11 用户拍板的定制版机制,第一期)。
//
// 形态:<dataDir>/license.json(与 app-config.json 同目录),内容为
// { payload, signature } —— payload 的 JSON 串被运营方 Ed25519 私钥签名,
// 这里用内嵌公钥验签。客户改一个字签名即失效。
//
// 三条铁律:
//  1. 无授权文件 = 全功能解锁(开发机/CI/e2e/存量安装零影响)。
//  2. 到期 = 锁功能留数据:写操作 403,GET 读端点放行(数据永不绑架)。
//  3. daemon 是唯一强制点——UI 隐藏只是体验层,CLI/智能体走 API 自然被拦。
//
// 轻量时钟回拨防护:<dataDir>/license-state.json 记录见过的最大时间戳,
// 当前时间早于它 24h 以上按无效处理(防「改系统时间续命」)。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  articleFeatureOf,
  handoffTargetFeatures,
  isFeatureId,
  type FeatureId,
  type LicenseFile,
  type LicensePayload,
  type LicenseStatusResponse,
} from '@open-design/contracts';

/** 运营方签发公钥(SPKI base64,Ed25519)。私钥在运营方本机,绝不进仓库。 */
const LICENSE_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAIrrY1mNxsc6ViW5RWU7moy9/um09zP0+qwztdMG3s7E=';

const CLOCK_ROLLBACK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export interface LicenseState {
  status: 'none' | 'valid' | 'expired' | 'invalid';
  payload?: LicensePayload;
  features: Set<FeatureId>;
  reason?: string;
}

/** 可变引用:路由/中间件持有它,import/reload 后原地替换 state。 */
export interface LicenseStateRef {
  current: LicenseState;
}

const UNLOCKED: LicenseState = { status: 'none', features: new Set() };

export function licenseFilePath(dataDir: string): string {
  return path.join(dataDir, 'license.json');
}

function stateFilePath(dataDir: string): string {
  return path.join(dataDir, 'license-state.json');
}

export function verifyLicenseFile(
  raw: unknown,
  publicKeySpkiB64: string = LICENSE_PUBLIC_KEY_SPKI_B64,
): { ok: true; payload: LicensePayload } | { ok: false; reason: string } {
  const file = raw as LicenseFile;
  if (!file || typeof file !== 'object' || !file.payload || typeof file.signature !== 'string') {
    return { ok: false, reason: '授权文件格式不对' };
  }
  const p = file.payload;
  if (p.v !== 1 || (p.edition !== 'custom' && p.edition !== 'consumer') || typeof p.customer !== 'string'
    || !Array.isArray(p.features) || typeof p.expiresAt !== 'string' || typeof p.issuedAt !== 'string') {
    return { ok: false, reason: '授权内容缺字段' };
  }
  if (!p.features.every(isFeatureId)) {
    return { ok: false, reason: '授权含未知功能项(产品版本过旧?)' };
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeySpkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const ok = cryptoVerify(null, Buffer.from(JSON.stringify(p), 'utf8'), publicKey, Buffer.from(file.signature, 'base64'));
    if (!ok) return { ok: false, reason: '签名校验失败(文件被修改或非本产品签发)' };
  } catch {
    return { ok: false, reason: '签名解析失败' };
  }
  return { ok: true, payload: p };
}

/** 读盘+验签+过期/时钟判定。无文件 → status none(全解锁)。
 *  publicKeySpkiB64 仅测试注入用,产品路径永远走内嵌公钥。
 *  bundledFallbackPath(双包交付,2026-07-17):数据目录没有 license 时回落读打包
 *  资源里烤入的 license.json——客户装上即是该包的功能集;运行时 import 到数据目录
 *  后优先级更高(先读数据目录)。 */
export async function loadLicenseState(
  dataDir: string,
  now: () => number = Date.now,
  publicKeySpkiB64?: string,
  bundledFallbackPath?: string | null,
): Promise<LicenseState> {
  let rawText: string;
  try {
    rawText = await readFile(licenseFilePath(dataDir), 'utf8');
  } catch {
    if (!bundledFallbackPath) return UNLOCKED;
    try {
      rawText = await readFile(bundledFallbackPath, 'utf8');
    } catch {
      return UNLOCKED;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { status: 'invalid', features: new Set(), reason: '授权文件不是有效 JSON' };
  }
  const verified = verifyLicenseFile(parsed, publicKeySpkiB64);
  if (!verified.ok) {
    return { status: 'invalid', features: new Set(), reason: verified.reason };
  }
  const t = now();
  // 时钟回拨防护:见过的最大时间戳持久化;当前时间明显早于它 → 异常。
  const lastSeen = await readLastSeen(dataDir);
  if (lastSeen != null && t < lastSeen - CLOCK_ROLLBACK_TOLERANCE_MS) {
    return {
      status: 'invalid',
      payload: verified.payload,
      features: new Set(),
      reason: '系统时间异常(早于上次运行超过 24 小时)——校准时间后重试',
    };
  }
  void writeLastSeen(dataDir, Math.max(t, lastSeen ?? 0));
  const expiresMs = Date.parse(verified.payload.expiresAt);
  if (Number.isFinite(expiresMs) && t > expiresMs) {
    return { status: 'expired', payload: verified.payload, features: new Set(verified.payload.features) };
  }
  return { status: 'valid', payload: verified.payload, features: new Set(verified.payload.features) };
}

async function readLastSeen(dataDir: string): Promise<number | null> {
  try {
    const data = JSON.parse(await readFile(stateFilePath(dataDir), 'utf8')) as { lastSeenAt?: number };
    return typeof data.lastSeenAt === 'number' ? data.lastSeenAt : null;
  } catch {
    return null;
  }
}

async function writeLastSeen(dataDir: string, lastSeenAt: number): Promise<void> {
  try {
    await writeFile(stateFilePath(dataDir), JSON.stringify({ lastSeenAt }), 'utf8');
  } catch {
    /* 只是防护辅助,写失败不阻断 */
  }
}

export function licenseStatusResponse(state: LicenseState): LicenseStatusResponse {
  if (state.status === 'none') return { status: 'none' };
  return {
    status: state.status,
    ...(state.payload
      ? {
          edition: state.payload.edition,
          customer: state.payload.customer,
          features: state.payload.features,
          expiresAt: state.payload.expiresAt,
        }
      : {}),
    ...(state.reason ? { reason: state.reason } : {}),
  };
}

// ---- URL → 所需功能 映射(纯函数,单测覆盖) ----

/** 一个请求的授权要求:all 全部持有 + anyOf 至少持有其一。
 *  anyOf 用于共享池的短视频(URL 是 /short-video/*,不带具体平台,studio 级
 *  访问只需"任一 sv.*")和小红书 handoff 的图文/视频歧义。 */
export interface FeatureRequirement {
  all: FeatureId[];
  anyOf?: FeatureId[];
}

const SV_FEATURES: FeatureId[] = ['sv.douyin', 'sv.kuaishou', 'sv.shipinhao', 'sv.bilibili', 'sv.xiaohongshu'];
const NONE: FeatureRequirement = { all: [] };

/**
 * 计算一个 /api/media-studio 请求的授权要求。
 * path 是挂载点之后的相对路径(express 中间件里的 req.path,如
 * `/wechat-mp/articles` 或 `/handoff`)。{all:[]} = 放行。
 */
export function requiredFeaturesFor(method: string, reqPath: string, body?: unknown): FeatureRequirement {
  const parts = reqPath.split('/').filter(Boolean);
  if (parts.length === 0) return NONE;
  const head = parts[0]!;

  // 全局段:资产/无状态排版 放行;handoff 只拦创建。
  if (head === 'assets' || head === 'render') return NONE;
  if (head === 'browser') {
    // browser/open 按目标平台拦(body.platform,anyOf);urls 放行。
    if (parts[1] === 'open' && method === 'POST') {
      const platform = String((body as { platform?: unknown } | undefined)?.platform ?? '');
      const anyOf = handoffTargetFeatures(platform);
      return anyOf.length ? { all: [], anyOf } : NONE;
    }
    return NONE;
  }
  if (head === 'handoff') {
    if (method === 'POST' && parts.length === 1) {
      const target = String((body as { platform?: unknown } | undefined)?.platform ?? '');
      const anyOf = handoffTargetFeatures(target);
      return anyOf.length ? { all: ['cap.handoff'], anyOf } : { all: ['cap.handoff'] };
    }
    return NONE; // claim/progress/complete/wait 是桌面端回写口
  }

  // 平台段:/:platform/...
  // 知识库全平台共享(2026-07-16 拆分个人库/企业库):持有任一 kb.* 即放行。
  if (parts[1] === 'knowledge') return { all: [], anyOf: ['kb.personal', 'kb.enterprise'] };
  if (parts[1] === 'skins') return NONE; // 皮肤列表只读元数据

  const all: FeatureId[] = [];
  let anyOf: FeatureId[] | undefined;
  const articleFeat = articleFeatureOf(head);
  if (articleFeat) all.push(articleFeat);
  else if (head === 'short-video') anyOf = SV_FEATURES; // studio 级:任一短视频平台
  else if (head === 'note') all.push('note.xiaohongshu');
  else return NONE; // 未知平台不锁死(未来平台默认放行)

  const tail = parts[parts.length - 1]!;
  if (tail === 'ai-task') all.push('cap.ai');
  if (tail === 'images') all.push('cap.image');
  if (tail === 'tts') all.push('cap.tts');
  if (tail === 'publish' || tail === 'publish-note' || tail === 'publish-video') all.push('cap.publish');
  return anyOf ? { all, anyOf } : { all };
}

/** 到期锁定放行的只读方法。 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** /api/media-studio 强制中间件。none=全放行;invalid 按最严(全锁写)处理。 */
export function licenseGuard(ref: LicenseStateRef) {
  return (req: Request, res: Response, next: NextFunction) => {
    const state = ref.current;
    if (state.status === 'none') return next();
    if (state.status === 'expired' || state.status === 'invalid') {
      if (READ_METHODS.has(req.method)) return next(); // 锁功能留数据
      return res.status(403).json({
        error: {
          code: state.status === 'expired' ? 'LICENSE_EXPIRED' : 'LICENSE_INVALID',
          message:
            state.status === 'expired'
              ? '套餐已到期——功能已锁定(数据仍可查看导出),请联系服务商续费'
              : `授权无效:${state.reason ?? '未知原因'}——请联系服务商`,
        },
      });
    }
    const req_ = requiredFeaturesFor(req.method, req.path, req.body);
    const missingAll = req_.all.filter((f) => !state.features.has(f));
    const anyOfUnmet = Boolean(req_.anyOf?.length) && !req_.anyOf!.some((f) => state.features.has(f));
    if (missingAll.length === 0 && !anyOfUnmet) return next();
    const missing = [...missingAll, ...(anyOfUnmet ? req_.anyOf! : [])];
    return res.status(403).json({
      error: {
        code: 'FEATURE_NOT_LICENSED',
        message: '该功能未包含在您的套餐中——如需开通请联系服务商',
        data: { missing },
      },
    });
  };
}
