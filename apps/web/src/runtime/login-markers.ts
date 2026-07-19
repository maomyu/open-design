// 登录态探测标记（W6:桌面端在平台主站判「这个账号还登录着吗」）。
//
// 判据是双向的,避免误报:
//   ·【已失效】= 页面上有【可见的"登录"入口/按钮】(未登录才会显眼地让你登录);
//   ·【仍登录】= 页面上有【头像/个人主页链接/创作入口】这类只有登录后才出现的标记。
// 两者都没有 → 'unknown'(不产告警、不翻转状态,交给下次心跳),宁可漏判也不误报把用户支去补登。
// 选择器按小红书实机校准过一轮;知乎/微博先给通用兜底,接入执行器时再各自校准。

export type LoginProbe = 'logged-in' | 'logged-out' | 'unknown';

/** 登录探测用的平台主站(在这里判登录态最稳:主站永远能开,登录/未登录的顶栏差异最明确)。 */
export const LOGIN_HOME: Record<string, string> = {
  xiaohongshu: 'https://www.xiaohongshu.com/explore',
  zhihu: 'https://www.zhihu.com/',
  weibo: 'https://weibo.com/',
};

// 通用探测脚本:各平台 DOM 不同,但「可见登录按钮=未登录 / 头像·主页链接=已登录」是共性。
// 返回 JSON 串 {state}。附加平台特有的登录后选择器(loggedInSel)与登录入口文案(loginText)。
function buildProbe(loggedInSel: string, loginText: string[]): string {
  const texts = JSON.stringify(loginText);
  const sel = JSON.stringify(loggedInSel);
  return `(() => { try {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity !== 0;
    };
    const loginTexts = ${texts};
    let loginBtn = null;
    for (const el of document.querySelectorAll('button, a, span, div[class*="login" i], [class*="Login"]')) {
      const t = (el.textContent || '').trim();
      if (t.length <= 6 && loginTexts.includes(t) && vis(el)) { loginBtn = el; break; }
    }
    let inHint = null;
    for (const el of document.querySelectorAll(${sel})) { if (vis(el)) { inHint = el; break; } }
    if (inHint && !loginBtn) return JSON.stringify({ state: 'logged-in' });
    if (loginBtn) return JSON.stringify({ state: 'logged-out' });
    if (inHint) return JSON.stringify({ state: 'logged-in' });
    return JSON.stringify({ state: 'unknown' });
  } catch (e) { return JSON.stringify({ state: 'unknown' }); } })()`;
}

/** 平台 → 登录探测脚本(在 <webview> executeJavaScript 里跑,返回 JSON 串 {state})。 */
export const LOGIN_PROBE: Record<string, string> = {
  // 小红书:已登录顶栏有头像(.reds-avatar/.user .avatar)、侧栏个人主页链接(/user/profile/<id>)、
  // 创作入口(creator.xiaohongshu);未登录顶栏是显眼的"登录"按钮。
  xiaohongshu: buildProbe(
    '.reds-avatar, .user .avatar, a[href*="/user/profile/"], a[href*="creator.xiaohongshu"], .side-bar .user',
    ['登录', '登录/注册', '立即登录', '登录 / 注册'],
  ),
  zhihu: buildProbe(
    '.AppHeader-profileAvatar, .Avatar[class*="AppHeader"], a[href*="/people/"], .GlobalWrite-navBtn',
    ['登录', '登录/注册', '登录 / 注册'],
  ),
  weibo: buildProbe(
    '.woo-avatar-img, [class*="Avatar"], a[href*="/u/"], .gn_name',
    ['登录', '立即登录', '登录/注册'],
  ),
};

/** 从探测返回的 JSON 串解析出登录态(坏帧/异常一律 'unknown')。 */
export function parseLoginProbe(raw: unknown): LoginProbe {
  try {
    const v = JSON.parse(String(raw ?? '{}')) as { state?: string };
    return v.state === 'logged-in' || v.state === 'logged-out' ? v.state : 'unknown';
  } catch {
    return 'unknown';
  }
}
