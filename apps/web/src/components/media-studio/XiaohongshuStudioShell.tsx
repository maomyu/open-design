// 「小红书」平台入口外壳(2026-07-17 用户拍板:平台一级导航;小红书本身既有
// 图文笔记又有视频,归一个入口、顶部形态切换)。
//
// 形态切换是外壳内部状态(localStorage 记忆),不走路由——标签栏只有一个
// 「小红书」标签。两个子台各自完整:
//   图文笔记 = NoteStudioView(note 池,发布走 sau upload-note)
//   视频     = ShortVideoStudioView platform=xiaohongshu(short-video 池按子平台过滤)
//
// 授权裁剪:note.xiaohongshu 控图文、sv.xiaohongshu 控视频;只授权一种时不渲染
// 切换条(和 ArticleStudioShell 同款行为)。
import { useState } from 'react';
import { NoteStudioView } from './NoteStudioView';
import { ShortVideoStudioView } from './ShortVideoStudioView';
import { hasFeature, hasShortVideoPlatform, useLicense } from '../../state/license';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

type XhsForm = 'note' | 'video';
const STORE_KEY = 'open-design:studio:xiaohongshu-form';

export function XiaohongshuStudioShell(): JSX.Element {
  const license = useLicense();
  const forms: Array<{ id: XhsForm; label: string; licensed: boolean }> = [
    { id: 'note', label: '图文笔记', licensed: hasFeature(license, 'note.xiaohongshu') },
    { id: 'video', label: '视频', licensed: hasShortVideoPlatform(license, 'xiaohongshu') },
  ];
  const licensed = forms.filter((f) => f.licensed);
  const allowed = (id: string | null | undefined): id is XhsForm => licensed.some((f) => f.id === id);
  const [form, setForm] = useState<XhsForm>(() => {
    const saved = window.localStorage.getItem(STORE_KEY);
    if (allowed(saved)) return saved;
    return licensed[0]?.id ?? 'note';
  });
  const pick = (id: XhsForm) => {
    setForm(id);
    window.localStorage.setItem(STORE_KEY, id);
  };
  const effective = allowed(form) ? form : (licensed[0]?.id ?? 'note');
  return (
    <div className={c('articleShell')}>
      {licensed.length > 1 ? (
        <div className={c('articleSwitch')}>
          <span className={c('articleSwitchLabel')}>内容形态</span>
          {licensed.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`${c('articleSwitchBtn')}${f.id === effective ? ` ${c('articleSwitchBtnActive')}` : ''}`}
              aria-pressed={f.id === effective}
              onClick={() => pick(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
      {/* 子台各自维护当前稿/自动保存;切形态=卸载重挂,各台 localStorage 记忆位置。 */}
      {effective === 'note' ? <NoteStudioView /> : <ShortVideoStudioView platform="xiaohongshu" />}
    </div>
  );
}
