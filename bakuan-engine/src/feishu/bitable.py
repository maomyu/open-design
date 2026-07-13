"""飞书多维表格读写客户端。

封装 tenant_access_token 获取、表/字段查询、记录增删改查、按视图/筛选读取。
供采集写原始库、评分写选题池、脚本/封面写审核库、复盘回流等全链路使用。
"""
from __future__ import annotations

import os
import time
from typing import Any, Iterable

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings as S


class Bitable:
    def __init__(self, app_id: str | None = None, app_secret: str | None = None,
                 app_token: str | None = None):
        self.app_id = app_id or S.KEYS.feishu_app_id
        self.app_secret = app_secret or S.KEYS.feishu_app_secret
        self.app_token = app_token or S.KEYS.feishu_bitable_token
        # 可用 FEISHU_OPEN_BASE 覆盖（本地 mock 集成测试用）
        self.base = os.getenv("FEISHU_OPEN_BASE", "https://open.feishu.cn/open-apis")
        self._token = ""
        self._token_exp = 0.0
        self._table_ids: dict[str, str] = {}   # 表名 -> table_id 缓存

    # ── 鉴权 ──
    def _access_token(self) -> str:
        if self._token and time.time() < self._token_exp - 60:
            return self._token
        r = requests.post(f"{self.base}/auth/v3/tenant_access_token/internal",
                          json={"app_id": self.app_id, "app_secret": self.app_secret},
                          timeout=15)
        r.raise_for_status()
        data = r.json()
        self._token = data["tenant_access_token"]
        self._token_exp = time.time() + data.get("expire", 7200)
        return self._token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token()}",
                "Content-Type": "application/json; charset=utf-8"}

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=15))
    def _req(self, method: str, path: str, **kw) -> dict:
        r = requests.request(method, f"{self.base}{path}", headers=self._headers(), timeout=30, **kw)
        r.raise_for_status()
        data = r.json()
        if data.get("code", 0) != 0:
            raise RuntimeError(f"飞书 API 错误 {data.get('code')}: {data.get('msg')}")
        return data.get("data", {})

    # ── 表 ──
    def resolve_table_id(self, table_name: str) -> str:
        if not self._table_ids:
            data = self._req("GET", f"/bitable/v1/apps/{self.app_token}/tables?page_size=100")
            self._table_ids = {t["name"]: t["table_id"] for t in data.get("items", [])}
        if table_name not in self._table_ids:
            raise KeyError(f"飞书多维表格中找不到数据表：{table_name}")
        return self._table_ids[table_name]

    # ── 记录 CRUD ──
    def add_record(self, table_name: str, fields: dict[str, Any]) -> str:
        tid = self.resolve_table_id(table_name)
        data = self._req("POST", f"/bitable/v1/apps/{self.app_token}/tables/{tid}/records",
                         json={"fields": fields})
        return data["record"]["record_id"]

    def batch_add(self, table_name: str, records: Iterable[dict[str, Any]]) -> list[str]:
        tid = self.resolve_table_id(table_name)
        payload = {"records": [{"fields": f} for f in records]}
        data = self._req("POST",
                         f"/bitable/v1/apps/{self.app_token}/tables/{tid}/records/batch_create",
                         json=payload)
        return [r["record_id"] for r in data.get("records", [])]

    def update_record(self, table_name: str, record_id: str, fields: dict[str, Any]) -> None:
        tid = self.resolve_table_id(table_name)
        self._req("PUT",
                  f"/bitable/v1/apps/{self.app_token}/tables/{tid}/records/{record_id}",
                  json={"fields": fields})

    def list_records(self, table_name: str, *, filter_: str | None = None,
                     page_size: int = 200) -> list[dict]:
        """读取记录（自动翻页）。filter_ 用飞书公式，如 CurrentValue.[是否启用]=true。"""
        tid = self.resolve_table_id(table_name)
        out: list[dict] = []
        page_token = None
        while True:
            params: dict[str, Any] = {"page_size": page_size}
            if filter_:
                params["filter"] = filter_
            if page_token:
                params["page_token"] = page_token
            data = self._req("GET",
                             f"/bitable/v1/apps/{self.app_token}/tables/{tid}/records",
                             params=params)
            out.extend(data.get("items", []))
            if not data.get("has_more"):
                break
            page_token = data.get("page_token")
        return out
