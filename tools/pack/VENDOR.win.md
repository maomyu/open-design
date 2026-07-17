# tools/pack/vendor — Windows x64(2026-07-17 由 win 检出生成)

本目录被 gitignore,内容按目标平台本地重生成。当前为 **win32 x64** 产物集,
与 `apps/daemon/src/media-studio/bakuan-engine.ts` 的 win 布局约定对齐:

| 文件 | 内容/布局 | 来源 |
|---|---|---|
| `python-runtime.tar.gz` | 顶层目录改名为 `python-runtime/`,`python-runtime/python.exe` | python-build-standalone 20260623 `cpython-3.12.13+20260623-x86_64-pc-windows-msvc-install_only.tar.gz`(原顶层 `python/`) |
| `wheels/` | 90 个 cp312/abi3/py3 win_amd64 wheel | 本机 Python 3.12 `pip download -r requirements-runtime.txt -d wheels --only-binary=:all:` |
| `requirements-runtime.txt` | requirements.txt 全量 + `yt-dlp` | 手写(provision 用它离线装依赖并生成 `.venv/Scripts/yt-dlp.exe`) |
| `ffmpeg.tar.gz` | `ffmpeg/ffmpeg.exe` + `ffmpeg/ffprobe.exe` | BtbN FFmpeg-Builds `ffmpeg-master-latest-win64-gpl.zip`(不带 ffplay) |
| `lark-cli.tar.gz` | `lark-cli/lark-cli.exe`(v1.0.72,~44MB) | npm `@larksuite/cli` postinstall 下载的原生 win 二进制 |

重生成要点:
- python 小版本(3.12)必须与 wheels 的 ABI(cp312)一致;wheels 要在 win x64 + 同小版本 Python 上 `pip download`。
- 三个 tar 的顶层目录名(`python-runtime/`、`ffmpeg/`、`lark-cli/`)是 provision 的解压标记路径,不能改。
- 离线自检(等价客户机首启 provision):解 python-runtime → `python.exe -m venv` → `Scripts/pip.exe install --no-index --find-links wheels -r requirements-runtime.txt` 应零联网成功。
