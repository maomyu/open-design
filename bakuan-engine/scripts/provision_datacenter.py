"""给【客户自己的】飞书账户一键建好"数据中心"多维表格(12 表,字段类型正确)。

平台(爆创)在客户装机时调它:客户先 `lark-cli auth login` 连自己的飞书,拿到 profile,
再跑本脚本 → 在客户账户下新建 base + 12 表 → 打印 base 链接(存进 feishuBitableUrl 配置)。

用法:
  LARK_PROFILE=<客户profile> ./.venv/bin/python scripts/provision_datacenter.py --name "自媒体爆款数据中心"
输出最后一行:BASE_URL=<客户飞书里新建的多维表格链接>
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.feishu.tables import TABLES  # noqa: E402

PROFILE = os.getenv("LARK_PROFILE", "")

# 单选/多选字段的预设选项(与 convert_field_types 一致)
PLAT = ["抖音", "小红书", "B站", "快手", "公众号", "视频号"]
OPTS = {
    "类型": ["关键词", "竞品账号"], "主题分类": ["婚恋观点", "约会", "自卑心态", "方法教程", "聊天技巧", "情感修复"],
    "优先级": ["P0", "P1", "P2"], "时间窗": ["1d", "7d", "30d", "180d"],
    "素材类型": ["观点", "金句", "案例", "方法", "封面参考"],
    "内容类型": ["视频", "图文", "文章"], "推荐优先级": ["S", "A", "B", "C"],
    "平台版本": PLAT, "审核状态": ["待审核", "已通过", "重新生成", "已重生成"],
    "平台": PLAT, "爆款等级": ["S", "A", "B", "C"], "处理状态": ["待转写", "已处理", "失败"],
    "选题类型": ["痛点", "方法", "观点", "案例", "情感共鸣"],
    "任务类型": ["爆点拆解", "意图评估", "脚本生成"],
    "默认模型": ["deepseek-chat", "deepseek-reasoner"], "备用模型": ["deepseek-chat", "deepseek-reasoner"],
    "配置项": ["低粉最低点赞", "低粉赞粉比", "低粉粉丝上限", "账号异常观察倍数", "账号异常A倍数",
             "账号异常S倍数", "关键词头部比例", "快速起量窗口", "检测频率", "TopK", "默认模型.high"],
    "主题标签": ["脱单", "相亲", "男性成长", "社恐", "异地恋", "挽回"],
    "目标人群": ["母胎单身男", "大龄单身男", "情感受挫男"],
    "版式标签": ["大字标题", "人像封面", "对比图", "纯色底"],
    "所属榜单": ["流量爆款榜", "精准意向榜", "双高榜", "低粉爆款榜"],
    "命中规则": ["绝对热度", "低粉高表现", "账号异常·观察", "账号异常·A级", "账号异常·S级", "关键词头部",
              "快速起量", "公众号阅读达标", "视频号互动达标", "竞品账号监控", "单链接手动"],
    "情绪点": ["共鸣", "希望", "焦虑", "愤怒", "认同", "好奇"],
}
# 关联字段(link)的目标表:建表时先跳过,建完所有表后 pass-2 统一 field-create 真双向关联。
# 客户在飞书里点关联单元格即可跳到对侧记录(选题→原始爆款、审核→选题、复盘→审核…)。
LINK_TARGETS = {
    ("今日爆款选题池", "来源内容"): "爆款内容原始库",
    ("爆点拆解库", "关联内容"): "爆款内容原始库",
    ("成品内容审核库", "关联选题"): "今日爆款选题池",
    ("发布复盘库", "关联成品"): "成品内容审核库",
    ("风格画像库", "参考稿范围"): "爆款内容原始库",
    ("风格画像库", "典型正例"): "爆款内容原始库",
    ("风格画像库", "典型反例"): "爆款内容原始库",
}


def field_json(fname: str, ftype: str) -> dict:
    if ftype == "number":
        return {"name": fname, "type": "number"}
    if ftype == "checkbox":
        return {"name": fname, "type": "checkbox"}
    if ftype == "datetime":
        return {"name": fname, "type": "dateTime"}
    if ftype in ("single_select", "multi_select"):
        return {"name": fname, "type": "select", "multiple": ftype == "multi_select",
                "options": [{"name": o} for o in OPTS.get(fname, [])]}
    # link/attachment/user/formula/auto_number → 先建 text(link 稍后转)
    return {"name": fname, "type": "text"}


def run(args: list[str]) -> dict:
    r = subprocess.run(["lark-cli", "base", *args, "--profile", PROFILE, "--as", "user", "--format", "json"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
    try:
        # stdout 兜底空串:读线程异常(如历史 GBK 解码炸)时 stdout 可能是 None,别让
        # json.loads(None) 的 TypeError 淹没 lark-cli 的真实报错。
        return json.loads(r.stdout or "")
    except json.JSONDecodeError:
        return {"ok": False, "raw": (r.stdout or "")[:200] + (r.stderr or "")[:200]}


def create_link_fields(base: str) -> None:
    """pass-2:所有表建好后,把关联字段建成真 link(指向目标表)。客户在飞书点关联单元格即可跳转。
    失败不阻断(退化为无关联,数据仍完整)。"""
    for (tbl, fld), target in LINK_TARGETS.items():
        r = run(["+field-create", "--base-token", base, "--table-id", tbl,
                 "--json", json.dumps({"type": "link", "name": fld, "link_table": target},
                                      ensure_ascii=False)])
        print(f"  {'✓' if r.get('ok') else '✗'} 关联 {tbl}.{fld} → {target}")


def seed_defaults(base: str) -> None:
    """建表后种子填充:①系统配置表填默认阈值/频率/TopK/模型(客户在飞书直接改即生效);
    ②监控配置库填一条示例行(默认不启用),让客户照着改成自己的关键词/竞品。失败不阻断建表。"""
    try:
        from src.feishu.larkcli_bitable import LarkCliBitable
        from src.feishu import config_sync as CS
        from config import settings as S
        fs = LarkCliBitable(app_token=base, profile=PROFILE)
        cfg = [{"配置项": item, "当前值": str(getattr(S, attr, "")), "是否启用": True}
               for item, (attr, _c) in CS._MAP.items() if getattr(S, attr, None) is not None]
        cfg.append({"配置项": "检测频率", "当前值": os.getenv("DEFAULT_DETECT_INTERVAL_MIN", "120"),
                    "单位": "分钟", "是否启用": True})
        cfg.append({"配置项": "TopK", "当前值": os.getenv("RAG_TOPK", "5"), "是否启用": True})
        high = getattr(S, "LLM_TIERS", {}).get("high", "deepseek-reasoner")
        cfg.append({"配置项": "默认模型.high", "当前值": high, "是否启用": True})
        fs.batch_add("系统配置表", cfg)
        print(f"  ✓ 系统配置表 种子 {len(cfg)} 条")
        fs.batch_add("监控配置库", [{
            "类型": "关键词", "关键词/账号": "男性情感", "主题分类": "婚恋观点",
            "平台": ["小红书", "抖音"], "优先级": "P1", "时间窗": "7d",
            "最低阈值": 0, "是否启用": False, "备注": "示例:改成你的方向/竞品后勾选「是否启用」即生效",
        }])
        print("  ✓ 监控配置库 种子 1 条示例")
    except Exception as e:  # noqa: BLE001
        print(f"  ! 种子填充跳过(不影响建表): {str(e)[:120]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="自媒体爆款数据中心")
    a = ap.parse_args()
    if not PROFILE:
        print("ERR: 需设 LARK_PROFILE=<客户飞书profile>（先 lark-cli auth login 连客户飞书）"); sys.exit(2)

    names = list(TABLES.keys())
    first = names[0]
    # pass-1 先跳过 link 字段(目标表还没建),建完所有表后 pass-2 再补真关联。
    ffields = [field_json(n, t) for n, t in TABLES[first]["fields"] if t != "link"]
    d = run(["+base-create", "--name", a.name, "--table-name", first,
             "--fields", json.dumps(ffields, ensure_ascii=False)])
    if not d.get("ok"):
        print("ERR base-create:", d.get("error") or d.get("raw")); sys.exit(1)
    binfo = (d.get("data") or {}).get("base", {})
    base = binfo.get("base_token", "")
    base_url = binfo.get("url", "")
    if not base:
        print("ERR: 没拿到 base_token:", json.dumps(d)[:200]); sys.exit(1)
    print(f"✓ 建 base「{a.name}」token={base}  首表={first}")

    for name in names[1:]:
        flds = [field_json(n, t) for n, t in TABLES[name]["fields"] if t != "link"]
        r = run(["+table-create", "--base-token", base, "--name", name,
                 "--fields", json.dumps(flds, ensure_ascii=False)])
        print(f"  {'✓' if r.get('ok') else '✗'} 表 {name}")

    create_link_fields(base)   # pass-2:所有表都在了,统一建真双向关联字段
    seed_defaults(base)   # 种子:系统配置表默认配置 + 监控配置库示例(客户可在飞书直接改)

    url = base_url or f"https://feishu.cn/base/{base}"
    print(f"\n完成。关联字段(link)可再跑转换脚本;后台表可分组折叠。")
    print(f"BASE_TOKEN={base}")
    print(f"BASE_URL={url}")


if __name__ == "__main__":
    main()
