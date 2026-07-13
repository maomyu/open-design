"""飞书数据中心 · 12 张逻辑表结构定义（前台 5 + 后台 5 分组折叠 + 2 合并）。

用途：
  1. 部署时按此定义在飞书多维表格建表/建字段（建表脚本见 scripts/init_feishu.py）
  2. 作为《数据字典》的单一事实来源
前台 5：监控配置库 / 我的素材库 / 今日爆款选题池 / 成品内容审核库 / 发布复盘库
后台 5：爆款内容原始库 / 爆点拆解库 / 风格画像库 / Prompt与模型策略库 / 系统配置表
（关键词库+竞品库→监控配置库；封面参考+口播素材→我的素材库；脚本+封面成品→成品内容审核库）
"""
from __future__ import annotations

# 字段类型对应飞书多维表格：text/number/single_select/multi_select/checkbox/
# datetime/user/attachment/link(关联)/formula
FRONT = "前台"
BACK = "后台·折叠"

TABLES: dict[str, dict] = {
    "监控配置库": {
        "stage": FRONT,
        "desc": "关键词库+竞品账号库合并；日常配置入口",
        "fields": [
            ("记录ID", "auto_number"), ("类型", "single_select"),  # 关键词 / 竞品账号
            ("关键词/账号", "text"), ("主题分类", "single_select"),
            ("平台", "multi_select"), ("优先级", "single_select"),
            ("时间窗", "single_select"), ("最低阈值", "number"),
            ("是否启用", "checkbox"), ("备注", "text"),
        ],
    },
    "我的素材库": {
        "stage": FRONT,
        "desc": "口播素材库+封面参考库合并；RAG 召回来源",
        "fields": [
            ("素材ID", "auto_number"), ("素材类型", "single_select"),
            ("素材标题", "text"), ("原始内容", "text"), ("主题标签", "multi_select"),
            ("目标人群", "multi_select"), ("情绪强度", "number"),
            ("参考封面", "attachment"), ("版式标签", "multi_select"),
            ("是否可召回", "checkbox"), ("更新时间", "datetime"),
        ],
    },
    "今日爆款选题池": {
        "stage": FRONT,
        "desc": "当日判定的爆款选题、评分、榜单、推荐承接",
        "fields": [
            ("选题ID", "auto_number"), ("来源内容", "link"),
            ("流量爆款分", "number"), ("精准意向分", "number"),
            ("内容类型", "single_select"), ("推荐优先级", "single_select"),
            ("所属榜单", "multi_select"), ("评分理由", "text"),
            ("高频用户问题", "text"), ("推荐承接服务", "text"),
        ],
    },
    "成品内容审核库": {
        "stage": FRONT,
        "desc": "脚本生成库+封面成品库合并；人工审核入口",
        "fields": [
            ("成品ID", "auto_number"), ("关联选题", "link"),
            ("平台版本", "single_select"), ("平台标题", "text"),
            ("封面标题候选", "text"), ("60秒脚本", "text"), ("90秒脚本", "text"),
            ("标签", "text"), ("简介", "text"), ("评论引导", "text"),
            ("封面成品", "attachment"), ("原创性检查", "text"),
            ("生成版本", "number"), ("审核状态", "single_select"), ("修改意见", "text"),
        ],
    },
    "发布复盘库": {
        "stage": FRONT,
        "desc": "发布后数据回流 + 运行日志/成本",
        "fields": [
            ("记录ID", "auto_number"), ("关联成品", "link"), ("平台", "single_select"),
            ("发布时间", "datetime"), ("发布链接", "text"), ("24h/72h/7d数据", "text"),
            ("复盘结论", "text"), ("是否进正例库", "checkbox"),
            ("模型/接口成本", "number"), ("错误摘要", "text"), ("日志路径", "text"),
        ],
    },
    "爆款内容原始库": {
        "stage": BACK,
        "desc": "各平台原始抓取 + 多期快照 + 去重指纹",
        "fields": [
            # 标题放第一列=主字段（飞书关联字段卡片显示主字段，故用标题而非ID才友好）
            ("标题", "text"), ("内容唯一ID", "text"), ("平台", "single_select"), ("内容类型", "single_select"),
            ("原始链接", "text"), ("原视频文案", "text"), ("作者", "text"), ("粉丝数", "number"),
            ("发布时间", "datetime"), ("首次抓取", "datetime"), ("最近更新", "datetime"),
            ("播放/阅读", "number"), ("点赞", "number"), ("评论", "number"),
            ("收藏/投币", "number"), ("转发", "number"), ("数据快照JSON", "text"),
            ("去重指纹", "text"), ("命中规则", "multi_select"), ("爆款总分", "number"),
            ("爆款等级", "single_select"), ("处理状态", "single_select"), ("失败原因", "text"),
        ],
    },
    "爆点拆解库": {
        "stage": BACK,
        "desc": "AI 结构化拆解结果",
        "fields": [
            ("拆解ID", "auto_number"), ("关联内容", "link"), ("选题类型", "single_select"),
            ("前3秒钩子", "text"), ("核心矛盾", "text"), ("用户痛点", "text"),
            ("情绪点", "multi_select"), ("争议点", "text"), ("内容结构", "text"),
            ("可借鉴结构", "text"), ("不应复制元素", "text"), ("转化机会", "text"),
            ("原视频文案", "text"), ("评分明细JSON", "text"), ("模型/Prompt版本", "text"),
        ],
    },
    "风格画像库": {
        "stage": BACK,
        "desc": "客户口播风格，控脚本语气",
        "fields": [
            ("风格版本", "text"), ("参考稿范围", "link"), ("句长偏好", "text"),
            ("语气强度", "number"), ("常用结构", "text"), ("常用词", "text"),
            ("禁用表达", "text"), ("目标受众", "text"), ("CTA规则", "text"),
            ("典型正例", "link"), ("典型反例", "link"), ("是否生效", "checkbox"),
        ],
    },
    "Prompt与模型策略库": {
        "stage": BACK,
        "desc": "各任务 Prompt 与模型路由，可在飞书改",
        "fields": [
            ("任务类型", "single_select"), ("Prompt版本", "text"), ("Prompt正文", "text"),
            ("系统角色", "text"), ("默认模型", "single_select"), ("备用模型", "single_select"),
            ("温度/参数", "text"), ("最大Token", "number"), ("是否启用", "checkbox"), ("备注", "text"),
        ],
    },
    "系统配置表": {
        "stage": BACK,
        "desc": "全局阈值/频率/TopK/默认模型（默认折叠·高级设置）",
        "fields": [
            ("配置ID", "auto_number"), ("配置项", "single_select"), ("平台", "multi_select"),
            ("当前值", "text"), ("单位", "text"), ("是否启用", "checkbox"),
            ("修改人", "user"), ("修改时间", "datetime"),
        ],
    },
}


def summary() -> str:
    front = [n for n, t in TABLES.items() if t["stage"] == FRONT]
    back = [n for n, t in TABLES.items() if t["stage"] == BACK]
    return f"前台 {len(front)} 张：{front}\n后台 {len(back)} 张：{back}"


if __name__ == "__main__":
    print(summary())
