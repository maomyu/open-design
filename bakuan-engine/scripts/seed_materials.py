"""给「我的素材库」填 3 条男性情感赛道示范素材，供客户照着改。
运行：FEISHU_BACKEND=larkcli LARK_PROFILE=yuzhihe ./.venv/bin/python scripts/seed_materials.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("FEISHU_BACKEND", "larkcli")
from config import settings  # noqa: F401  载入 .env
from src.feishu.larkcli_bitable import LarkCliBitable

fs = LarkCliBitable()

MATERIALS = [
    {
        "素材类型": "观点", "素材标题": "脱单先提升价值，别一味讨好",
        "原始内容": "兄弟，你追不到女生，不是因为你不够舔，而是因为你没价值。"
                    "别再天天嘘寒问暖、秒回消息了，那只会让你更廉价。先把自己收拾干净、"
                    "把事业和身材搞起来，让自己成为‘被选择’的人。记住一句话：吸引大于追求。",
        "主题标签": "脱单、男性成长", "目标人群": "母胎单身男", "情绪强度": 4,
        "是否可召回": True,
    },
    {
        "素材类型": "方法", "素材标题": "相亲聊天三步破冰",
        "原始内容": "相亲别一上来就查户口。第一步先夸一个具体细节，比如‘你选的这家店很有品味’；"
                    "第二步聊她感兴趣的、能展开的话题，让她多说；第三步适度自我暴露，讲一个你的小故事，"
                    "拉近距离。全程记住：让她舒服，比你表现更重要。",
        "主题标签": "相亲、聊天技巧", "目标人群": "大龄单身男", "情绪强度": 3,
        "是否可召回": True,
    },
    {
        "素材类型": "案例", "素材标题": "学员从社恐到脱单的真实经历",
        "原始内容": "我有个学员，32岁程序员，母胎solo，一开始跟女生说话都脸红。"
                    "我让他先从每天跟便利店店员多说一句话练起，三个月后能自然搭讪，"
                    "半年后脱单。他的转变不是靠话术，是靠一次次小小的行动积累出来的自信。",
        "主题标签": "脱单、男性成长、社恐", "目标人群": "母胎单身男", "情绪强度": 5,
        "是否可召回": True,
    },
]
print("我的素材库 →", fs.batch_add("我的素材库", MATERIALS))
print("✅ 3 条示范素材已填入")
