// 写作阶段前置选「封面风格 + 正文配图风格」(2026-07-20 用户拍板:风格要在写提示词之前定,
// AI 写配图/封面提示词才对得上,封面/配图生图也直接用)。两个风格分开、按【文章】存(article.extra)。
import { IMAGE_STYLE_PRESETS } from '@open-design/contracts';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

export function ImageStyleUpfront({
  coverStyle,
  imageStyle,
  onCoverChange,
  onImageChange,
}: {
  coverStyle: string;
  imageStyle: string;
  onCoverChange: (v: string) => void;
  onImageChange: (v: string) => void;
}): JSX.Element {
  return (
    <div className={c('card')}>
      <div className={c('cardLabel')}>
        配图风格（写作前先定）
        <span className={c('cardHint')}>
          先选好封面 + 配图风格,AI 写作时就按这个风格构思配图画面,之后封面/配图页直接生图——所见即所得。
        </span>
      </div>
      <div className={c('row')} style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <span className={c('cardHint')} style={{ minWidth: 64 }}>封面风格</span>
        <select className={c('select')} value={coverStyle} onChange={(e) => onCoverChange(e.target.value)} style={{ minWidth: 160 }}>
          {IMAGE_STYLE_PRESETS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <span className={c('cardHint')} style={{ minWidth: 80, marginLeft: 8 }}>正文配图风格</span>
        <select className={c('select')} value={imageStyle} onChange={(e) => onImageChange(e.target.value)} style={{ minWidth: 160 }}>
          {IMAGE_STYLE_PRESETS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
