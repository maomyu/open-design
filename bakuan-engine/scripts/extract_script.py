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
# 必须先导入 config.settings：它 load_dotenv(override=True) 把 .env 里的
# ASR_API_KEY/ARK 等注入环境。否则 transcribe 读到空 Key → 静默返回空文案
# (曾表现为"转写为空",实为没加载 .env,而非视频真的没口播)。
from config import settings as _settings  # noqa: E402,F401
from src.asr import transcribe as ASR  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", help="本地视频文件路径")
    ap.add_argument("--url", help="视频链接(没给 --video 时先用 yt-dlp 下载)")
    a = ap.parse_args()

    video = a.video or ""
    if not video and a.url:
        import tempfile
        out = os.path.join(tempfile.gettempdir(), f"bc_extract_{os.getpid()}.mp4")  # win 没有 /tmp
        dl_err = ""
        try:
            r = subprocess.run(
                [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-warnings",
                 "-f", "mp4/best", "-o", out, a.url],
                capture_output=True, timeout=180,
            )
            if r.returncode != 0:
                dl_err = (r.stderr or b"").decode("utf-8", "replace")[-240:].strip()
        except Exception as e:  # noqa: BLE001
            dl_err = str(e)[:200]
        video = out if os.path.exists(out) else ""
    if not video or not os.path.exists(video):
        # 下载失败的真实原因必须带出去(此前一律"没拿到视频文件",用户无从下手)。
        why = locals().get("dl_err") or ""
        msg = f"下载原视频失败:{why}——多为需要登录态/平台反爬,可先在「账号」页登录该平台再试" if why \
            else "没拿到视频文件(下载失败或路径不存在)"
        print(json.dumps({"error": msg}, ensure_ascii=False))
        return

    aud = os.path.splitext(video)[0] + ".mp3"
    # 口播仿写只需前若干分钟就能抓住风格/开头钩子;小红书/B站视频常达 10+ 分钟,全量抽音频+ASR
    # 很慢(11 分钟视频实测 ASR 49s)甚至逼近 daemon 的 300s 超时、UI 一直转圈。抽前 5 分钟音频
    # 封顶(-t 300),长视频大幅提速、避免"卡住";可用 ASR_AUDIO_CAP_SEC 环境变量覆盖(0=不封顶)。
    cap = os.getenv("ASR_AUDIO_CAP_SEC", "300").strip()
    cap_args = ["-t", cap] if cap and cap != "0" else []
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", video, *cap_args, "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", aud],
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
    except ASR.AsrError as e:      # 带码的失败:key 无效/未开通/超时/网络——原样给用户
        print(json.dumps({"error": str(e), "code": e.code}, ensure_ascii=False))
        return
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"转写失败:{e}"}, ensure_ascii=False))
        return
    finally:
        try:
            os.remove(aud)
        except OSError:
            pass

    if not transcript.strip():
        print(json.dumps({"error": "转写成功但没有文字——这条大概率是纯音乐/无口播,换一条有讲解的爆款视频", "code": "empty", "video": video}, ensure_ascii=False))
        return
    print(json.dumps({"transcript": transcript, "video": video}, ensure_ascii=False))


if __name__ == "__main__":
    main()
