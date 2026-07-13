"""字幕提取 / 语音转写（ASR）。

优先取平台字幕；无字幕再走 ASR。支持火山 ASR（录音文件识别）与 whisper。
"""
from __future__ import annotations

import os
import time

import requests
from tenacity import retry, stop_after_attempt, wait_exponential


def transcribe(video_url: str, *, subtitle: str | None = None) -> str:
    """返回文案文本。有平台字幕直接用；否则调 ASR。失败返回空串（不丢任务）。"""
    if subtitle and subtitle.strip():
        return subtitle.strip()
    if not video_url:
        return ""
    try:
        return _asr_backend(video_url)
    except Exception:
        return ""


def _asr_backend(video_url: str) -> str:
    provider = os.getenv("ASR_PROVIDER", "volc")
    if provider == "volc":
        return _volc_asr(video_url)
    if provider == "whisper":
        return _whisper_asr(video_url)
    return ""


def transcribe_local(audio_path: str, *, fmt: str = "mp3") -> str:
    """本地音频文件转写（火山不给 URL 时走 base64 audio.data）。用于视频号解密后的音频。"""
    import base64
    if not audio_path or not os.path.exists(audio_path):
        return ""
    try:
        b64 = base64.b64encode(open(audio_path, "rb").read()).decode()
    except OSError:
        return ""
    return _volc_run({"data": b64, "format": fmt})


def _volc_asr(video_url: str) -> str:
    """火山大模型录音文件识别：直接用公网视频/音频 URL。"""
    return _volc_run({"url": video_url, "format": os.getenv("ASR_FORMAT", "mp4")})


def _volc_run(audio_obj: dict) -> str:
    """火山「大模型录音文件识别」(V3 bigmodel)：submit → query 轮询。

    audio_obj 是 {"url":..} 或 {"data":<base64>,"format":..}。鉴权单个 x-api-key。
    状态在响应头 X-Api-Status-Code：20000000=完成/20000001=处理中/20000002=排队/其余=错。
    硬上限 ASR_MAX_POLL(默认20轮×3s=60s)，超时返回空，绝不阻塞主流程。
    """
    import uuid
    key = os.getenv("ASR_API_KEY", "")
    if not key or "待填" in key:
        return ""
    base = os.getenv("ASR_BASE", "https://openspeech.bytedance.com/api/v3/auc/bigmodel")
    req_id = str(uuid.uuid4())
    headers = {"Content-Type": "application/json", "x-api-key": key,
               "X-Api-Resource-Id": "volc.bigasr.auc",
               "X-Api-Request-Id": req_id, "X-Api-Sequence": "-1"}
    try:
        submit = requests.post(f"{base}/submit", headers=headers,
                               json={"user": {"uid": "zmt-hot-monitor"},
                                     "audio": audio_obj,
                                     "request": {"model_name": "bigmodel",
                                                 "enable_itn": True, "enable_punc": True}},
                               timeout=20)
    except requests.RequestException:
        return ""
    if submit.headers.get("X-Api-Status-Code") != "20000000":
        return ""
    for _ in range(int(os.getenv("ASR_MAX_POLL", "12"))):   # 12×3s=36s 硬上限，慢就放弃
        time.sleep(3)
        try:
            q = requests.post(f"{base}/query", headers=headers, json={}, timeout=15)
        except requests.RequestException:
            return ""
        code = q.headers.get("X-Api-Status-Code", "")
        if code == "20000000":            # 完成
            res = (q.json() or {}).get("result") or {}
            if isinstance(res, dict):
                if res.get("text"):
                    return res["text"]
                return "".join(u.get("text", "") for u in (res.get("utterances") or []))
            return ""
        if code not in ("20000001", "20000002"):   # 非处理中/排队中 → 出错
            break
    return ""   # 超时未完成（长视频）→ 放弃，用标题兜底，不拖慢主流程


def _whisper_asr(video_url: str) -> str:
    """OpenAI 兼容 whisper 转写（第三方端点）。需先下载音轨，此处走 URL 直传型端点。"""
    base = os.getenv("ASR_BASE", "https://api.openai.com/v1").rstrip("/")
    key = os.getenv("ASR_API_KEY", "")
    audio = requests.get(video_url, timeout=120).content
    r = requests.post(f"{base}/audio/transcriptions",
                      headers={"Authorization": f"Bearer {key}"},
                      files={"file": ("audio.mp4", audio, "video/mp4")},
                      data={"model": os.getenv("ASR_MODEL", "whisper-1")}, timeout=180)
    r.raise_for_status()
    return r.json().get("text", "")
