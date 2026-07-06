/**
 * 敏感词/违禁词扫描 — 发布预检的一环（警示级，不硬阻断：误报常见，
 * 由用户自行判断）。词库是实用起步版：广告法极限词 + 平台高危方向，
 * 客户可按行业逐步补充（一行一词，维护成本低）。
 */

const BANNED: Array<{ category: string; words: string[] }> = [
  {
    category: '广告法极限词',
    words: [
      '最佳', '最优', '最好', '最强', '最先进', '最赚钱', '最便宜', '最低价', '第一名', '全网第一',
      '行业第一', '全国第一', '世界级', '顶级', '极致', '独家秘方', '史无前例', '万能', '百分之百', '100%有效',
      '绝无仅有', '空前绝后', '零风险', '无风险', '稳赚', '必赚', '躺赚', '秒杀全网', '碾压', '吊打',
    ],
  },
  {
    category: '承诺保证类',
    words: [
      '保证有效', '保证赚钱', '保证通过', '包过', '包赚', '包治', '无效退款', '永久有效', '绝对安全', '绝对有效',
      '亲测有效', '立竿见影', '药到病除', '一次根治', '彻底根除', '七天见效', '三天见效',
    ],
  },
  {
    category: '医疗健康高危',
    words: [
      '治愈', '根治', '抗癌', '防癌', '降血压', '降血糖', '壮阳', '丰胸', '减肥神器', '瘦身神器',
      '排毒', '偏方', '祖传秘方', '延年益寿', '起死回生',
    ],
  },
  {
    category: '金融投资高危',
    words: [
      '稳赚不赔', '保本', '保收益', '高额回报', '一夜暴富', '财富自由密码', '内幕消息', '必涨', '翻倍收益', '带你赚钱',
    ],
  },
  {
    category: '平台敏感方向',
    words: [
      '加微信', '加V', '私聊我', '看我主页', '点击链接购买', '货到付款', '限时秒杀最后', '仅此一天', '错过再等一年',
    ],
  },
];

export interface LintHit {
  word: string;
  category: string;
  /** 命中处前后各 ~14 字的上下文，便于定位。 */
  context: string;
  /** 命中次数。 */
  count: number;
}

export function lintContent(text: string): LintHit[] {
  const hits: LintHit[] = [];
  if (!text.trim()) return hits;
  for (const group of BANNED) {
    for (const word of group.words) {
      let index = text.indexOf(word);
      if (index === -1) continue;
      let count = 0;
      let firstIndex = index;
      while (index !== -1) {
        count += 1;
        index = text.indexOf(word, index + word.length);
      }
      const start = Math.max(0, firstIndex - 14);
      const end = Math.min(text.length, firstIndex + word.length + 14);
      hits.push({
        word,
        category: group.category,
        context: `…${text.slice(start, end).replace(/\s+/g, ' ')}…`,
        count,
      });
    }
  }
  return hits;
}
