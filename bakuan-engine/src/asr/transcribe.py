"""字幕提取 / 语音转写（ASR）。

优先取平台字幕；无字幕再走 ASR。支持火山 ASR（录音文件识别）与 whisper。
"""
from __future__ import annotations

import os
import time

import requests
from tenacity import retry, stop_after_attempt, wait_exponential


class AsrError(Exception):
    """转写失败带原因——四种完全不同的失败此前一律吞成空串,用户只看到"纯音乐/无口播",
    换一百条视频也没用(2026-08-04 审计)。code 见 _ASR_HINT。"""

    def __init__(self, code: str, detail: str = ""):
        self.code = code
        self.detail = detail
        super().__init__(_ASR_HINT.get(code, f"转写失败({code}) {detail}".strip()))


_ASR_HINT = {
    "no_key": "没配火山语音 Key——口播转写走火山【语音技术】(与方舟 ark-* 不是同一套,key 不通用)。到「设置 → 媒体生成 → 火山语音」填入后重试。",
    "45000010": "火山语音 Key 无效——你填的可能是方舟(ark-*)的 Key。语音技术是独立服务,到「设置 → 媒体生成 → 火山语音」换成语音技术的 Key。",
    "45000030": "火山语音的「录音文件识别(大模型)」未开通——去火山控制台开通 volc.bigasr.auc 资源(通常需实名认证)后重试。",
    "network": "连不上火山语音服务——检查网络/代理后重试。",
    "timeout": "转写超时——视频较长或火山排队中。可换条短一点的视频,或稍后重试。",
    "empty": "转写成功但没有文字——这条大概率是纯音乐/无口播,换一条有讲解的爆款。",
}


def transcribe(video_url: str, *, subtitle: str | None = None, duration_s: int = 0) -> str:
    """返回文案文本。有平台字幕直接用；否则调 ASR。失败返回空串（不丢任务）。
    duration_s: 已知视频时长(秒)时传入,轮询预算按时长自适应(长视频不再 2min 就放弃)。"""
    if subtitle and subtitle.strip():
        return subtitle.strip()
    if not video_url:
        return ""
    try:
        return _asr_backend(video_url, duration_s)
    except AsrError:
        raise                      # 带原因的失败向上抛,由调用方转成用户看得懂的提示
    except Exception:
        return ""


def _asr_backend(video_url: str, duration_s: int = 0) -> str:
    provider = os.getenv("ASR_PROVIDER", "volc")
    if provider == "volc":
        return _volc_asr(video_url, duration_s)
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


def transcribe_media_url(media_url: str) -> str:
    """视频【直链】→ 本地下载 → ffmpeg 抽音频(默认前300s封顶) → base64 转写。

    火山 URL 直传拉不动抖音等平台 CDN(防盗链,任务一直 Processing 到超时)——2026-07-16
    真机验证:87s 视频 2.5min 都等不到结果;而本地音频 base64 路径 11min 视频实测 49s
    (与 scripts/extract_script.py 生产路径同款)。主链路视频转写走这里。"""
    import subprocess
    import tempfile
    import uuid
    if not media_url:
        return ""
    vid = os.path.join(tempfile.gettempdir(), f"bc_asr_{uuid.uuid4().hex}.mp4")
    aud = vid[:-4] + ".mp3"
    try:
        try:
            with requests.get(media_url, headers={"User-Agent": "Mozilla/5.0"},
                              stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(vid, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
        except requests.RequestException:
            return ""
        cap = os.getenv("ASR_AUDIO_CAP_SEC", "300").strip()
        cap_args = ["-t", cap] if cap and cap != "0" else []
        try:
            subprocess.run(["ffmpeg", "-y", "-i", vid, *cap_args, "-vn", "-acodec",
                            "libmp3lame", "-ar", "16000", "-ac", "1", aud],
                           capture_output=True, timeout=120)
        except Exception:  # noqa: BLE001
            return ""
        if not os.path.exists(aud):
            return ""
        return transcribe_local(aud)
    finally:
        for p in (vid, aud):
            try:
                os.remove(p)
            except OSError:
                pass


def _volc_asr(video_url: str, duration_s: int = 0) -> str:
    """火山大模型录音文件识别：直接用公网视频/音频 URL。"""
    return _volc_run({"url": video_url, "format": os.getenv("ASR_FORMAT", "mp4")},
                     duration_s=duration_s)


def _volc_run(audio_obj: dict, *, duration_s: int = 0) -> str:
    """火山「大模型录音文件识别」(V3 bigmodel)：submit → query 轮询。

    audio_obj 是 {"url":..} 或 {"data":<base64>,"format":..}。鉴权单个 x-api-key。
    状态在响应头 X-Api-Status-Code：20000000=完成/20000001=处理中/20000002=排队/其余=错。
    硬上限 ASR_MAX_POLL(默认20轮×3s=60s)，超时返回空，绝不阻塞主流程。
    """
    import uuid
    key = os.getenv("ASR_API_KEY", "")
    if not key or "待填" in key:
        raise AsrError("no_key")
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
    except requests.RequestException as e:
        raise AsrError("network", str(e)[:80]) from e
    sub_code = submit.headers.get("X-Api-Status-Code", "")
    if sub_code != "20000000":
        raise AsrError(sub_code, submit.headers.get("X-Api-Message", ""))
    # 几分钟的口播视频火山要转 1-3 分钟:上限太紧会全军覆没回退标题(2026-07-16 真机验证,
    # 36s 上限时相亲视频 20 轮仍 Processing)。已知时长→预算≈时长/3+20轮(上限240轮=12min);
    # 未知时长用默认 40×3s=2min。radar 走 ASR_OFF 不受影响。
    rounds = int(os.getenv("ASR_MAX_POLL", "40"))
    if duration_s:
        rounds = max(rounds, min(240, duration_s // 3 + 20))
    for _ in range(rounds):
        time.sleep(3)
        try:
            q = requests.post(f"{base}/query", headers=headers, json={}, timeout=15)
        except requests.RequestException as e:
            raise AsrError("network", str(e)[:80]) from e
        code = q.headers.get("X-Api-Status-Code", "")
        if code == "20000000":            # 完成
            res = (q.json() or {}).get("result") or {}
            try:  # 成本台账:一次成功转写记一笔
                from src import store as _store
                _store.add_cost("asr", 1, detail="volc-bigmodel")
            except Exception:  # noqa: BLE001
                pass
            if isinstance(res, dict):
                if res.get("text"):
                    return res["text"]
                return "".join(u.get("text", "") for u in (res.get("utterances") or []))
            return ""
        if code not in ("20000001", "20000002"):   # 非处理中/排队中 → 出错
            raise AsrError(code, q.headers.get("X-Api-Message", ""))
    raise AsrError("timeout", f"已等 {rounds * 3}s")


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
