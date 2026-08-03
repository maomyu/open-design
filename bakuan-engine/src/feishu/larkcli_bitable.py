"""基于 lark-cli 的飞书多维表格适配器（用用户已授权的 lark-cli，免 App Secret）。

与 src/feishu/bitable.Bitable 接口保持一致（add_record/batch_add/update_record/list_records/
resolve_table_id），供主链路在 FEISHU_BACKEND=larkcli 时直接写用户真实飞书。
表名可直接作 --table-id（lark-cli 支持名称）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from typing import Any, Iterable


# 关联/查找类字段的 lark-cli type 值(这些字段才允许写 link 数组 [{"id":..}])。
_LINK_TYPES = {"link", "duplex_link", "single_link", "one_way_link", "two_way_link", "lookup"}


def _is_link_val(v: Any) -> bool:
    """值是否为 link 数组 [{"id":"rec.."}, ...]。"""
    return isinstance(v, list) and len(v) > 0 and all(isinstance(x, dict) and "id" in x for x in v)


class LarkCliBitable:
    def __init__(self, app_token: str | None = None, profile: str | None = None):
        self.base = app_token or os.getenv("FEISHU_BITABLE_APP_TOKEN", "")
        self.profile = profile or os.getenv("LARK_PROFILE", "yuzhihe")
        self._meta_cache: dict[str, dict] = {}   # 表名 → {字段名: (type, multiple)}

    def _field_meta(self, table_name: str) -> dict:
        """取字段元信息(缓存)：{名: {type, multiple, id, options:set}}。"""
        if table_name not in self._meta_cache:
            try:
                d = self._run(["+field-list", "--table-id", table_name])
                self._meta_cache[table_name] = {
                    f["name"]: {"type": f.get("type"), "multiple": bool(f.get("multiple")),
                                "id": f.get("id"),
                                "options": {o.get("name") for o in (f.get("options") or [])}}
                    for f in d.get("fields", [])}
            except Exception:
                self._meta_cache[table_name] = {}
        return self._meta_cache[table_name]

    def _fmt(self, table_name: str, name: str, v: Any) -> Any:
        """按字段真实类型格式化：多选→字符串数组；关联→[{id}]透传；其余走 _cell。"""
        if v is None:
            return None
        m = self._field_meta(table_name).get(name, {})
        if m.get("type") == "select" and m.get("multiple"):   # 多选：写名称数组
            if isinstance(v, list):
                return [str(x) for x in v if x and not isinstance(x, dict)]
            return [s for s in str(v).replace("、", ",").split(",") if s.strip()]
        return _cell(v)

    def _ensure_options(self, table_name: str, records: list[dict]) -> bool:
        """写入前给 select/多选字段补齐缺失的选项(避免批量写未知选项报错)。返回是否补了新选项。"""
        meta = self._field_meta(table_name)
        add: dict[str, set] = {}
        for r in records:
            for name, v in r.items():
                m = meta.get(name)
                if not m or m.get("type") != "select" or v is None:
                    continue
                if isinstance(v, list):
                    vals = [str(x) for x in v if x and not isinstance(x, dict)]
                else:
                    vals = ([s for s in str(v).replace("、", ",").split(",") if s.strip()]
                            if m.get("multiple") else [str(v)])
                miss = {x for x in vals if x and x not in m["options"]}
                if miss:
                    add.setdefault(name, set()).update(miss)
        added = False
        for name, miss in add.items():
            m = meta[name]
            allopts = sorted(m["options"] | miss)
            body = {"type": "select", "name": name, "multiple": m["multiple"],
                    "options": [{"name": o} for o in allopts]}
            try:
                self._run(["+field-update", "--table-id", table_name, "--field-id", m["id"],
                           "--json", json.dumps(body, ensure_ascii=False), "--yes"])
                m["options"] |= miss   # 更新缓存
                added = True
            except Exception:
                pass
        return added

    def _run(self, args: list[str]) -> dict:
        base = ["lark-cli", "base", *args, "--profile", self.profile,
                "--as", "user", "--base-token", self.base]
        # 版本兼容：先按现状跑；若输出不是 JSON(某些版本 record-list 默认输出表格) → 补 --format json 重试
        r = subprocess.run(base, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        out = self._parse(r.stdout)
        if out is None:
            r = subprocess.run(base + ["--format", "json"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
            out = self._parse(r.stdout)
        if out is None:
            raise RuntimeError(f"lark-cli 输出解析失败：{(r.stdout or '')[:120]}{(r.stderr or '')[:120]}")
        if not out.get("ok", False):
            raise RuntimeError(f"lark-cli 错误：{out.get('error') or (r.stderr or '')[:120]}")
        return out.get("data", {})

    @staticmethod
    def _parse(stdout: str):
        s = (stdout or "").strip()
        if not s.startswith("{"):
            return None
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            return None

    def resolve_table_id(self, table_name: str) -> str:
        return table_name   # lark-cli 接受表名作 --table-id

    def add_record(self, table_name: str, fields: dict[str, Any]) -> str:
        ids = self.batch_add(table_name, [fields])
        return ids[0] if ids else ""

    def _keep_cols(self, table_name: str, records: list[dict], cols: list[str]) -> list[str]:
        """按【表真实结构】过滤要写的列，避免整条写入被拒：
        - 表里没有的字段直接丢(否则 800030201 未知字段)；
        - 目标字段非关联类型、但值是 link 数组 [{"id":..}] 的丢(否则 800010407 类型不符)。
        读不到表结构时(meta 空)不过滤，保持原样以免误伤。
        """
        meta = self._field_meta(table_name)
        if not meta:
            return cols
        keep = []
        for c in cols:
            m = meta.get(c)
            if not m:                      # 表里无此字段 → 丢
                continue
            if m.get("type") not in _LINK_TYPES and any(_is_link_val(r.get(c)) for r in records):
                continue                   # 文本/数字字段收到 link 值 → 丢(引擎关联字段与实建 text 不符时的兜底)
            keep.append(c)
        return keep

    def batch_add(self, table_name: str, records: Iterable[dict[str, Any]]) -> list[str]:
        records = list(records)
        if not records:
            return []
        cols: list[str] = []
        for r in records:
            for k in r:
                if k not in cols:
                    cols.append(k)
        cols = self._keep_cols(table_name, records, cols)   # 按真实表结构过滤，避免整条被拒
        if not cols:
            return []
        added = self._ensure_options(table_name, records)   # 补齐缺失的 select 选项，避免报错
        rows = [[self._fmt(table_name, c, r.get(c)) for c in cols] for r in records]
        payload = json.dumps({"fields": cols, "rows": rows}, ensure_ascii=False)
        try:
            data = self._run(["+record-batch-create", "--table-id", table_name, "--json", payload])
        except Exception:
            # 刚补的 select 选项飞书最终一致：首次写新选项值可能撞「未知选项」失败，
            # 等选项同步后重试一次（只在本次确实补过选项时重试，其余照常抛）。
            if not added:
                raise
            time.sleep(1.5)
            data = self._run(["+record-batch-create", "--table-id", table_name, "--json", payload])
        # lark-cli 返回 record_id_list（非 records）
        return data.get("record_id_list", []) if isinstance(data, dict) else []

    def update_record(self, table_name: str, record_id: str, fields: dict[str, Any]) -> None:
        # lark-cli 批量更新格式：{"record_id_list":[...],"patch":{字段:值}}（同一 patch 应用到这些记录）
        keep = self._keep_cols(table_name, [fields], list(fields.keys()))
        fields = {k: v for k, v in fields.items() if k in keep}
        if not fields:
            return
        self._ensure_options(table_name, [fields])   # 补齐缺失的 select 选项
        payload = {"record_id_list": [record_id],
                   "patch": {k: self._fmt(table_name, k, v) for k, v in fields.items()}}
        self._run(["+record-batch-update", "--table-id", table_name,
                   "--json", json.dumps(payload, ensure_ascii=False)])

    def upload_attachment(self, table_name: str, record_id: str, field: str, file_rel_path: str) -> bool:
        """把本地图片上传到某记录的附件字段（field 用字段名）。file 必须是 cwd 下相对路径。"""
        try:
            self._run(["+record-upload-attachment", "--table-id", table_name,
                       "--record-id", record_id, "--field-id", field, "--file", file_rel_path])
            return True
        except Exception:
            return False

    def list_records(self, table_name: str, *, filter_: str | None = None,
                     page_size: int = 200) -> list[dict]:
        args = ["+record-list", "--table-id", table_name, "--page-size", str(page_size)]
        # 不再 `except: return []`——鉴权失效/表被删/网络中断全被吞成"空表",
        # 上层据此断言 ok:true,把失败升级成成功,界面显示「暂无数据」(2026-08-04 审计实测:
        # lark-cli token_missing 时 5 张引擎表全部显示空表且零提示)。抛出去让调用方决定。
        data = self._run(args)
        # lark-cli record-list 返回 record_id_list + fields(列名) + data(逐行值)
        ids = data.get("record_id_list", [])
        cols = data.get("fields", [])
        rows = data.get("data", [])
        out = []
        for i, rid in enumerate(ids):
            vals = rows[i] if i < len(rows) else []
            out.append({"record_id": rid,
                        "fields": {cols[j]: vals[j] for j in range(min(len(cols), len(vals)))}})
        # lark-cli 后端不下推筛选，简单 CurrentValue.[字段]=值 在客户端过滤
        return _apply_filter(out, filter_)

    def delete_record(self, table_name: str, record_id: str) -> bool:
        """删一条记录（界面删知识/监控配置时同步飞书）。失败返回 False，不抛。"""
        if not record_id:
            return False
        try:
            self._run(["+record-delete", "--table-id", table_name,
                       "--record-id", record_id, "--yes"])
            return True
        except Exception:
            return False


def _apply_filter(rows: list[dict], filter_: str | None) -> list[dict]:
    """客户端应用简单筛选：CurrentValue.[字段名]=值 / =true / ="字符串"。无法解析则原样返回。"""
    if not filter_:
        return rows
    m = re.search(r"\[([^\]]+)\]\s*=\s*(.+)$", filter_.strip())
    if not m:
        return rows
    field = m.group(1).strip()
    want = m.group(2).strip().strip('"').strip("'")
    def match(r):
        v = r.get("fields", {}).get(field)
        if want in ("true", "false"):
            return bool(v) == (want == "true")
        return str(v or "") == want
    return [r for r in rows if match(r)]


def _cell(v: Any) -> Any:
    """把内部值转成 lark-cli happy-path CellValue。

    列表统一转为顿号连接的字符串（表结构里 select 已建为 text，避免未知选项报错）。
    """
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, list):
        # 关联(link)字段值：[{"id":"rec.."}] —— 原样透传，不能拼成文本
        if v and all(isinstance(x, dict) and "id" in x for x in v):
            return v
        return "、".join(str(x) for x in v)
    return str(v)
