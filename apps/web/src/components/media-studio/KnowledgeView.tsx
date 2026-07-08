// 公司知识库 — 左侧导航一级入口（2026-07-08 用户拍板）。
// 知识库是公司级资产：一处维护，公众号/短视频/笔记三个创作台的 AI 任务
// 全部共用同一份（daemon 侧统一存查 platform='global'）。分类卡片式管理
// 复用 KnowledgePanel；本页只负责页面外壳 + 汇总全平台账号供「账号范围」
// 下拉（多品牌公司可把某条资料限定给某个账号用）。
import { useEffect, useState } from 'react';
import { fetchPlatformAccounts } from '../../providers/daemon';
import { KnowledgePanel } from './StudioSharedCards';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/** 账号范围下拉里给账号名标平台，跨平台同名账号不混淆。 */
const PLATFORM_LABEL: Record<string, string> = {
  'wechat-mp': '公众号',
  douyin: '抖音',
  xiaohongshu: '小红书',
};

export function KnowledgeView(): JSX.Element {
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    void fetchPlatformAccounts().then((resp) => {
      if (!resp) return;
      setAccounts(
        resp.platforms.flatMap((p) =>
          p.accounts.map((a) => ({
            id: a.id,
            name: `${PLATFORM_LABEL[p.id] ?? p.id}·${a.name}`,
          })),
        ),
      );
    });
  }, []);

  return (
    <div className={c('root')}>
      <div className={c('head')}>
        <h1 className={c('title')}>公司知识库</h1>
        <span className={c('cardHint')}>
          一处维护，公众号 / 短视频 / 笔记所有创作台的 AI 共用——选题/写作时按各类用途自动使用（背书增强说服力、名片用于文末 CTA）
        </span>
      </div>
      <div className={c('main')}>
        <div className={c('editorCol')}>
          <KnowledgePanel platform="global" accounts={accounts} />
        </div>
      </div>
    </div>
  );
}
