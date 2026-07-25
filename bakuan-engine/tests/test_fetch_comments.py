"""秒读评论(scripts/fetch_comments)的回归测试。

2026-07-23 事故:TikHub key 失效(401)后,TikHubClient.fetch_comments_structured 把异常
静默吞成 [],daemon/互动区把每篇笔记都当成「0 评论」→ 批量直发全部空转(实际还误入
「写开场评论」路径),用户看到「无法评论」却拿不到任何报错。
红线:读评论失败必须【显式报错】,绝不许静默成「没人评论」。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import fetch_comments  # noqa: E402
from src.adapters.tikhub_client import TikHubClient  # noqa: E402


def _http_error(status: int, payload: dict) -> requests.HTTPError:
    class _Resp:
        status_code = status

        def json(self):
            return payload

    err = requests.HTTPError(f"{status} Client Error")
    err.response = _Resp()
    return err


_401 = _http_error(401, {"detail": {"code": 401, "message_zh": "无法验证API令牌"}})


def test_structured_read_propagates_errors(monkeypatch):
    """接口报错必须抛出——吞成 [] 会让上层把「key 失效」当成「没人评论」。"""
    client = TikHubClient(base="https://api.tikhub.io", key="dead")

    def boom(*_a, **_k):
        raise _401

    monkeypatch.setattr(client, "_call", boom)
    with pytest.raises(Exception):
        client.fetch_comments_structured("xiaohongshu", "abc123")


def test_structured_read_parses_comment_tree(monkeypatch):
    """正常返回:拍平一级评论 + 楼中楼,id/author/text 齐全;空评论丢弃。"""
    client = TikHubClient(base="https://api.tikhub.io", key="k")
    payload = {"data": {"data": {"comments": [
        {"id": "c1", "user_info": {"nickname": "甲"}, "content": "一级",
         "sub_comments": [{"id": "c2", "user": {"nickname": "乙"}, "content": "楼中楼"}]},
        {"id": "c3", "user_info": {"nickname": "丙"}, "content": ""},
    ]}}}
    monkeypatch.setattr(client, "_call", lambda *_a, **_k: payload)
    out = client.fetch_comments_structured("xiaohongshu", "abc123")
    assert [(c["id"], c["author"], c["text"]) for c in out] == [
        ("c1", "甲", "一级"), ("c2", "乙", "楼中楼"),
    ]


def test_script_surfaces_401_as_readable_error(monkeypatch, capsys):
    """key 失效时脚本输出 {"error": ...401...key...},而不是 {"comments": []}。"""
    def boom(self, *_a, **_k):
        raise _401

    monkeypatch.setattr(TikHubClient, "fetch_comments_structured", boom)
    monkeypatch.setattr(sys, "argv", ["fetch_comments", "abc123", "xiaohongshu"])
    fetch_comments.main()
    out = json.loads(capsys.readouterr().out.strip())
    assert "error" in out
    assert "401" in out["error"]
    assert "key" in out["error"].lower()


def test_script_unwraps_retry_error(monkeypatch, capsys):
    """tenacity RetryError 只包着真异常——给用户看的必须挖到里层(状态码+平台原话)。"""
    tenacity = pytest.importorskip("tenacity")
    fut = tenacity.Future(attempt_number=3)
    fut.set_exception(_401)

    def boom(self, *_a, **_k):
        raise tenacity.RetryError(fut)

    monkeypatch.setattr(TikHubClient, "fetch_comments_structured", boom)
    monkeypatch.setattr(sys, "argv", ["fetch_comments", "abc123", "xiaohongshu"])
    fetch_comments.main()
    out = json.loads(capsys.readouterr().out.strip())
    assert "401" in out["error"]
    assert "无法验证" in out["error"]
