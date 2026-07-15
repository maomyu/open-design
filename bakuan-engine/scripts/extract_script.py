"""爆款视频 → 口播文案(仿写用)。

流程:本地视频文件(或先用 yt-dlp 下 URL)→ ffmpeg 抽音频(mp3/16k 单声道)→ 火山 ASR 转写。
输出一行 JSON:{"transcript": "...", "video": "本地路径"} 或 {"error": "..."}。
被 daemon /api/media-studio/extract-script 调用,让"下载→提取文案→仿写"可分步可视。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.asr import transcribe as ASR  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", help="本地视频文件路径")
    ap.add_argument("--url", help="视频链接(没给 --video 时先用 yt-dlp 下载)")
    a = ap.parse_args()

    video = a.video or ""
    if not video and a.url:
        out = f"/tmp/bc_extract_{os.getpid()}.mp4"
        try:
            subprocess.run(
                [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-warnings",
                 "-f", "mp4/best", "-o", out, a.url],
                capture_output=True, timeout=180,
            )
        except Exception:
            pass
        video = out if os.path.exists(out) else ""
    if not video or not os.path.exists(video):
        print(json.dumps({"error": "没拿到视频文件(下载失败或路径不存在)"}, ensure_ascii=False))
        return

    aud = os.path.splitext(video)[0] + ".mp3"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", video, "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", aud],
            capture_output=True, timeout=120,
        )
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"抽音频失败:{e}"}, ensure_ascii=False))
        return
    if not os.path.exists(aud):
        print(json.dumps({"error": "抽音频失败(ffmpeg 未产出音频,可能无声道)"}, ensure_ascii=False))
        return

    try:
        transcript = ASR.transcribe_local(aud) or ""
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"转写失败:{e}"}, ensure_ascii=False))
        return
    finally:
        try:
            os.remove(aud)
        except OSError:
            pass

    if not transcript.strip():
        print(json.dumps({"error": "转写为空(可能是纯音乐/无口播,或 ASR 未识别)", "video": video}, ensure_ascii=False))
        return
    print(json.dumps({"transcript": transcript, "video": video}, ensure_ascii=False))


if __name__ == "__main__":
    main()
