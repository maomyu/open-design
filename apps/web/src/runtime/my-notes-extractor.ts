// 「我的笔记」抓取脚本(桌面端 webview 里读账号自己主页的已发笔记)。
//
// 流程:登录态主站进 → 找到【本人主页】链接(不是信息流里别人的)→ 进主页 → 滚动加载 → 抓笔记卡。
// 关键:必须留【带 xsec_token 的完整链接】——裸 /explore/<id> 直连会撞小红书反爬(300031),
// 读评论/互动都要它。选择器按小红书实机校准(与探索页笔记卡同构)。
// 目前仅小红书;知乎/微博接入互动执行器(W9/W10)时再各自加。

export const MY_NOTES_HOME: Record<string, string> = {
  xiaohongshu: 'https://www.xiaohongshu.com',
};

// 从登录态主站找到【本人主页】URL。优先侧栏/顶栏的「我」入口(href 指向本人 /user/profile/<自己id>),
// 避开信息流里其他用户的 profile 链接。返回本人主页 URL 或 ''(判为未登录)。
export const SELF_PROFILE_FINDER = `(() => {
  try {
    const pick = (el) => el && el.getAttribute('href') ? el.href : '';
    // 1) 侧栏「我」导航项(文本恰为「我」且是 profile 链接)
    for (const a of document.querySelectorAll('a[href*="/user/profile/"]')) {
      const t = (a.textContent || '').trim();
      if (t === '我' || t === '我的' || a.querySelector('.reds-avatar, img')) return pick(a);
    }
    // 2) 侧栏容器里的第一个 profile 链接(侧栏基本只有本人)
    const side = document.querySelector('.side-bar, [class*="sidebar" i], [class*="side-bar" i]');
    const sideA = side && side.querySelector('a[href*="/user/profile/"]');
    if (sideA) return pick(sideA);
    // 3) 兜底:页面第一个 profile 链接(可能误取信息流用户,靠后续主页判空兜底)
    const any = document.querySelector('a[href*="/user/profile/"]');
    return any ? pick(any) : '';
  } catch (e) { return ''; }
})()`;

// 主页已发笔记抓取。首选【页面 JS 状态 __INITIAL_STATE__】——里面每条笔记都带 xsecToken,能拼出
// 可直接读评论的完整链接(实机确认:DOM 里的 a[href] 是【裸链无 token】,直连会 404/反爬,不可用)。
// 递归找任何带 {id/noteId + xsecToken} 的节点(小红书把它包在 Vue ref/嵌套数组里,故用带环保护的
// 深走),拼 /explore/<id>?xsec_token=...&xsec_source=pc_user。JS 状态拿不到时回退扫 DOM 带 token 的卡。
export const MY_NOTES_EXTRACTOR = `(() => {
  const out = [], seenId = new Set();
  // ① 首选:递归 __INITIAL_STATE__ 找带 token 的笔记(最稳、拿得全)。
  try {
    const seenObj = new WeakSet();
    const visit = (o, d) => {
      if (!o || typeof o !== 'object' || d > 10 || seenObj.has(o)) return;
      seenObj.add(o);
      const id = o.noteId || o.id, tok = o.xsecToken;
      if (typeof id === 'string' && id.length >= 16 && typeof tok === 'string' && tok && !seenId.has(id)) {
        const nc = o.noteCard || o.note || o;
        const title = ((nc.displayTitle || nc.title || o.displayTitle || o.title || '') + '').slice(0, 90);
        seenId.add(id);
        out.push({ noteId: id, title, url: 'https://www.xiaohongshu.com/explore/' + id + '?xsec_token=' + encodeURIComponent(tok) + '&xsec_source=pc_user' });
      }
      for (const k in o) { try { visit(o[k], d + 1); } catch (e) {} }
    };
    visit(window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user, 0);
  } catch (e) {}
  if (out.length) return out;
  // ② 回退:DOM 里带 xsec_token 的笔记卡(拿不到 JS 状态时;裸链的跳过,直连没用)。
  document.querySelectorAll('a[href*="/explore/"]').forEach((a) => {
    const m = a.href.match(/\\/explore\\/([0-9a-zA-Z]+)/);
    if (!m || seenId.has(m[1]) || !/xsec_token=/.test(a.href)) return;
    const card = a.closest('section, .note-item, [class*="note" i]') || a.parentElement || a;
    const title = (card.querySelector('.title, .footer .title, .content, span')?.innerText || a.innerText || '').trim().slice(0, 90);
    if (!title) return;
    seenId.add(m[1]);
    out.push({ noteId: m[1], title, url: a.href });
  });
  return out;
})()`;
