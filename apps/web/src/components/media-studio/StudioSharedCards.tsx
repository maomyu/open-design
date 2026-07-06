// 创作台共享卡片：版本历史（后悔药）/ 知识库（客户挂载资料）/ 文章列表。
// 两个创作台（公众号/短视频）都用；文案内联（客户定制，纯中文交付）。
import { useEffect, useState } from 'react';
import type { MediaArticle, MediaArticleSummary, MediaArticleVersion, MediaKnowledge } from '@open-design/contracts';
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

export function KnowledgePanel({
  platform,
  accounts,
}: {
  platform: string;
  /** 可选：账号列表（公众号有账号概念；短视频传空数组）。 */
  accounts: Array<{ id: string; name: string }>;
}): JSX.Element {
  const [items, setItems] = useState<MediaKnowledge[]>([]);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [accountId, setAccountId] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void fetchStudioKnowledge(platform).then(setItems);
  }, [platform]);

  return (
    <>
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          挂载新资料
          <span className={c('cardHint')}>产品资料/品牌口径/行业素材——AI 选题和写作时会自动带上（每条截取前 2000 字）</span>
        </div>
        <div className={c('row')}>
          <input
            className={`${c('input')} ${c('grow')}`}
            value={name}
            placeholder="资料名称，例：产品价格与套餐口径"
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
          className={`${c('textarea')}`}
          style={{ minHeight: 140 }}
          value={content}
          placeholder="粘贴资料内容（markdown/纯文本都行）…"
          onChange={(e) => setContent(e.target.value)}
        />
        <div className={c('row')}>
          <button
            type="button"
            className={`${c('btn')} ${c('btnPrimary')}`}
            disabled={!name.trim() || !content.trim()}
            onClick={async () => {
              const created = await createStudioKnowledge(platform, {
                name: name.trim(),
                contentMd: content,
                ...(accountId ? { accountId } : {}),
              });
              if (created) {
                setItems((list) => [created, ...list]);
                setName('');
                setContent('');
                setNotice(`「${created.name}」已挂载`);
              }
            }}
          >
            挂载
          </button>
          {notice ? <span className={c('saveHint')}>{notice}</span> : null}
        </div>
      </div>
      <div className={c('card')}>
        <div className={c('cardLabel')}>已挂载（{items.length}）</div>
        {items.length === 0 ? (
          <div className={c('cardHint')}>还没有资料。挂上第一条，AI 的产出就会贴着你的事实和口径走。</div>
        ) : (
          <div className={c('records')}>
            {items.map((k) => (
              <div key={k.id} className={c('record')}>
                <strong>{k.name}</strong>
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
              </div>
            ))}
          </div>
        )}
      </div>
    </>
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
  hasAssets,
  onMarked,
}: {
  studioPlatform: string;
  articleId: string;
  articleTitle: string;
  targets: Array<{ id: string; label: string }>;
  defaultTarget?: string;
  /** 按目标平台生成要粘贴的文案（标题/正文/标签的平台化格式）。 */
  copyText: (targetId: string) => string;
  /** 有没有可打开的图集/资产目录。 */
  hasAssets: boolean;
  onMarked: () => void;
}): JSX.Element {
  const [target, setTarget] = useState(defaultTarget ?? targets[0]?.id ?? '');
  const [account, setAccount] = useState('main');
  const [done, setDone] = useState<{ copy: boolean; assets: boolean; browser: boolean }>({
    copy: false,
    assets: false,
    browser: false,
  });
  const [note, setNote] = useState('');
  const targetLabel = targets.find((t) => t.id === target)?.label ?? target;

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
        <input
          className={c('input')}
          style={{ width: 130 }}
          value={account}
          title="账号档案名——同平台多账号用不同名字，浏览器档案互相隔离"
          onChange={(e) => setAccount(e.target.value)}
        />
      </div>
      <div className={c('row')}>
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
        <button
          type="button"
          className={c('btn')}
          disabled={!hasAssets}
          title={hasAssets ? '' : '还没有图片/资产'}
          onClick={async () => {
            if (await revealStudioAssets(studioPlatform, articleId)) {
              setDone((d) => ({ ...d, assets: true }));
              setNote('图集文件夹已打开——直接拖进浏览器发布页');
            }
          }}
        >
          {done.assets ? '✓ ' : '② '}打开图集文件夹
        </button>
        <button
          type="button"
          className={`${c('btn')} ${c('btnPrimary')}`}
          onClick={async () => {
            const result = await openStudioBrowser({ platform: target, account: account.trim() || 'main' });
            if (result.error) setNote(result.error);
            else {
              setDone((d) => ({ ...d, browser: true }));
              setNote(`已打开「${targetLabel}」专属浏览器（档案 ${account.trim() || 'main'}）——首次需登录一次，之后长期保持`);
            }
          }}
        >
          {done.browser ? '✓ ' : '③ '}打开专属浏览器
        </button>
        <button
          type="button"
          className={c('btn')}
          onClick={async () => {
            const result = await markStudioPublished(studioPlatform, articleId, `${targetLabel}（${account.trim() || 'main'}）`);
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
