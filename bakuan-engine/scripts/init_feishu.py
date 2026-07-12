"""一键在飞书多维表格里建好 12 张表及字段（按 src/feishu/tables.py 定义）。

用法：python scripts/init_feishu.py
前置：.env 已填 FEISHU_APP_ID / SECRET / BITABLE_APP_TOKEN；应用已开通多维表格读写权限。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.feishu.bitable import Bitable  # noqa: E402
from src.feishu.tables import TABLES     # noqa: E402

# 本地字段类型 → 飞书字段 type 编号
_FT = {
    "text": 1, "number": 2, "single_select": 3, "multi_select": 4,
    "datetime": 5, "checkbox": 7, "user": 11, "link": 18,
    "attachment": 17, "auto_number": 1005, "formula": 20,
}


def main():
    fs = Bitable()
    app = fs.app_token
    for name, spec in TABLES.items():
        fields = spec["fields"]
        # 建表（首字段作为主字段）
        first_name, first_type = fields[0]
        body = {"table": {"name": name,
                          "default_view_name": "表格",
                          "fields": [{"field_name": first_name, "type": _FT.get(first_type, 1)}]}}
        data = fs._req("POST", f"/bitable/v1/apps/{app}/tables", json=body)
        tid = data["table_id"]
        print(f"✓ 建表 {name} ({spec['stage']})  table_id={tid}")
        # 补其余字段
        for fname, ftype in fields[1:]:
            try:
                fs._req("POST", f"/bitable/v1/apps/{app}/tables/{tid}/fields",
                        json={"field_name": fname, "type": _FT.get(ftype, 1)})
            except Exception as e:
                print(f"   ! 字段 {fname} 建失败：{e}")
    print("\n完成。请在飞书按需把后台 5 张表『分组折叠』（右键数据表→分组）。")


if __name__ == "__main__":
    main()
