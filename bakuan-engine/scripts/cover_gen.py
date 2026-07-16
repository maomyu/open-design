"""类似封面生成 · 原子 CLI(模块7,验收8-9)。

三个子命令,均输出一行 JSON(loguru 不开,daemon 从首个 { 解析):
  analyze  --ref <本地路径|URL>                       参考封面 → 视觉模型解析 → 结构化风格 JSON
  gen      --title <主标题> [--subtitle 副] [--ref ..] [--style-json '<json>|@file']
           [--platforms douyin,bilibili] [--versions 1-3] [--out-dir D] [--record-id rec..]
                                                      背景生成(Seedream/渐变兜底)+程序叠字,
                                                      背景另存 *_bg.png 供「改标题重排版」复用;
                                                      --record-id 时上传「成品内容审核库.封面成品」
  rerender --bg <既有背景png> --title <新标题> [--subtitle 副] [--platform douyin] [--out 路径]
                                                      验收9:不重出背景,仅重渲染文字出新版本

中文标题永远程序叠字(Pillow),不靠图像模型写字——100% 不错字;溢出/裁切由渲染指标
直接量出(overlay 返回 overflow),OCR 有 Key 时再比对一道。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import settings as S  # noqa: E402  载入 .env(ARK/VISION_MODEL/飞书)
from src.cover import seedream as SD  # noqa: E402

_ANALYZE_PROMPT = (
    "你是封面视觉分析师。分析这张自媒体视频封面,输出严格 JSON(不要多余文字):\n"
    '{"构图":"...", "色彩":"主色/辅色/文字色的简述", "字体层级":"主标题/副标题大小位置关系",'
    ' "人物位置":"有无人物及其位置", "留白":"标题留白区域在哪", "装饰":"边框/贴纸/箭头等",'
    ' "情绪":"整体情绪氛围", "style_prompt":"给图像模型的中文风格描述,50字内,'
    "概括构图+配色+氛围,不含任何具体文字内容\"}"
)


def _out(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def _ref_to_data_url(ref: str) -> str:
    """本地文件 → data URI;http(s) URL 原样返回。"""
    if ref.startswith("http://") or ref.startswith("https://"):
        return ref
    ext = os.path.splitext(ref)[1].lstrip(".").lower() or "jpeg"
    if ext == "jpg":
        ext = "jpeg"
    b64 = base64.b64encode(open(ref, "rb").read()).decode()
    return f"data:image/{ext};base64,{b64}"


def analyze(ref: str) -> dict:
    """视觉模型解析参考封面 → 结构化 JSON。VLM 不可用时退化为 PIL 主色提取(管道不断)。"""
    import requests
    base = (S.KEYS.ark_base or "").rstrip("/")
    key = S.KEYS.ark_key
    model = os.getenv("VISION_MODEL", "")
    # 防呆:VISION_MODEL 误配成图像生成模型(seedream/seedance)时,换真·视觉理解模型
    # (2026-07-16 实测客户 .env 配的是 doubao-seedream-5.0 → chat/completions 404)。
    if not model or "seedream" in model or "seedance" in model:
        model = "doubao-1.5-vision-pro-250328"
    if base and key and model:
        try:
            r = requests.post(
                f"{base}/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json={"model": model, "messages": [{"role": "user", "content": [
                    {"type": "text", "text": _ANALYZE_PROMPT},
                    {"type": "image_url", "image_url": {"url": _ref_to_data_url(ref)}},
                ]}], "temperature": 0.2},
                timeout=60)
            r.raise_for_status()
            txt = r.json()["choices"][0]["message"]["content"]
            start, end = txt.find("{"), txt.rfind("}")
            if start >= 0 and end > start:
                d = json.loads(txt[start:end + 1])
                d["来源"] = "vision"
                return d
        except Exception as e:  # noqa: BLE001
            fallback_reason = f"{type(e).__name__}: {str(e)[:80]}"
    else:
        fallback_reason = "未配置 VISION_MODEL/ARK"
    # 兜底:PIL 主色提取,至少让配色跟着参考图走
    try:
        from PIL import Image
        img = Image.open(ref if not ref.startswith("http") else _download(ref)).convert("RGB")
        img.thumbnail((64, 64))
        colors = img.getcolors(64 * 64) or []
        colors.sort(reverse=True)
        tops = ["#%02x%02x%02x" % c[1] for c in colors[:3]]
        return {"色彩": "/".join(tops), "style_prompt": f"主色调 {'、'.join(tops)} 的社媒封面背景",
                "来源": "palette", "降级原因": fallback_reason}
    except Exception as e:  # noqa: BLE001
        return {"style_prompt": "简洁大气的社媒封面背景", "来源": "default",
                "降级原因": f"{fallback_reason}; palette: {type(e).__name__}"}


def _download(url: str) -> str:
    import requests
    import tempfile
    p = os.path.join(tempfile.gettempdir(), f"bc_cover_ref_{os.getpid()}.jpg")
    with requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60) as r:
        r.raise_for_status()
        open(p, "wb").write(r.content)
    return p


def gen(a) -> dict:
    style: dict = {}
    if a.style_json:
        raw = a.style_json[1:] if a.style_json.startswith("@") else a.style_json
        style = json.loads(Path(raw).read_text(encoding="utf-8") if a.style_json.startswith("@") else raw)
    elif a.ref:
        style = analyze(a.ref)
    style_prompt = str(style.get("style_prompt") or "")
    # 参考封面直接喂给 Seedream 图生图(本地文件转 data URI)——「同类视觉语言」主机制;
    # VLM 结构化解析是增强(客户 ARK 开通 vision 模型后自动升级),没开通时调色板兜底。
    ref_urls = [_ref_to_data_url(a.ref)] if a.ref else None
    out_dir = a.out_dir or "./data/covers"
    os.makedirs(out_dir, exist_ok=True)
    cov = SD.SeedreamCover()
    covers = []
    for plat in [p.strip() for p in a.platforms.split(",") if p.strip()]:
        for v in range(1, max(1, min(3, a.versions)) + 1):
            req = SD.CoverRequest(platform=plat, main_title=a.title, subtitle=a.subtitle or "",
                                  style_prompt=style_prompt + (f";第{v}版换个布局" if v > 1 else ""),
                                  ref_image_urls=ref_urls)
            stem = os.path.join(out_dir, f"cover_{plat}_v{v}_{os.getpid()}")
            bg_path, out_path = f"{stem}_bg.png", f"{stem}.png"
            bg = cov._generate_background(req)
            open(bg_path, "wb").write(bg)          # 背景另存:改标题重排版复用,不再花图像模型钱
            metrics = SD._overlay_title(bg, a.title, a.subtitle or "", plat, out_path)
            ok, note = SD.ocr_check(out_path, a.title)
            covers.append({"platform": plat, "version": v, "path": os.path.abspath(out_path),
                           "bg_path": os.path.abspath(bg_path),
                           "check": {"overflow": metrics.get("overflow"), "ocr": note, "ok": ok and not metrics.get("overflow")}})
    uploaded = 0
    if a.record_id:
        from src.feishu.larkcli_bitable import LarkCliBitable
        fs = LarkCliBitable()
        for c in covers:
            rel = os.path.relpath(c["path"])   # lark-cli 要求 cwd 相对路径
            if fs.upload_attachment("成品内容审核库", a.record_id, "封面成品", rel):
                uploaded += 1
    return {"ok": True, "style": style, "covers": covers,
            **({"uploaded": uploaded} if a.record_id else {})}


def rerender(a) -> dict:
    """验收9:不重出背景,仅在既有背景上重渲染新标题。"""
    bg = open(a.bg, "rb").read()
    out = a.out or (os.path.splitext(a.bg)[0].removesuffix("_bg") + "_retitle.png")
    metrics = SD._overlay_title(bg, a.title, a.subtitle or "", a.platform, out)
    ok, note = SD.ocr_check(out, a.title)
    return {"ok": ok and not metrics.get("overflow"), "path": os.path.abspath(out),
            "check": {"overflow": metrics.get("overflow"), "ocr": note}}


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("analyze")
    p1.add_argument("--ref", required=True)
    p2 = sub.add_parser("gen")
    p2.add_argument("--title", required=True)
    p2.add_argument("--subtitle", default="")
    p2.add_argument("--ref", default="")
    p2.add_argument("--style-json", default="")
    p2.add_argument("--platforms", default="douyin")
    p2.add_argument("--versions", type=int, default=1)
    p2.add_argument("--out-dir", default="")
    p2.add_argument("--record-id", default="")
    p3 = sub.add_parser("rerender")
    p3.add_argument("--bg", required=True)
    p3.add_argument("--title", required=True)
    p3.add_argument("--subtitle", default="")
    p3.add_argument("--platform", default="douyin")
    p3.add_argument("--out", default="")
    a = ap.parse_args()
    try:
        if a.cmd == "analyze":
            _out(analyze(a.ref))
        elif a.cmd == "gen":
            _out(gen(a))
        else:
            _out(rerender(a))
    except Exception as e:  # noqa: BLE001
        _out({"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"})


if __name__ == "__main__":
    main()
