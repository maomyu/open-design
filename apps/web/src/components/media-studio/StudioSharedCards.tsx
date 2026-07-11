// 创作台共享卡片：版本历史（后悔药）/ 知识库（客户挂载资料）/ 文章列表。
// 两个创作台（公众号/短视频）都用；文案内联（客户定制，纯中文交付）。
import { useEffect, useState } from 'react';
import type { MediaArticle, MediaArticleSummary, MediaArticleVersion, MediaKnowledge } from '@open-design/contracts';
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import { navigate } from '../../router';
import { draftInjectionSupported, type DraftPayload } from '../../runtime/browser-draft';
import { Icon } from '../Icon';
import {
  createStudioKnowledge,
  deleteStudioKnowledge,
  fetchStudioKnowledge,
  fetchStudioVersions,
  markStudioPublished,
  openStudioBrowser,
  restoreStudioVersion,
  revealStudioAssets,
  saveStudioVersion,
} from '../../providers/media-studio';
import { studioToast } from './StudioFeedback';
import { hasFeature, useLicense } from '../../state/license';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

function timeLabel(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- 版本历史 ----

export function VersionsCard({
  platform,
  article,
  onRestored,
}: {
  platform: string;
  article: MediaArticle;
  onRestored: (a: MediaArticle) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<MediaArticleVersion[]>([]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open) return;
    void fetchStudioVersions(platform, article.id).then(setVersions);
  }, [open, platform, article.id, article.updatedAt]);

  return (
    <div className={c('card')}>
      <button type="button" className={c('cardLabel')} style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0 }} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        历史版本
        <span className={c('cardHint')}>AI 改动前都会自动存档——改坏了随时回退</span>
      </button>
      {open ? (
        <>
          <div className={c('row')}>
            <button
              type="button"
              className={c('btn')}
              onClick={async () => {
                if (await saveStudioVersion(platform, article.id, '手动存档')) {
                  setVersions(await fetchStudioVersions(platform, article.id));
                  setNotice('已存档当前版本');
                }
              }}
            >
              存档当前版本
            </button>
            {notice ? <span className={c('saveHint')}>{notice}</span> : null}
          </div>
          {versions.length === 0 ? (
            <div className={c('cardHint')}>还没有版本——点一次 AI 动作或手动存档就有了。</div>
          ) : (
            <div className={c('records')}>
              {versions.map((v) => (
                <div key={v.id} className={c('record')}>
                  <span className={c('recordTime')}>{timeLabel(v.createdAt)}</span>
                  <span>{v.label}</span>
                  <span className={c('cardHint')}>正文 {v.bodyMd.replace(/\s+/g, '').length} 字</span>
                  <span className={c('headSpacer')} />
                  <button
                    type="button"
                    className={c('btn')}
                    onClick={async () => {
                      if (!window.confirm(`回退到「${v.label}」（${timeLabel(v.createdAt)}）？当前内容会先自动存档。`)) return;
                      const restored = await restoreStudioVersion(platform, article.id, v.id);
                      if (restored) {
                        onRestored(restored);
                        setVersions(await fetchStudioVersions(platform, article.id));
                        setNotice('已回退（回退前的内容也存了档）');
                      }
                    }}
                  >
                    回退
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

// ---- 知识库 ----

/** 公司知识库分类目录——按经营维度组织，AI 写作时按各类用途注入。 */
const KNOWLEDGE_CATEGORIES: Array<{ id: string; label: string; hint: string; placeholder: string }> = [
  { id: 'company', label: '公司介绍', hint: '我们是谁——定位、团队、发展历程、资质背景', placeholder: '例：公司成立于 20XX 年，专注于……团队规模/核心成员/办公地点……' },
  { id: 'product', label: '产品/服务', hint: '卖什么——功能、服务流程、套餐口径', placeholder: '例：核心服务包含哪几档、各自适合谁、服务流程是什么……' },
  { id: 'trust', label: '信任背书', hint: '为什么信我们——资质、奖项、数据、媒体报道', placeholder: '例：行业资质认证、服务客户数量、成功率数据、获奖记录……' },
  { id: 'case', label: '合作案例', hint: '做成过什么——客户故事、成果数据', placeholder: '例：某客户合作背景 → 我们做了什么 → 结果数据……' },
  { id: 'card', label: 'AI 名片', hint: '对外话术——一句话介绍、联系方式、文末 CTA 口径', placeholder: '例：文末引导语固定话术、联系方式的表述方式、品牌一句话介绍……' },
  { id: 'other', label: '其他', hint: '行业素材、口径备忘等不好归类的资料', placeholder: '粘贴任意背景资料（markdown/纯文本都行）……' },
];

export function KnowledgePanel({
  platform,
  accounts,
}: {
  platform: string;
  /** 账号范围下拉的候选（全局页汇总全平台账号并标平台名）。 */
  accounts: Array<{ id: string; name: string }>;
}): JSX.Element {
  const [items, setItems] = useState<MediaKnowledge[]>([]);
  // 左右布局(2026-07-08 用户拍板):左列分类目录,右列当前分类的说明/表单/条目。
  const [activeCat, setActiveCat] = useState(KNOWLEDGE_CATEGORIES[0]!.id);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [accountId, setAccountId] = useState('');
  // 点条目名展开/收起全文（右列空间足够，看全文不用进别的页面）。
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    void fetchStudioKnowledge(platform).then(setItems);
  }, [platform]);

  const catOf = (k: MediaKnowledge) => ((k as { category?: string }).category || 'other');
  const cat = KNOWLEDGE_CATEGORIES.find((x) => x.id === activeCat) ?? KNOWLEDGE_CATEGORIES[0]!;
  const group = items.filter((k) => catOf(k) === cat.id);

  const pickCat = (id: string) => {
    setActiveCat(id);
    setAdding(false);
    setExpandedId(null);
  };

  const openAdd = () => {
    setAdding(true);
    setName('');
    setContent('');
    setAccountId('');
  };

  const submit = async () => {
    if (!name.trim() || !content.trim()) return;
    const created = await createStudioKnowledge(platform, {
      name: name.trim(),
      contentMd: content,
      category: cat.id,
      ...(accountId ? { accountId } : {}),
    });
    if (created) {
      setItems((list) => [created, ...list]);
      setAdding(false);
      studioToast.ok(`「${created.name}」已挂载`);
    }
  };

  return (
    <div className={c('kbLayout')}>
      <nav className={c('kbSide')} aria-label="知识库分类">
        {KNOWLEDGE_CATEGORIES.map((x) => {
          const n = items.filter((k) => catOf(k) === x.id).length;
          return (
            <button
              key={x.id}
              type="button"
              className={`${c('kbSideItem')}${x.id === activeCat ? ` ${c('kbSideItemActive')}` : ''}`}
              aria-current={x.id === activeCat ? 'true' : undefined}
              onClick={() => pickCat(x.id)}
            >
              {x.label}
              <span className={c('kbCount')}>{n}</span>
            </button>
          );
        })}
      </nav>
      <div className={c('kbMain')}>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            {cat.label}（{group.length}）
            <span className={c('cardHint')}>{cat.hint}</span>
            <span className={c('headSpacer')} />
            <button type="button" className={c('btn')} onClick={() => (adding ? setAdding(false) : openAdd())}>
              <Icon name="plus" size={13} /> 添加
            </button>
          </div>
          {adding ? (
            <>
              <div className={c('row')}>
                <input
                  className={`${c('input')} ${c('grow')}`}
                  value={name}
                  placeholder={`资料名称，例：${cat.label}-核心口径`}
                  onChange={(e) => setName(e.target.value)}
                />
                {accounts.length > 0 ? (
                  <select className={c('select')} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    <option value="">全部账号可用</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        仅 {a.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              <textarea
                className={c('textarea')}
                style={{ minHeight: 120 }}
                value={content}
                placeholder={cat.placeholder}
                onChange={(e) => setContent(e.target.value)}
              />
              <div className={c('row')}>
                <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} disabled={!name.trim() || !content.trim()} onClick={() => void submit()}>
                  挂载
                </button>
                <button type="button" className={c('btn')} onClick={() => setAdding(false)}>
                  取消
                </button>
              </div>
            </>
          ) : null}
          {group.length === 0 && !adding ? (
            <div className={c('cardHint')}>还没有{cat.label}资料——点右上「添加」挂上第一条。</div>
          ) : (
            <div className={c('records')}>
              {group.map((k) => (
                <div key={k.id} className={c('record')}>
                  <button
                    type="button"
                    className={c('kbItemName')}
                    title={expandedId === k.id ? '收起全文' : '查看全文'}
                    onClick={() => setExpandedId((cur) => (cur === k.id ? null : k.id))}
                  >
                    <Icon name={expandedId === k.id ? 'chevron-down' : 'chevron-right'} size={12} />
                    {k.name}
                  </button>
                  <span className={c('cardHint')}>
                    {k.contentMd.replace(/\s+/g, '').length} 字
                    {k.accountId ? ` · 仅 ${accounts.find((a) => a.id === k.accountId)?.name ?? '指定账号'}` : ' · 全部账号'}
                  </span>
                  <span className={c('headSpacer')} />
                  <button
                    type="button"
                    className={`${c('btn')} ${c('btnDanger')}`}
                    onClick={async () => {
                      if (!window.confirm(`删除资料「${k.name}」？`)) return;
                      if (await deleteStudioKnowledge(platform, k.id)) {
                        setItems((list) => list.filter((x) => x.id !== k.id));
                      }
                    }}
                  >
                    删除
                  </button>
                  {expandedId === k.id ? <div className={c('kbItemBody')}>{k.contentMd}</div> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- 文章列表 ----

export function ArticleListCard({
  articles,
  statusLabel,
  accountNameOf,
  onOpen,
  onDelete,
  onCreate,
}: {
  articles: MediaArticleSummary[];
  statusLabel: (s: MediaArticleSummary['status']) => { text: string; chip: string };
  accountNameOf?: (accountId: string | null) => string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const filtered = query.trim()
    ? articles.filter((a) => (a.title + (a.topic ?? '')).toLowerCase().includes(query.trim().toLowerCase()))
    : articles;
  return (
    <div className={c('card')}>
      <div className={c('cardLabel')}>
        全部作品（{articles.length}）
        <span className={c('headSpacer')} />
        <input
          className={c('input')}
          style={{ width: 200 }}
          value={query}
          placeholder="搜标题/选题…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={onCreate}>
          <Icon name="plus" size={14} /> 新建
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className={c('cardHint')}>{query ? '没有匹配的作品。' : '还没有作品。'}</div>
      ) : (
        <table className={c('table')}>
          <thead>
            <tr>
              <th>标题</th>
              <th>状态</th>
              {accountNameOf ? <th>账号</th> : null}
              <th>更新时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => {
              const s = statusLabel(a.status);
              return (
                <tr key={a.id}>
                  <td>
                    <button type="button" className={c('link')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left' }} onClick={() => onOpen(a.id)}>
                      {a.title || '(未命名)'}
                    </button>
                  </td>
                  <td>
                    <span className={`${c('chip')} ${c(s.chip)}`}>{s.text}</span>
                  </td>
                  {accountNameOf ? <td>{accountNameOf(a.accountId)}</td> : null}
                  <td className={c('recordTime')}>{timeLabel(a.updatedAt)}</td>
                  <td className={c('tdActions')}>
                    <button type="button" className={c('btn')} onClick={() => onOpen(a.id)}>
                      打开
                    </button>{' '}
                    <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => onDelete(a.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- 安全发布（手动交接·防风控） ----
//
// 自动化发布在小红书等平台有风控风险；最稳的方式是在「平台×账号」专属的
// 真实浏览器档案里手动粘贴+拖图发布（零自动化指纹、登录态长期保存）。
// 这张卡把手动流程可视化成四步：复制文案 → 打开图集 → 打开专属浏览器 →
// 回来标记，全程 10 秒级操作。
export function SafeHandoffCard({
  studioPlatform,
  articleId,
  articleTitle,
  targets,
  defaultTarget,
  copyText,
  copyParts,
  hasAssets,
  assetsLabel = '图集文件夹',
  requiresAssets = true,
  accountsOf,
  buildDraft,
  oneClickLabel = '一键存草稿',
  allowAutoPublish = false,
  onMarked,
}: {
  studioPlatform: string;
  articleId: string;
  articleTitle: string;
  targets: Array<{ id: string; label: string }>;
  defaultTarget?: string;
  /** 按目标平台生成要粘贴的文案（标题/正文/标签的平台化格式）。 */
  copyText: (targetId: string) => string;
  /** 分段复制：标题/正文/标签各自一键——发布页表单是分字段的，分段粘更顺手。 */
  copyParts?: (targetId: string) => Array<{ label: string; text: string }>;
  /** 有没有可打开的图集/资产目录。 */
  hasAssets: boolean;
  /** 资产按钮文案（默认「图集文件夹」;短视频台传「成片文件夹」）。 */
  assetsLabel?: string;
  /** 一键存草稿是否要求素材就绪(默认 true;知乎等文章类传 false——
   *  正文即全部,无附件)。 */
  requiresAssets?: boolean;
  /** 账号中心是唯一账号来源(2026-07-09 用户拍板):返回目标平台在「账号」页
   *  配置的账号名列表。有账号=下拉绑定(像公众号);没有=引导去添加,不再
   *  出现 'main' 这种内部兜底档案名。 */
  accountsOf: (platformId: string) => string[];
  /** 「一键存草稿」的稿件载荷(2026-07-09 用户拍板:自动填进平台发布页,
   *  免手动上传)。返回 null 表示稿件没准备好(如图集为空)。 */
  buildDraft?: (targetId: string) => Promise<DraftPayload | null>;
  /** 一键按钮文案覆盖(缺省「一键存草稿」;微博无草稿箱→「一键填发布框」)。 */
  oneClickLabel?: string;
  /** 一键发布(2026-07-10 用户授权):允许直发的平台传 true,显示「一键
   *  发布」按钮(自动填稿+点平台发布/发送键)。不可逆,带内联二次确认。 */
  allowAutoPublish?: boolean;
  onMarked: () => void;
}): JSX.Element {
  const license = useLicense();
  const [target, setTarget] = useState(defaultTarget ?? targets[0]?.id ?? '');
  const [account, setAccount] = useState('');
  const [done, setDone] = useState<{ copy: boolean; assets: boolean; browser: boolean }>({
    copy: false,
    assets: false,
    browser: false,
  });
  const [note, setNote] = useState('');
  const targetLabel = targets.find((t) => t.id === target)?.label ?? target;
  const targetAccounts = accountsOf(target);
  // 选中账号:显式选择 > 该平台第一个账号。平台切换后失效的选择自动回落。
  const effectiveAccount = targetAccounts.includes(account) ? account : targetAccounts[0] ?? '';
  const hasAccount = effectiveAccount !== '';

  return (
    <div className={c('card')}>
      <div className={c('cardLabel')}>
        安全发布（推荐 · 防风控）
        <span className={c('cardHint')}>在你自己的专属浏览器里手动存草稿/发布——零自动化指纹，多账号档案隔离</span>
      </div>
      <div className={c('row')}>
        <select className={c('select')} value={target} onChange={(e) => { setTarget(e.target.value); setDone({ copy: false, assets: false, browser: false }); }}>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {hasAccount ? (
          <select
            className={c('select')}
            value={effectiveAccount}
            title="发布用哪个账号——浏览器档案按账号隔离,登录态互不干扰"
            onChange={(e) => setAccount(e.target.value)}
          >
            {targetAccounts.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <>
            <span className={c('cardHint')}>还没有{targetLabel}账号</span>
            <button
              type="button"
              className={c('btn')}
              onClick={() => navigate({ kind: 'home', view: 'accounts' })}
            >
              去「账号」页添加
            </button>
          </>
        )}
      </div>
      <div className={c('row')}>
        {/* 一键存草稿(2026-07-09 用户拍板):自动把稿件填进平台发布页并点
            「存草稿」——上传/标题/正文全自动,绝不碰「发布」。文案先上剪贴板
            兜底,注入失败随时手动接手。仅桌面端+支持的平台显示。 */}
        {buildDraft && draftInjectionSupported(target) && isOpenDesignHostBrowserAvailable() && hasFeature(license, 'cap.handoff') ? (
          <button
            type="button"
            className={`${c('btn')} ${c('btnPrimary')}`}
            disabled={!hasAccount || (requiresAssets && !hasAssets)}
            title={
              !hasAccount
                ? `先去「账号」页添加${targetLabel}账号`
                : requiresAssets && !hasAssets
                  ? '稿件素材还没就绪'
                  : '自动填好标题正文并存草稿——发布永远由你自己点'
            }
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(copyText(target));
              } catch {
                /* 剪贴板兜底失败不阻断 */
              }
              const draft = await buildDraft(target);
              if (!draft) {
                setNote('稿件没准备好——检查图集/成片后再试');
                return;
              }
              const result = await openStudioBrowser({ platform: target, account: effectiveAccount, draft });
              if (result.error) setNote(result.error);
              else {
                setDone((d) => ({ ...d, browser: true }));
                setNote(`已开始自动填稿——看「${targetLabel}」面板顶部的进度条;填完记得回来点 ④ 标记完成`);
              }
            }}
          >
            <Icon name="sparkles" size={13} /> {oneClickLabel}
          </button>
        ) : null}
        {/* 一键发布(2026-07-10 用户授权,点一次直发无确认):自动填稿+真实
            点击平台发布/发送键。 */}
        {buildDraft && allowAutoPublish && draftInjectionSupported(target) && isOpenDesignHostBrowserAvailable() && hasFeature(license, 'cap.handoff') ? (
          <button
            type="button"
            className={c('btn')}
            disabled={!hasAccount || (requiresAssets && !hasAssets)}
            title={
              !hasAccount
                ? `先去「账号」页添加${targetLabel}账号`
                : '自动填稿后直接点平台的发布键，全自动公开'
            }
            onClick={async () => {
              const draft = await buildDraft(target);
              if (!draft) {
                setNote('稿件没准备好——检查后再试');
                return;
              }
              const result = await openStudioBrowser({ platform: target, account: effectiveAccount, draft: { ...draft, autoPublish: true } });
              if (result.error) setNote(result.error);
              else setNote(`已开始自动发布——看「${targetLabel}」面板顶部进度条到底`);
            }}
          >
            <Icon name="send" size={13} /> 一键发布
          </button>
        ) : null}
        <button
          type="button"
          className={c('btn')}
          disabled={!hasAccount}
          title={hasAccount ? '' : `先去「账号」页添加${targetLabel}账号`}
          onClick={async () => {
            let copied = false;
            try {
              await navigator.clipboard.writeText(copyText(target));
              copied = true;
            } catch {
              /* 剪贴板未授权:继续开后台,提示里说明 */
            }
            const revealed = hasAssets ? await revealStudioAssets(studioPlatform, articleId) : false;
            const result = await openStudioBrowser({ platform: target, account: effectiveAccount });
            if (result.error) {
              setNote(result.error);
              return;
            }
            setDone({ copy: copied, assets: revealed, browser: true });
            setNote(
              copied
                ? `已就绪:文案在剪贴板${revealed ? '、图集文件夹已打开' : ''}——到「${targetLabel}」标签里粘贴${revealed ? '+拖图' : ''},存草稿或发布`
                : `后台已打开;剪贴板未授权,用下面「复制文案」再粘贴`,
            );
          }}
        >
          <Icon name="sparkles" size={13} /> 一键带稿开后台
        </button>
        <button
          type="button"
          className={c('btn')}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(copyText(target));
              setDone((d) => ({ ...d, copy: true }));
              setNote('文案已复制——到浏览器里直接粘贴');
            } catch {
              setNote('复制失败——浏览器未授权剪贴板');
            }
          }}
        >
          {done.copy ? '✓ ' : '① '}复制文案
        </button>
        {copyParts
          ? copyParts(target).map((part) =>
              part.text.trim() ? (
                <button
                  key={part.label}
                  type="button"
                  className={c('btn')}
                  title={`只复制${part.label}——发布页表单分字段粘贴更顺手`}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(part.text);
                      setNote(`${part.label}已复制`);
                    } catch {
                      setNote('复制失败——浏览器未授权剪贴板');
                    }
                  }}
                >
                  {part.label}
                </button>
              ) : null,
            )
          : null}
        <button
          type="button"
          className={c('btn')}
          disabled={!hasAssets}
          title={hasAssets ? '' : '还没有可打开的文件'}
          onClick={async () => {
            if (await revealStudioAssets(studioPlatform, articleId)) {
              setDone((d) => ({ ...d, assets: true }));
              setNote(`${assetsLabel}已打开——直接拖进浏览器发布页`);
            }
          }}
        >
          {done.assets ? '✓ ' : '② '}打开{assetsLabel}
        </button>
        <button
          type="button"
          className={c('btn')}
          disabled={!hasAccount}
          title={hasAccount ? '' : `先去「账号」页添加${targetLabel}账号`}
          onClick={async () => {
            const result = await openStudioBrowser({ platform: target, account: effectiveAccount });
            if (result.error) setNote(result.error);
            else {
              setDone((d) => ({ ...d, browser: true }));
              setNote(`已打开「${targetLabel} · ${effectiveAccount}」专属浏览器——首次需登录一次，之后长期保持`);
            }
          }}
        >
          {done.browser ? '✓ ' : '③ '}打开专属浏览器
        </button>
        <button
          type="button"
          className={c('btn')}
          onClick={async () => {
            const result = await markStudioPublished(studioPlatform, articleId, hasAccount ? `${targetLabel}（${effectiveAccount}）` : targetLabel);
            if (result.record) {
              setNote(`「${articleTitle || '本篇'}」已标记发布——发布记录可查`);
              onMarked();
            }
          }}
        >
          ④ 我已存草稿/发布，标记完成
        </button>
      </div>
      {note ? <span className={c('cardHint')}>{note}</span> : null}
    </div>
  );
}
