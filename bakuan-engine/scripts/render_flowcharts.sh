#!/usr/bin/env bash
# 把 docs/流程图.md 里的 Mermaid 流程图导出为 PDF 高清版（交付物）。
# 依赖：Node + @mermaid-js/mermaid-cli （npm i -g @mermaid-js/mermaid-cli）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p docs/流程图_pdf
if ! command -v mmdc >/dev/null 2>&1; then
  echo "未安装 mmdc，请先：npm i -g @mermaid-js/mermaid-cli"; exit 1
fi
# 逐个 mermaid 代码块拆出并渲染
python3 - <<'PY'
import re, pathlib
md = pathlib.Path("docs/流程图.md").read_text(encoding="utf-8")
blocks = re.findall(r"```mermaid\n(.*?)```", md, re.S)
out = pathlib.Path("docs/流程图_pdf"); out.mkdir(exist_ok=True)
for i, b in enumerate(blocks, 1):
    (out / f"flow_{i:02d}.mmd").write_text(b, encoding="utf-8")
print(f"拆出 {len(blocks)} 张流程图源到 docs/流程图_pdf/")
PY
for f in docs/流程图_pdf/*.mmd; do
  mmdc -i "$f" -o "${f%.mmd}.pdf" -b white
done
echo "已导出 PDF 到 docs/流程图_pdf/"
