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
# 关联字段(link)先建成 text,建完所有表后统一转 link → 原始库
LINK_FIELDS = {"来源内容", "关联内容", "关联选题", "关联成品", "关联爆款", "参考稿范围", "典型正例", "典型反例"}


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
                       capture_output=True, text=True, timeout=90)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "raw": r.stdout[:200] + r.stderr[:200]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="自媒体爆款数据中心")
    a = ap.parse_args()
    if not PROFILE:
        print("ERR: 需设 LARK_PROFILE=<客户飞书profile>（先 lark-cli auth login 连客户飞书）"); sys.exit(2)

    names = list(TABLES.keys())
    first = names[0]
    ffields = [field_json(n, t) for n, t in TABLES[first]["fields"]]
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
        flds = [field_json(n, t) for n, t in TABLES[name]["fields"]]
        r = run(["+table-create", "--base-token", base, "--name", name,
                 "--fields", json.dumps(flds, ensure_ascii=False)])
        print(f"  {'✓' if r.get('ok') else '✗'} 表 {name}")

    url = base_url or f"https://feishu.cn/base/{base}"
    print(f"\n完成。关联字段(link)可再跑转换脚本;后台表可分组折叠。")
    print(f"BASE_TOKEN={base}")
    print(f"BASE_URL={url}")


if __name__ == "__main__":
    main()
