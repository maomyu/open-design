"""飞书数据中心 · 界面回流统一 CLI（块1 知识库双写 / 块2 成品复盘回写 / 块3 监控配置）。

只依赖 LarkCliBitable（不实例化 Pipeline/TikHub/Dajiala，轻量快）。每个子命令只 print 一行
JSON 到 stdout（不开 loguru），daemon 从首个 `{` 起 slice 解析。飞书 base 取自 env
FEISHU_BITABLE_APP_TOKEN（daemon syncEngineFeishuEnv 写进 <engineDir>/.env），profile 取
LARK_PROFILE（daemon 注入 baochuang-client）。daemon 侧统一传【英文语义键】，中文飞书字段名
在本脚本内映射，daemon 层不含中文字段名。

用法:
  python scripts/datacenter.py <cmd> [--json '<inline>'|@<file>] [--json-file <path>] [--record-id rec...]
  cmd ∈ push-knowledge delete-knowledge push-draft push-review
        list-monitor push-monitor delete-monitor list-config push-config
        push-record delete-record   （块4 数据中心镜像通用 CRUD，直接用中文字段名）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("FEISHU_BACKEND", "larkcli")
from config import settings  # noqa: F401,E402  载入 .env（含 FEISHU_BITABLE_APP_TOKEN）
from src.feishu.larkcli_bitable import LarkCliBitable  # noqa: E402

# 界面知识库分类 id → 飞书「我的素材库」素材类型 label（个人 7 + 企业 7；ent- 前缀不撞车）
CATEGORY_LABEL = {
    "persona": "账号人设", "viewpoint": "核心观点", "style": "口播风格",
    "story": "个人故事/案例", "goldenline": "金句/话术", "audience": "目标人群",
    "other": "其他素材",
    "ent-company": "公司主体", "ent-credential": "资质背书", "ent-product": "产品/服务",
    "ent-case": "客户案例", "ent-brandvoice": "品牌调性", "ent-faq": "常见问答",
    "ent-other": "其他素材",
}
# voice 类分类 → 写「风格画像库」（单例，控口播语气）；其余全部当可召回素材写「我的素材库」
VOICE_CATEGORIES = {"style", "ent-brandvoice"}

TB_MATERIAL = "我的素材库"
TB_STYLE = "风格画像库"
TB_DRAFT = "成品内容审核库"
TB_REVIEW = "发布复盘库"
TB_MONITOR = "监控配置库"
TB_CONFIG = "系统配置表"


def _out(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))


# ── 块1：知识库双写（我的素材库 / 风格画像库）──
def push_knowledge(fs: LarkCliBitable, payload: dict) -> dict:
    results = []
    for it in payload.get("items", []):
        cat = it.get("category") or "other"
        name = (it.get("name") or "").strip()
        body = (it.get("contentMd") or "").strip()
        rid = it.get("feishuRecordId") or ""
        if cat in VOICE_CATEGORIES:
            # 风格画像库是单例（引擎 _current_style 只取第一条「是否生效=true」）：
            # 写本条前把其余生效行置 false，保证唯一生效 = 用户最新填的风格。
            _demote_active_styles(fs, keep=rid)
            fields = {"风格版本": name or "口播风格", "常用结构": body, "是否生效": True}
            new_rid = _upsert(fs, TB_STYLE, rid, fields)
            results.append({"id": it.get("id"), "table": TB_STYLE, "recordId": new_rid})
        else:
            label = CATEGORY_LABEL.get(cat, "其他素材")
            # 召回靠：是否可召回=true + 原始内容非空 + 主题标签（引擎 _recall_materials）
            fields = {"素材类型": label, "素材标题": name, "原始内容": body,
                      "主题标签": [label], "是否可召回": True}
            new_rid = _upsert(fs, TB_MATERIAL, rid, fields)
            results.append({"id": it.get("id"), "table": TB_MATERIAL, "recordId": new_rid})
    return {"ok": True, "results": results}


def _demote_active_styles(fs: LarkCliBitable, keep: str = "") -> None:
    try:
        rows = fs.list_records(TB_STYLE, filter_="CurrentValue.[是否生效]=true")
    except Exception:
        return
    for r in rows:
        rid = r.get("record_id", "")
        if rid and rid != keep:
            try:
                fs.update_record(TB_STYLE, rid, {"是否生效": False})
            except Exception:
                pass


def delete_knowledge(fs: LarkCliBitable, payload: dict) -> dict:
    n = 0
    for it in payload.get("items", []):
        rid = it.get("feishuRecordId") or ""
        tb = it.get("feishuTable") or TB_MATERIAL
        if rid and fs.delete_record(tb, rid):
            n += 1
    return {"ok": True, "deleted": n}


# ── 块2：成品/复盘回写（成品内容审核库 / 发布复盘库）──
def push_draft(fs: LarkCliBitable, p: dict) -> dict:
    fields = {
        "平台版本": p.get("platform") or "",          # 中文平台标签（抖音/小红书/…）
        "平台标题": p.get("title") or "",
        "60秒脚本": p.get("script") or "",
        "90秒脚本": p.get("script90") or "",
        "标签": p.get("tags") or "",
        "简介": p.get("intro") or "",
        "封面标题候选": p.get("coverTitles") or "",
        "生成版本": 1,
        "审核状态": p.get("status") or "待发布",
    }
    topic_title = (p.get("topicTitle") or "").strip()
    if topic_title:
        # 关联选题：按标题反查「今日爆款选题池」record_id（radar 写选题时的标题）
        trid = _lookup_record(fs, "今日爆款选题池", "标题", topic_title)
        if trid:
            fields["关联选题"] = [{"id": trid}]
    new_rid = fs.add_record(TB_DRAFT, {k: v for k, v in fields.items() if v not in (None, "")})
    return {"ok": True, "record_id": new_rid}


def push_review(fs: LarkCliBitable, p: dict) -> dict:
    fields = {
        "平台": p.get("platform") or "",
        "复盘结论": p.get("conclusion") or "",
        "24h/72h/7d数据": p.get("metrics") or "",
        "发布链接": p.get("link") or "",
    }
    prod_rid = p.get("productRecordId") or ""
    if prod_rid:
        fields["关联成品"] = [{"id": prod_rid}]  # 关联成品审核库（存草稿时拿到的 record_id）
    new_rid = fs.add_record(TB_REVIEW, {k: v for k, v in fields.items() if v not in (None, "")})
    return {"ok": True, "record_id": new_rid}


def _lookup_record(fs: LarkCliBitable, table: str, field: str, value: str) -> str:
    try:
        rows = fs.list_records(table)
    except Exception:
        return ""
    for r in rows:
        if _txt(r.get("fields", {}).get(field)).strip() == value:
            return r.get("record_id", "")
    return ""


# ── 块3：监控配置库 + 系统配置表 ──
def list_monitor(fs: LarkCliBitable, _p: dict) -> dict:
    rows = []
    for r in fs.list_records(TB_MONITOR):
        f = r.get("fields", {})
        rows.append({
            "recordId": r.get("record_id", ""),
            "type": _txt(f.get("类型")) or "关键词",
            "keyword": _txt(f.get("关键词/账号")),
            "category": _txt(f.get("主题分类")),
            "platforms": _multi(f.get("平台")),
            "priority": _txt(f.get("优先级")),
            "timeWindow": _txt(f.get("时间窗")),
            "minThreshold": _num(f.get("最低阈值")),
            "enabled": bool(f.get("是否启用")),
            "note": _txt(f.get("备注")),
        })
    return {"rows": rows}


def push_monitor(fs: LarkCliBitable, p: dict) -> dict:
    fields = {
        "类型": p.get("type") or "关键词",
        "关键词/账号": p.get("keyword") or "",
        "主题分类": p.get("category") or "",
        "平台": p.get("platforms") or [],
        "优先级": p.get("priority") or "",
        "时间窗": p.get("timeWindow") or "",
        "最低阈值": p.get("minThreshold") if p.get("minThreshold") is not None else 0,
        "是否启用": bool(p.get("enabled")),
        "备注": p.get("note") or "",
    }
    rid = p.get("recordId") or ""
    return {"ok": True, "record_id": _upsert(fs, TB_MONITOR, rid, fields)}


def delete_monitor(fs: LarkCliBitable, p: dict) -> dict:
    rid = p.get("recordId") or ""
    return {"ok": fs.delete_record(TB_MONITOR, rid) if rid else False}


def list_config(fs: LarkCliBitable, _p: dict) -> dict:
    rows = []
    for r in fs.list_records(TB_CONFIG):
        f = r.get("fields", {})
        rows.append({
            "recordId": r.get("record_id", ""),
            "item": _txt(f.get("配置项")),
            "value": _txt(f.get("当前值")),
            "unit": _txt(f.get("单位")),
            "enabled": bool(f.get("是否启用")),
        })
    return {"rows": rows}


def push_config(fs: LarkCliBitable, p: dict) -> dict:
    # 「修改人」是人员字段，留空会报错 → 不传（同 seed_back_tables）
    fields = {
        "配置项": p.get("item") or "",
        "当前值": str(p.get("value") if p.get("value") is not None else ""),
        "单位": p.get("unit") or "",
        "是否启用": bool(p.get("enabled", True)),
    }
    rid = p.get("recordId") or ""
    return {"ok": True, "record_id": _upsert(fs, TB_CONFIG, rid, fields)}


# ── 块4：数据中心镜像通用 CRUD（App 为主 → 推飞书；直接用中文字段名）──
def push_record(fs: LarkCliBitable, p: dict) -> dict:
    """通用推送:daemon 传 {table 中文表名, fields {中文字段名: 值}, recordId?}。

    fields 已由 daemon 按 contracts datacenter schema 过滤/收敛(不含 auto_number/
    formula 等只读字段)。有 recordId 走 update 幂等,无则 add 拿新 record_id 回写。
    此路径【直接用中文字段名】——数据中心镜像 CRUD,区别于上面按英文语义键映射的
    push-knowledge/monitor/config。
    """
    table = p.get("table") or ""
    if not table:
        return {"ok": False, "error": "缺少 table"}
    raw_fields = p.get("fields") or {}
    if not isinstance(raw_fields, dict):
        return {"ok": False, "error": "fields 必须是对象"}
    # 丢掉 None（飞书对某些字段不接受 null 写入）；空串/空数组保留（合法清空）。
    fields = {k: v for k, v in raw_fields.items() if v is not None}
    rid = p.get("recordId") or ""
    try:
        return {"ok": True, "record_id": _upsert(fs, table, rid, fields)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}


def delete_record(fs: LarkCliBitable, p: dict) -> dict:
    table = p.get("table") or ""
    rid = p.get("recordId") or ""
    if not table or not rid:
        return {"ok": False, "error": "缺少 table 或 recordId"}
    try:
        return {"ok": bool(fs.delete_record(table, rid))}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}


def _fv(v):
    """飞书字段值 → 展示友好的普通值(text 段取 text、多选取数组、人员/附件取名)。"""
    if isinstance(v, bool) or isinstance(v, (int, float)) or v is None:
        return v
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        out = []
        for x in v:
            if isinstance(x, dict):
                out.append(x.get("text") or x.get("name") or x.get("file_name") or x.get("full_name") or "")
            else:
                out.append(x)
        out = [o for o in out if o not in (None, "")]
        if len(out) == 1 and isinstance(out[0], str):
            return out[0]
        return out
    if isinstance(v, dict):
        return v.get("text") or v.get("name") or ""
    return str(v)


def list_record(fs: LarkCliBitable, p: dict) -> dict:
    """通用读:daemon 传 {table 中文表名, limit?}。返回 {ok, rows:[{id, fields:{中文字段:值}}]}。
    引擎产出表(选题池/成品/复盘/原始库/拆解库)是引擎写飞书的,app 数据中心据此拉取只读展示。"""
    table = p.get("table") or ""
    if not table:
        return {"ok": False, "error": "缺少 table"}
    try:
        limit = int(p.get("limit") or 200)
    except (TypeError, ValueError):
        limit = 200
    try:
        rows = []
        for r in fs.list_records(table)[:limit]:
            f = r.get("fields", {})
            rows.append({"id": r.get("record_id", ""), "fields": {k: _fv(v) for k, v in f.items()}})
        return {"ok": True, "rows": rows}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}


# ── 辅助 ──
def _upsert(fs: LarkCliBitable, table: str, record_id: str, fields: dict) -> str:
    """有 record_id 走 update（幂等），否则 add 拿新 record_id。"""
    if record_id:
        fs.update_record(table, record_id, fields)
        return record_id
    return fs.add_record(table, fields)


def _txt(v) -> str:
    if isinstance(v, list) and v:
        return v[0].get("text", "") if isinstance(v[0], dict) else str(v[0])
    return str(v) if v not in (None, "") else ""


def _multi(v) -> list:
    if isinstance(v, list):
        return [x.get("text") if isinstance(x, dict) else str(x) for x in v]
    if v:
        return [s for s in str(v).replace("、", ",").split(",") if s.strip()]
    return []


def _num(v):
    try:
        return float(v) if v not in (None, "") else 0
    except (ValueError, TypeError):
        return 0


HANDLERS = {
    "push-knowledge": push_knowledge, "delete-knowledge": delete_knowledge,
    "push-draft": push_draft, "push-review": push_review,
    "list-monitor": list_monitor, "push-monitor": push_monitor, "delete-monitor": delete_monitor,
    "list-config": list_config, "push-config": push_config,
    "push-record": push_record, "delete-record": delete_record, "list-record": list_record,
}


def _load_payload(args) -> dict:
    raw = ""
    if args.json_file:
        raw = Path(args.json_file).read_text(encoding="utf-8")
    elif args.json.startswith("@"):
        raw = Path(args.json[1:]).read_text(encoding="utf-8")
    elif args.json:
        raw = args.json
    elif not sys.stdin.isatty():
        raw = sys.stdin.read()
    raw = (raw or "").strip()
    d = json.loads(raw) if raw else {}
    if not isinstance(d, dict):
        d = {"items": d}
    if args.record_id:
        d.setdefault("recordId", args.record_id)
    return d


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=list(HANDLERS.keys()))
    ap.add_argument("--json", default="")
    ap.add_argument("--json-file", default="")
    ap.add_argument("--record-id", default="")
    args = ap.parse_args()
    try:
        payload = _load_payload(args)
    except Exception as e:  # noqa: BLE001
        _out({"ok": False, "error": f"payload 解析失败：{e}"})
        return
    fs = LarkCliBitable()  # 免参：读 env FEISHU_BITABLE_APP_TOKEN + LARK_PROFILE
    if not fs.base:
        _out({"ok": False, "error": "FEISHU_BITABLE_APP_TOKEN 为空（未连接飞书数据中心？）"})
        return
    try:
        _out(HANDLERS[args.cmd](fs, payload))
    except Exception as e:  # noqa: BLE001
        _out({"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"})


if __name__ == "__main__":
    main()
