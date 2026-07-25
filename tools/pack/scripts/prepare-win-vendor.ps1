# Prepare tools/pack/vendor for a **Windows** packaged build.
#
# Why this script exists: resources.ts warns "先跑 vendor 准备脚本" when
# tools/pack/vendor/{python-runtime.tar.gz,wheels} are missing, but no such script
# was ever checked in — the mac artifacts were produced ad hoc. vendor/ is gitignored,
# so without a recipe the Windows artifacts are one `rm -rf` away from being lost.
#
# It MUST run on Windows: the wheels have to be native win_amd64 builds, and the
# dependency set itself differs (loguru pulls colorama + win32-setctime on Windows only).
# Cross-downloading from macOS with --platform win_amd64 is not equivalent.
#
# Layout produced here is exactly what apps/daemon/src/media-studio/bakuan-engine.ts
# expects after it untars the archive into <dataDir>\engine-runtime:
#
#   python-runtime\python.exe      <- top level, no bin/ (that's the POSIX layout)
#   wheels\*.whl                   <- offline install source for `pip install --no-index`
#
# ffmpeg.tar.gz is intentionally NOT produced: the macOS vendor doesn't ship it either,
# the provisioner skips it gracefully, and only ASR audio extraction / yt-dlp muxing need it.
# If a customer build needs it, drop a ffmpeg.tar.gz containing ffmpeg\ffmpeg.exe +
# ffmpeg\ffprobe.exe next to the other artifacts.
#
# Usage (from the repo root on the Windows build box):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\pack\scripts\prepare-win-vendor.ps1
#
# ASCII-only on purpose: a BOM-less .ps1 is read as ANSI (GBK on a zh-CN box), which
# mangles UTF-8 comments and can swallow the next line's opening brace.

# NOTE: do NOT set ErrorActionPreference to Stop — PowerShell turns any native stderr
# line (pip prints warnings there) into a terminating NativeCommandError.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$vendor = Join-Path $repoRoot 'tools\pack\vendor'
$work = Join-Path $env:TEMP 'od-win-vendor'
$req = Join-Path $repoRoot 'bakuan-engine\requirements-runtime.txt'

# Keep in step with the interpreter the macOS vendor ships (wheel ABI must match: cp312).
$pyVersion = '3.12.11'
$pyRelease = '20250918'
$pyUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$pyRelease/cpython-$pyVersion+$pyRelease-x86_64-pc-windows-msvc-install_only.tar.gz"

if (-not (Test-Path $req)) { "ERROR: $req not found"; exit 1 }
New-Item -ItemType Directory -Path $work, $vendor -Force | Out-Null

$py = Join-Path $work 'python-runtime\python.exe'
if (-not (Test-Path $py)) {
  "downloading $pyUrl"
  Invoke-WebRequest -UseBasicParsing -Uri $pyUrl -OutFile (Join-Path $work 'py.tar.gz')
  tar -xzf (Join-Path $work 'py.tar.gz') -C $work
  # The archive's top-level dir is "python"; the provisioner looks for "python-runtime".
  if (Test-Path (Join-Path $work 'python')) { Rename-Item (Join-Path $work 'python') 'python-runtime' }
}
if (-not (Test-Path $py)) { "ERROR: python.exe missing after extract"; exit 1 }
"python: " + (& $py --version 2>&1)

$wheels = Join-Path $work 'wheels'
Remove-Item $wheels -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $wheels -Force | Out-Null
# --only-binary=:all: keeps the offline install from needing a compiler on the user's machine.
& $py -m pip download -r $req -d $wheels --only-binary=:all: 2>&1 | Select-Object -Last 3
$n = (Get-ChildItem $wheels -Filter *.whl -ErrorAction SilentlyContinue | Measure-Object).Count
if ($n -eq 0) { "ERROR: no wheels downloaded"; exit 1 }
"wheels: $n (native win_amd64: " + ((Get-ChildItem $wheels -Filter *win_amd64*.whl | Measure-Object).Count) + ")"

tar -czf (Join-Path $vendor 'python-runtime.tar.gz') -C $work python-runtime
Copy-Item $req (Join-Path $vendor 'requirements-runtime.txt') -Force
Remove-Item (Join-Path $vendor 'wheels') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $wheels (Join-Path $vendor 'wheels') -Recurse -Force

"--- $vendor ---"
Get-ChildItem $vendor | ForEach-Object {
  $sz = if ($_.PSIsContainer) { (Get-ChildItem $_.FullName -Recurse -File | Measure-Object Length -Sum).Sum } else { $_.Length }
  "{0,8:N1} MB  {1}" -f ($sz / 1MB), $_.Name
}
"done. Now run: pnpm tools-pack win build --to nsis"
"NOTE: clear .tmp\tools-pack\cache first if you changed sources — a cached entry restores the whole previous tree."
