// 生图风格示例网格(2026-07-17 用户要求:风格不能只有标题,要直观看到长啥样)。
// 样图为同一主题(咖啡/生活方式)按各风格真实生成后打包的静态资源
// (public/style-samples/<id>.jpg,3:4 缩略图),点图即选中该风格。
// 「不用模板」无样图(画风由提示词决定);某风格样图缺失时自动隐藏该卡片。
import { useState, type JSX } from 'react';
import { IMAGE_STYLE_PRESETS } from '@open-design/contracts';

export function ImageStyleSamples({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const items = IMAGE_STYLE_PRESETS.filter((s) => s.id !== 'none' && !broken[s.id]);
  return (
    <div style={{ margin: '4px 0' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: 12, color: 'var(--od-accent, #2b7)', textDecoration: 'underline',
        }}
      >
        {open ? '收起风格示例 ▲' : '看风格示例(点图即选) ▼'}
      </button>
      <span style={{ fontSize: 11.5, opacity: 0.6, marginLeft: 10 }}>
        生成时画风按所选风格动态注入——描述里只写画面内容,不用写画风
      </span>
      {open ? (
        <div
          style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
            gap: 8, marginTop: 8,
          }}
        >
          {items.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              title={`选用「${s.label}」`}
              style={{
                padding: 0, cursor: 'pointer', textAlign: 'center', background: 'none',
                border: value === s.id ? '2px solid var(--od-accent, #2b7)' : '2px solid transparent',
                borderRadius: 8, overflow: 'hidden',
              }}
            >
              <img
                src={`/style-samples/${s.id}.jpg`}
                alt={s.label}
                loading="lazy"
                style={{ width: '100%', aspectRatio: '3/4', objectFit: 'cover', display: 'block', borderRadius: 6 }}
                onError={() => setBroken((b) => ({ ...b, [s.id]: true }))}
              />
              <div style={{ fontSize: 11, lineHeight: 1.3, padding: '3px 2px 4px', opacity: 0.85 }}>
                {s.label.replace(/（.*）/, '')}
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
