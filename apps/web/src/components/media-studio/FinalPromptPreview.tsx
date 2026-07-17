// 最终生图提示词·实时预览(2026-07-17 用户要求:切换风格时要"看得见"提示词变化)。
// 与 daemon 实发同源:同一个 contracts composeImagePrompt 组装——所见即所发。
import type { JSX } from 'react';
import { composeImagePrompt, IMAGE_STYLE_PRESETS } from '@open-design/contracts';

export function FinalPromptPreview({ style, description }: { style: string; description: string }): JSX.Element {
  const label = IMAGE_STYLE_PRESETS.find((s) => s.id === style)?.label ?? style;
  const finalPrompt = composeImagePrompt(style, description.trim() || '（画面描述待填写）');
  return (
    <div
      style={{
        margin: '4px 0 6px', padding: '6px 8px', borderRadius: 6,
        background: 'var(--od-bg-subtle, rgba(127,127,127,0.08))',
        fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        maxHeight: 96, overflowY: 'auto', opacity: 0.85,
      }}
      title="实际发给生图模型的完整提示词(切换风格实时变化)"
    >
      <span style={{ fontWeight: 600 }}>最终提示词(实发·随风格实时变)· {label}</span>
      {'\n'}
      {finalPrompt}
    </div>
  );
}
