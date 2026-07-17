.PHONY: install demo test covers keys run scheduler stop logs

install:            ## 建虚拟环境 + 装依赖
	python3 -m venv .venv && ./.venv/bin/pip install -q -U pip && ./.venv/bin/pip install -q -r requirements.txt

demo:               ## 离线跑通全链路（无需 Key）→ data/dryrun_output.json
	DRY_RUN=1 ./.venv/bin/python -m src.pipeline --keyword "长期单身" --platforms douyin,xiaohongshu --dry-run

test:               ## 运行测试（12 项）
	DRY_RUN=1 ./.venv/bin/python -m pytest tests/ -q

covers:             ## 生成示例封面（本地叠字，无需 ARK）
	./.venv/bin/python -c "from dotenv import load_dotenv; load_dotenv('.env'); from src.cover.seedream import SeedreamCover,CoverRequest as R; c=SeedreamCover(); c.render(R(platform='douyin',main_title='为什么说单身是纯纯命好',subtitle='三步拆解婚姻真相'),'docs/sample_cover_抖音竖版.png')"

keys:               ## 自检各平台连通性
	./.venv/bin/python scripts/check_keys.py

run:                ## 实盘跑一次关键词（需 Key）：make run KW=长期单身
	./.venv/bin/python -m src.pipeline --keyword "$(KW)" --platforms douyin,xiaohongshu,bilibili,kuaishou

scheduler:          ## 启动后台定时调度
	bash scripts/start.sh
stop:               ## 停止调度
	bash scripts/stop.sh
logs:               ## 看日志
	bash scripts/logs.sh
