"""把各表里"本该是单选/多选、却建成文本"的字段，统一转成正确的 select 类型（带选项）。
运行前建议先清空数据表（转换在空表上最安全）。
运行：FEISHU_BACKEND=larkcli LARK_PROFILE=yuzhihe ./.venv/bin/python scripts/convert_field_types.py
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import settings  # noqa: F401

BASE = os.getenv("FEISHU_BITABLE_APP_TOKEN", "GUlpbqXX9a94tWsseUlcNb67nae")
PROFILE = os.getenv("LARK_PROFILE", "yuzhihe")
PLAT = ["抖音", "小红书", "B站", "快手", "公众号", "视频号"]

# (表, 字段, multiple, [选项])  —— 选项为已知枚举；自由填写的给常见几个，写入未知值会自动新增
SINGLE = [
    ("监控配置库", "类型", ["关键词", "竞品账号"]),
    ("监控配置库", "主题分类", ["婚恋观点", "约会", "自卑心态", "方法教程", "聊天技巧", "情感修复"]),
    ("监控配置库", "优先级", ["P0", "P1", "P2"]),
    ("监控配置库", "时间窗", ["1d", "7d", "30d", "180d"]),
    ("我的素材库", "素材类型", ["观点", "金句", "案例", "方法", "封面参考"]),
    ("今日爆款选题池", "内容类型", ["双高型", "流量型", "意向型", "普通型"]),
    ("今日爆款选题池", "推荐优先级", ["S", "A", "B", "C"]),
    ("成品内容审核库", "平台版本", PLAT),
    ("成品内容审核库", "审核状态", ["待审核", "已通过", "重新生成", "已重生成"]),
    ("发布复盘库", "平台", PLAT),
    ("爆款内容原始库", "平台", PLAT),
    ("爆款内容原始库", "内容类型", ["视频", "图文", "文章"]),
    ("爆款内容原始库", "爆款等级", ["S", "A", "B", "C"]),
    ("爆款内容原始库", "处理状态", ["待转写", "已处理", "失败"]),
    ("爆点拆解库", "选题类型", ["痛点", "方法", "观点", "案例", "情感共鸣"]),
    ("Prompt与模型策略库", "任务类型", ["爆点拆解", "意图评估", "脚本生成"]),
    ("Prompt与模型策略库", "默认模型", ["deepseek-chat", "deepseek-reasoner"]),
    ("Prompt与模型策略库", "备用模型", ["deepseek-chat", "deepseek-reasoner"]),
    ("系统配置表", "配置项", ["低粉最低点赞", "低粉赞粉比", "低粉粉丝上限", "账号异常观察倍数",
                          "账号异常A倍数", "账号异常S倍数", "关键词头部比例", "快速起量窗口",
                          "检测频率", "TopK", "默认模型.high"]),
]
MULTI = [
    ("我的素材库", "主题标签", ["脱单", "相亲", "男性成长", "社恐", "异地恋", "挽回"]),
    ("我的素材库", "目标人群", ["母胎单身男", "大龄单身男", "情感受挫男"]),
    ("我的素材库", "版式标签", ["大字标题", "人像封面", "对比图", "纯色底"]),
    ("今日爆款选题池", "所属榜单", ["流量爆款榜", "精准意向榜", "双高榜", "低粉爆款榜"]),
    ("爆款内容原始库", "命中规则", ["绝对热度", "低粉高表现", "账号异常·观察", "账号异常·A级",
                              "账号异常·S级", "关键词头部", "快速起量", "公众号高阅读",
                              "视频号高互动", "竞品账号监控", "单链接手动"]),
    ("爆点拆解库", "情绪点", ["共鸣", "希望", "焦虑", "愤怒", "认同", "好奇"]),
    ("系统配置表", "平台", PLAT),
]


def run(args):
    r = subprocess.run(["lark-cli", "base", *args, "--profile", PROFILE, "--as", "user",
                        "--base-token", BASE, "--format", "json"],
                       capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {}


def field_id(table, name):
    d = run(["+field-list", "--table-id", table])
    for f in d.get("data", {}).get("fields", []):
        if f["name"] == name:
            return f["id"]
    return None


def convert(table, name, multiple, options):
    fid = field_id(table, name)
    if not fid:
        return f"{table}.{name}: 字段不存在"
    body = {"type": "select", "name": name, "multiple": multiple,
            "options": [{"name": o} for o in options]}
    d = run(["+field-update", "--table-id", table, "--field-id", fid,
             "--json", json.dumps(body, ensure_ascii=False), "--yes"])
    return f"{table}.{name} → {'多选' if multiple else '单选'}: {'ok' if d.get('ok') else d.get('error',{}).get('message','?')[:40]}"


for t, n, opts in SINGLE:
    print(convert(t, n, False, opts))
for t, n, opts in MULTI:
    print(convert(t, n, True, opts))
print("✅ 字段类型转换完成")
