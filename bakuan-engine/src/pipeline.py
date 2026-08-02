"""主链路编排：配置 → 采集 → 标准化 → 去重 → 初筛 → 评分 → 拆解 → 召回 → 脚本 → 封面 → 回写。

三种入口：
  run_keyword(kw, platforms)      按关键词跑全链路
  run_single_link(url)            手工单链接跑完整链路
  run_scheduled()                 读飞书监控配置库，按启用项定时批量跑
离线自检：加 --dry-run，用假数据+假模型跑通全链路，无需任何 Key，结果写 data/dryrun_output.json。
用法：python -m src.pipeline --keyword "长期单身" --platforms douyin,xiaohongshu [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re

from loguru import logger

from config import settings as S
from src.adapters import normalize
from src.asr import transcribe as ASR
from src.llm import router
from src.rag import recall
from src.scoring import evaluate as EV
from src.scoring import hot_score as H
from src.script import generate as GEN
from src import store


def _collect_error(platform: str, exc: BaseException) -> dict:
    """把一次采集异常压成可上报的 {platform, status, reason}。

    数据源的致命错误几乎总是 HTTP 层的（401 令牌失效、402 欠费、429 限流），
    但到了这里它已经被 tenacity 包成 RetryError、把状态码藏在最后一次尝试里。
    逐层解包取出 status_code，让上层能区分"这个词没爆款"和"你的 key 废了"。
    """
    status: int | None = None
    cur: BaseException | None = exc
    seen = 0
    while cur is not None and seen < 8:
        seen += 1
        last = getattr(cur, "last_attempt", None)          # tenacity.RetryError
        if last is not None and hasattr(last, "exception"):
            try:
                inner = last.exception()
            except Exception:  # noqa: BLE001
                inner = None
            if isinstance(inner, BaseException):
                cur = inner
                continue
        resp = getattr(cur, "response", None)               # requests.HTTPError
        code = getattr(resp, "status_code", None)
        if isinstance(code, int):
            status = code
            break
        cur = cur.__cause__ or cur.__context__
    reason = f"HTTP {status}" if status else f"{type(exc).__name__}: {exc}"
    return {"platform": platform, "status": status, "reason": reason[:200]}


class Pipeline:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self._sink: list[dict] = []          # dry-run 时收集写入项
        self._fans_cache: dict[str, int] = {}  # 作者粉丝数缓存
        self._rid_by_cid: dict[str, str] = {}  # content_id → 原始库 record_id（关联字段用）
        self.radar_items: list[dict] = []      # --radar 模式：吐给爆创选题步骤的选题候选
        self._radar_mode: bool = False         # 雷达模式：只评分选题，跳过脚本/封面
        self._feishu_broken: bool = False      # radar 下飞书回写一旦失败即上锁，后续跳过不再慢重试
        self._collect_data: dict | None = None  # 内置浏览器采集数据 {平台:[条目]}；非空则替代 API 采集
        self._criteria: dict | None = None       # 灵活爆款标准(时间窗+多组条件)；非空则替代默认初筛
        self._materials: list[dict] | None = None  # 我的素材库缓存（本次运行读一次）
        self.xhs_note_type: int | None = None    # 小红书采集内容类型:2 图文(图文笔记台)/1 视频(短视频台)/None 综合
        self.radar_tier: str | None = None       # 自动降档命中的档位名(给前端显示"按【热门】采到N条")
        self.collect_errors: list[dict] = []     # 本轮各平台的采集失败原因(带 HTTP 状态码)——见 _collect_error
        if dry_run:
            os.environ["DRY_RUN"] = "1"
            self.tik = self.dajiala = self.fs = None
        else:
            from src.adapters.dajiala_client import DajialaClient
            from src.adapters.tikhub_client import TikHubClient
            self.tik = TikHubClient()
            self.dajiala = DajialaClient()
            if os.getenv("FEISHU_BACKEND") == "larkcli":
                from src.feishu.larkcli_bitable import LarkCliBitable
                self.fs = LarkCliBitable()       # 用已授权的 lark-cli，免 App Secret
            else:
                from src.feishu.bitable import Bitable
                self.fs = Bitable()
            # 启动即读「系统配置表」热更新阈值/频率/模型（所有入口都生效，不止定时）
            try:
                from src.feishu import config_sync
                applied = config_sync.sync_from_feishu(self.fs)
                if applied:
                    logger.info(f"飞书系统配置表已生效：{applied}")
            except Exception as e:
                logger.warning(f"系统配置表读取跳过：{e}")

    # ── 采集封装（内置浏览器采集文件 / 真实 API / mock 三选一）──
    def _search(self, platform: str, keyword: str, count: int) -> list[dict]:
        # 内置浏览器采集(绕 TikHub/极致了 省钱+绕风控)：COLLECT_FILE / --collect-file 提供
        # {平台: [统一扁平条目...]}。命中即用浏览器数据，各条打 __browser__ 标记走 normalize_browser。
        if self._collect_data is not None:
            items = self._collect_data.get(platform) or self._collect_data.get(normalize.cn_platform(platform)) or []
            return [{**it, "__browser__": True} for it in items][:count] if count else [{**it, "__browser__": True} for it in items]
        if self.dry_run:
            from src.adapters import mock
            return mock.mock_search(platform, keyword, count)
        if platform == "gzh":
            return self.dajiala.search_articles(keyword)
        if platform == "channels":                 # 视频号走极致了
            return self.dajiala.search_videos(keyword)
        # 时间窗透传给 TikHub 搜索(抖音据此选 publish_time 档 + 翻页累积到 count)。
        tw = (self._criteria or {}).get("time_window", "180d") if self._criteria else "180d"
        # 小红书内容类型透传:图文笔记台只采图文(note_type=2),短视频台采视频(1)——前后端对应。
        nt = self.xhs_note_type if platform == "xiaohongshu" else None
        return self.tik.search_keyword(platform, keyword, count=count, time_window=tw, note_type=nt)

    def _comments(self, platform: str, content_id: str) -> list[str]:
        if self.dry_run:
            from src.adapters import mock
            return mock.mock_comments(platform, content_id)
        if os.getenv("RADAR_FAST") == "1":
            return []   # 选题列表速采:不逐条取评论文本(意向用内联评论数估),让分页多条也能秒出
        if self._collect_data is not None:
            return []   # 内置浏览器采集模式:不打 TikHub 取评论文本(绕开成本/风控)
        try:
            return self.tik.fetch_comments(platform, content_id)
        except Exception:
            return []

    def _get_fans(self, platform: str, author_id: str) -> int:
        """带缓存地补作者粉丝数（同作者只查一次）。"""
        if self.dry_run:
            return 0
        if self._collect_data is not None:
            return 0    # 内置浏览器采集模式:粉丝数已由采集条目提供,不打 TikHub 补
        ck = f"{platform}:{author_id}"
        if ck not in self._fans_cache:
            self._fans_cache[ck] = self.tik.fetch_fans(platform, author_id)
        return self._fans_cache[ck]

    def _transcript(self, rc: normalize.RawContent) -> str:
        if self.dry_run:
            return f"[开场]{rc.title}...[方法]三步走...[号召]关注我"
        # ⓪ 入库阶段已抓的图文全文（复用，免二次调用）
        cached = rc.raw.get("_fulltext")
        if cached:
            return self._clean(cached)
        # ① 字幕最准（部分平台带）
        sub = rc.raw.get("subtitle") or ""
        if sub.strip():
            return sub.strip()
        # ② 搜索结果自带的长 desc（少数平台有）
        body = self._clean(normalize._pick(rc.raw, "desc", "content", "body", "note_desc",
                                           "share_info.desc", "content_text", default=""))
        if len(body) > len(rc.title):
            return body
        # ③ 全文提取（额外 API，仅精处理条目触发）：公众号文章正文 / 小红书笔记正文
        full = self._fetch_fulltext(rc)
        if full and len(full) > len(rc.title):
            return full
        # ④ 音频转写：视频口播原文——默认就跑，保证每次不遗漏（有 ASR_MAX_POLL 硬上限防卡）。
        #    确实想关掉图省速度时可设 ASR_OFF=1。
        key = os.getenv("ASR_API_KEY", "")
        if os.getenv("ASR_OFF") != "1" and key and "待填" not in key:
            try:
                if rc.platform == "channels":
                    # 视频号视频加密：下载→官方WASM解密→抽音频→base64 转写
                    aud = self._channels_audio(rc)
                    if aud:
                        try:
                            txt = self._clean(ASR.transcribe_local(aud))
                        finally:
                            try:
                                os.remove(aud)
                            except OSError:
                                pass
                        if txt:
                            return txt
                elif rc.platform in ("douyin", "kuaishou", "bilibili"):
                    media = self._media_url(rc)   # 明文直链
                    if media:
                        # 主路径:本地下载→抽音频→base64 转写(火山 URL 直传拉不动抖音 CDN,
                        # 防盗链一直 Processing;本地路径与提取仿写生产路径同款,快而稳)。
                        txt = self._clean(ASR.transcribe_media_url(media))
                        if not txt:
                            # 兜底:URL 直传(部分平台直链火山可直接拉),预算按时长自适应
                            dur = normalize._to_int(normalize._pick(
                                rc.raw, "video.duration", "duration", default=0))
                            dur_s = dur // 1000 if dur > 3600 else dur
                            txt = self._clean(ASR.transcribe(media, duration_s=dur_s))
                        if txt:
                            return txt
            except Exception as e:
                logger.warning(f"ASR 转写跳过 {rc.content_id}：{e}")
        return rc.title

    @staticmethod
    def _clean(v) -> str:
        return re.sub(r"<[^>]+>", "", str(v or "")).strip()

    def _fetch_fulltext(self, rc: normalize.RawContent) -> str:
        """取图文完整正文（公众号=直接抓公开文章HTML/免费；小红书=TikHub详情）。失败返回空。"""
        try:
            if rc.platform == "gzh":
                return self._gzh_body(rc.url)
            if rc.platform == "xiaohongshu":
                if self._collect_data is not None:
                    # 内置浏览器采集模式:用采集条目自带正文,不打 TikHub 详情
                    return self._clean(rc.raw.get("_fulltext") or rc.raw.get("desc") or "")
                note = self.tik.fetch_detail("xiaohongshu", rc.content_id.split("_", 1)[-1])
                body = normalize._pick(note, "desc", "content", "note_desc", default="")
                return self._clean(body)
        except Exception as e:
            logger.warning(f"全文提取跳过 {rc.content_id}：{e}")
        return ""

    def _channels_audio(self, rc: normalize.RawContent) -> str:
        """视频号：下载加密视频 → Node 官方 WASM 解密 → ffmpeg 抽音频。返回本地 mp3 路径，失败空。"""
        import subprocess
        import requests
        du = rc.raw.get("download_url")
        dk = str(rc.raw.get("decode_key") or "")
        if not du or not dk:
            return ""
        d = "./data/tmp"
        os.makedirs(d, exist_ok=True)
        cid = re.sub(r"[^0-9A-Za-z]", "", rc.content_id)[-16:] or "wx"
        enc, dec, aud = f"{d}/{cid}.bin", f"{d}/{cid}.mp4", f"{d}/{cid}.mp3"
        try:
            r = requests.get(du, timeout=30)   # 超时收紧，慢就放弃不卡整轮
            if r.status_code != 200 or not r.content:
                return ""
            with open(enc, "wb") as f:
                f.write(r.content)
            subprocess.run(["node", "scripts/wx_decrypt.js", enc, dk, dec],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45)
            if not os.path.exists(dec):
                logger.warning(f"视频号解密失败 {rc.content_id}")
                return ""
            subprocess.run(["ffmpeg", "-y", "-i", dec, "-vn", "-acodec", "libmp3lame",
                            "-ar", "16000", "-ac", "1", aud],
                           capture_output=True, timeout=30)
            return aud if os.path.exists(aud) else ""
        except Exception as e:
            logger.warning(f"视频号音频准备失败 {rc.content_id}：{e}")
            return ""
        finally:
            for f in (enc, dec):
                try:
                    os.remove(f)
                except OSError:
                    pass

    def _media_url(self, rc: normalize.RawContent) -> str:
        """取视频可下载直链(mp4)喂给 ASR。抖音/快手走详情 play_addr；拿不到返回空。"""
        if self._collect_data is not None:
            return ""   # 内置浏览器采集模式:不打 TikHub 取视频直链(ASR 略过,不产生成本)
        try:
            det = self.tik.fetch_detail(rc.platform, rc.content_id.split("_", 1)[-1])
            for path in (("video", "play_addr"), ("video", "download_addr"),
                         ("video", "play_addr_h264")):
                node = det
                for p in path:
                    node = node.get(p) if isinstance(node, dict) else None
                    if node is None:
                        break
                if isinstance(node, dict):
                    ul = node.get("url_list") or node.get("UrlList")
                    if ul:
                        return ul[0]
            return normalize._deep_find_url(det)   # 快手等结构不同，深挖
        except Exception as e:
            logger.warning(f"取视频直链失败 {rc.content_id}：{e}")
            return ""

    @staticmethod
    def _gzh_body(url: str) -> str:
        """抓公众号文章公开 HTML，提取 js_content 正文（免费，无需极致了）。"""
        import requests
        if not url or "mp.weixin.qq.com" not in url:
            return ""
        # 用 Android 微信 UA：公众号对非 Android/Harmony 设备会返回 JS 验证页拦截
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0 (Linux; Android 12; zh-cn) "
                                       "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
                                       "Chrome/99.0 Mobile Safari/537.36 MMWEBID/1 MicroMessenger/8.0.20"},
                         timeout=20)
        html = r.text
        m = re.search(r'id="js_content"[^>]*>(.*)', html, re.S)
        if not m:
            return ""
        seg = m.group(1)
        # 正文结束标记（去掉底部工具栏/推荐/脚本）
        for mark in ('id="js_sns_ad_area"', 'class="rich_media_tool"', 'id="js_pc_qr_code"',
                     'id="content_bottom_area"', "<script"):
            i = seg.find(mark)
            if i > 0:
                seg = seg[:i]
                break
        text = re.sub(r"<[^>]+>", "", seg).replace("&nbsp;", " ").replace("&amp;", "&")
        return re.sub(r"\s+\n|\n\s+", "\n", re.sub(r"[ \t]+", " ", text)).strip()

    # ── 入口 1：关键词 ──
    # 自动降档档位阶梯(严→松):视频号(channels)纯点赞走 LIKES,其余平台走 PLAYS(播放)。
    _LADDER_PLAYS = [("大爆款", 1_000_000), ("爆款", 300_000), ("热门", 100_000), ("小热", 30_000)]
    _LADDER_LIKES = [("大爆款", 50_000), ("爆款", 20_000), ("热门", 5_000), ("小热", 2_000)]

    def _apply_tier_ladder(self, cands: list, target: int) -> tuple[list, str]:
        """自动降档总入口:**按平台各自独立降档再合并**(2026-07-19 用户定死:每个平台的爆款
        只来源于该平台,绝不混排)。同池排序有两个串平台缺陷:①兜底把抖音播放数和小红书点赞数
        放同一序列比大小,数值上抖音必然霸榜;②全局档位判定让强势平台在高档凑满就收工,弱势
        平台自己档位里的货被整体挤出。改法:候选按 rc.platform 分组,每平台各拿 target 均分
        份额(至少1条)独立走 _ladder_one,合并输出;单平台行为与原先完全一致。"""
        if not cands:
            return [], "无候选"
        by_plat: dict[str, list] = {}
        for rc in cands:
            by_plat.setdefault(rc.platform, []).append(rc)
        if len(by_plat) == 1:
            return self._ladder_one(cands, target)
        share = max(1, -(-target // len(by_plat)))   # ceil(target/平台数)
        merged: list = []
        tier_parts: list[str] = []
        for plat, group in by_plat.items():
            hits, tier = self._ladder_one(group, share)
            merged.extend(hits)
            tier_parts.append(f"{plat}:{tier}")
        return merged, " / ".join(tier_parts)

    def _ladder_one(self, cands: list, target: int) -> tuple[list, str]:
        """单平台池的档位阶梯:从严到松逐档筛候选,第一个凑够 target 条的档即用;每档都不够则
        【取头部】兜底(按指标降序,不设下线,保证永远有货)。返回 (pending=[(rc,[档名]),...], 命中档名)。
        视频号看点赞,其余平台看播放(缺播放退点赞)。"""
        if not cands:
            return [], "无候选"
        # 有播放量的(短视频)按播放档;没播放量的(小红书图文/视频号纯点赞)按点赞档——
        # 否则拿播放档的 30万+ 门槛套点赞(赞才几千),图文永远只能到「取头部」兜底。
        metric = lambda rc: rc.plays if rc.plays > 0 else rc.likes
        ladder = lambda rc: self._LADDER_PLAYS if rc.plays > 0 else self._LADDER_LIKES
        for i in range(len(self._LADDER_PLAYS)):   # 两套档数一致
            tier_hits = [(rc, [ladder(rc)[i][0]]) for rc in cands if metric(rc) >= ladder(rc)[i][1]]
            if len(tier_hits) >= target:
                return tier_hits, ladder(cands[0])[i][0]   # 档名与平台无关(同档同名)
        # 兜底:取头部(按指标降序取 max(target*2,12) 条),不设下线。
        top = sorted(cands, key=metric, reverse=True)[:max(target * 2, 12)]
        return [(rc, ["热门候选"]) for rc in top], "热门候选(取头部)"

    def run_keyword(self, keyword: str, platforms: list[str], *, count: int = 10,
                    min_threshold: int = 0) -> dict:
        logger.info(f"[关键词] {keyword} 平台={platforms} dry_run={self.dry_run}"
                    + (f" 自定门槛≥{min_threshold}" if min_threshold else ""))
        pending: list[tuple[normalize.RawContent, list[str]]] = []
        # 【自动·智能降档】criteria.auto=true:先把全部候选收集起来,循环后按档位阶梯(严→松)统一筛,
        # 凑够 target 条就停在那一档;每档都不够就取头部兜底。解决"标准太高冷门词一条采不到"。
        auto_mode = bool(self._criteria and self._criteria.get("auto"))
        auto_target = int((self._criteria or {}).get("target", 5)) if auto_mode else 5
        all_cands: list[normalize.RawContent] = []
        self.radar_tier = None
        self.collect_errors = []
        for p in platforms:
            try:
                raw = self._search(p, keyword, count)
            except Exception as e:
                # 采集失败必须留痕:只 log 一行 warning 的话,数据源整个挂掉(key 失效/欠费/
                # 接口变更)在界面上和"这个关键词没有爆款"长得一模一样。2026-07-26 客户机
                # 实况:TikHub 令牌失效 → 每次请求 401 → 候选 0 条 → 用户以为是没爆款,
                # 白等了几天。留下带状态码的原因,交给 radar 输出上报给前端。
                detail = _collect_error(p, e)
                self.collect_errors.append(detail)
                logger.warning(f"采集失败 {p}: {detail['reason']}")
                continue
            sample_likes = [normalize._to_int(normalize._pick(
                it, "likes", "statistics.digg_count", "interact_info.liked_count",
                "stat.like", "like_count", default=0)) for it in raw]
            for it in raw:
                try:
                    rc = normalize.normalize(p, it)
                    # 空 ID 的脏数据跳过。去重仅用于完整入库管道；radar 是实时选题视图，
                    # 每次都该看到当前爆款，不做「见过就跳」，否则重跑就空了。
                    # 空 ID 后缀=脏数据("平台_");strip("_")判不出(剩平台名为真值),判后缀。
                    if not rc.content_id.split("_", 1)[-1].strip("_ "):
                        continue
                    if not self._radar_mode and store.is_duplicate(rc.content_id, rc.fingerprint):
                        # 重复抓取(验收3):不重复建主记录,但记最新快照(供增速/快速起量)并把
                        # 最新互动数据刷回原始库那条既有主记录。
                        store.add_snapshot(rc.content_id, rc.likes, rc.comments, rc.collects, rc.plays)
                        self._refresh_raw_stats(rc)
                        continue
                    # 该关键词自定「最低阈值」：主指标(点赞/播放/阅读)未达标直接跳过
                    if min_threshold and max(rc.likes, rc.plays) < min_threshold:
                        continue
                    # 补作者粉丝数（搜索不带；按作者ID单独查，用于低粉爆款判定）。
                    # RADAR_FAST(选题列表速采)跳过:快手/小红书/B站粉丝不内联,逐个作者查会几十次
                    # TikHub 调用→采集超时(2026-07-15 实测快手 180s 超时的根因)。快速模式下这些平台
                    # 粉丝按 0 计(低粉爆款规则对它们失效,但默认热度门槛/高赞/高互动都不受影响;抖音粉丝
                    # 内联不受影响)。想按低粉筛这些平台可关 RADAR_FAST。
                    if (rc.fans == 0 and rc.author_id and os.getenv("RADAR_FAST") != "1"
                            and p in ("douyin", "xiaohongshu", "bilibili", "kuaishou")):
                        rc.fans = self._get_fans(p, rc.author_id)
                    # 公众号粉丝走极致了 follower_stats（0.5元/次，按账号缓存；GZH_FANS=0 可关）
                    elif (p == "gzh" and rc.fans == 0 and rc.url
                          and os.getenv("GZH_FANS", "1") == "1"):
                        ck = f"gzh:{rc.author}"
                        if ck not in self._fans_cache:
                            self._fans_cache[ck] = self.dajiala.account_followers(rc.url)
                        rc.fans = self._fans_cache[ck]
                    store.add_snapshot(rc.content_id, rc.likes, rc.comments, rc.collects, rc.plays)
                    # 自动降档模式:先收集全部候选,判定移到循环后按阶梯统一做。
                    if auto_mode:
                        all_cands.append(rc)
                        continue
                    # 用户传了灵活标准(时间窗+组合条件)就按它判；否则用默认初筛规则。
                    if self._criteria is not None:
                        from src.scoring import criteria as CR
                        ok, reason = CR.match(CR.Metrics(
                            fans=rc.fans, plays=rc.plays, likes=rc.likes,
                            comments=rc.comments, collects=rc.collects, publish_time=rc.publish_time),
                            self._criteria)
                        hits = [reason] if ok else []
                    else:
                        hits = H.prefilter(H.Content(
                            content_id=rc.content_id, platform=p, fans=rc.fans, likes=rc.likes,
                            plays=rc.plays, comments=rc.comments, collects=rc.collects,
                            shares=rc.shares, keyword_sample_likes=sample_likes,
                            growth_per_hour=store.growth_per_hour(rc.content_id)))
                    if hits:
                        pending.append((rc, hits))
                except Exception as e:   # 单条脏数据不影响本平台其余条目
                    logger.warning(f"跳过异常条目 {p}: {e}")
                    continue
        # 【自动·智能降档】所有平台候选采齐后,按档位阶梯统一筛,凑够 auto_target 停,不够取头部兜底。
        if auto_mode:
            pending, self.radar_tier = self._apply_tier_ladder(all_cands, auto_target)
            logger.info(f"[自动降档] 命中档位「{self.radar_tier}」→ {len(pending)} 条(候选 {len(all_cands)})")
        # 批量写原始库（一次 lark-cli 调用，避免 N 个子进程拖慢）。
        # 已入库过的内容(radar 重复采集常见)不重建主记录(验收3)——复用既有 record_id。
        new_pending: list[tuple] = []   # 真正要新建主记录的 (rc, hits)
        dup_pending: list[tuple] = []   # 已有主记录的 (rc, 既有record_id)
        for rc, hits in pending:
            prev = store.feishu_rid(rc.content_id)
            if prev:
                dup_pending.append((rc, prev))
            else:
                new_pending.append((rc, hits))
        raw_fields = []
        gzh_xhs = sum(1 for rc, _ in new_pending if rc.platform in ("gzh", "xiaohongshu"))
        for rc, hits in new_pending:
            f = rc.to_feishu()
            f["命中规则"] = hits
            f["处理状态"] = "待转写"
            # 图文(公众号/小红书)正文≠标题、价值高：入库阶段就抓全文（视频口播原文靠 ASR，仅精处理时抓）
            if rc.platform in ("gzh", "xiaohongshu"):
                full = self._fetch_fulltext(rc)
                if full and len(full) > len(rc.title):
                    f["原视频文案"] = full
                    rc.raw["_fulltext"] = full   # 供 _transcript 复用，免二次调用
            raw_fields.append(f)
        if gzh_xhs:
            logger.info(f"图文全文提取：{gzh_xhs} 条(公众号/小红书)")
        ids = self._add_batch("爆款内容原始库", raw_fields)
        candidates: list[normalize.RawContent] = []
        for (rc, hits), rid in zip(new_pending, ids + [""] * (len(new_pending) - len(ids))):
            store.mark_seen(rc.content_id, rc.fingerprint, rc.platform, rid)
            self._rid_by_cid[rc.content_id] = rid   # 原始库 record_id，供下游关联字段
            candidates.append(rc)
        for rc, prev in dup_pending:
            store.mark_seen(rc.content_id, rc.fingerprint, rc.platform, prev)  # 只刷 last_seen
            self._rid_by_cid[rc.content_id] = prev
            candidates.append(rc)
        if dup_pending:
            logger.info(f"重复内容 {len(dup_pending)} 条:不重建主记录,复用既有原始库记录")
        logger.info(f"入候选池 {len(candidates)} 条")
        # 脚本/封面很耗时：只精处理"优先级最高的前 N 条"，其余已入原始库，可稍后再处理。
        # 这样一次运行几分钟内完成，稳落在 Hermes/命令超时内。
        max_process = int(os.getenv("MAX_PROCESS", "5"))   # ASR默认开，稍降处理量控总时长
        # 按平台分组各自按点赞排序，再轮流取——保证每个平台(含视频号)都有条目被精处理，
        # 而不是被点赞量级最高的单一平台(通常抖音)占满前 N。
        groups: dict[str, list] = {}
        for rc in sorted(candidates, key=lambda r: r.likes, reverse=True):
            groups.setdefault(rc.platform, []).append(rc)
        to_process: list[normalize.RawContent] = []
        while len(to_process) < max_process and any(groups.values()):
            for p in list(groups):
                if groups[p]:
                    to_process.append(groups[p].pop(0))
                    if len(to_process) >= max_process:
                        break
        logger.info(f"本轮精处理 {len(to_process)} 条（平台轮流，其余 {len(candidates)-len(to_process)} 条仅入库）")
        # 批量内容评分(2026-07-22 用户拍板):本地 CLI 智能体一调用一进程,逐条评分 N 次
        # 进程启动是整轮慢的主因——先取齐文案/评论,一次调用评多条(缺条自动回退逐条)。
        prefetched: dict[str, dict] = {}
        for rc in to_process:
            prefetched[rc.content_id] = {
                "transcript": self._transcript(rc),
                "comments": self._comments(rc.platform, rc.content_id),
            }
        cdims_list = EV.batch_content_dims(
            [(rc.title, prefetched[rc.content_id]["transcript"]) for rc in to_process])
        for rc, cd in zip(to_process, cdims_list):
            prefetched[rc.content_id]["cdims"] = cd
        generated = sum(1 for rc in to_process
                        if self._process_candidate(rc, raw_rid=self._rid_by_cid.get(rc.content_id, ""),
                                                   prefetched=prefetched.get(rc.content_id)))
        result = {"keyword": keyword, "candidates": len(candidates),
                  "processed": len(to_process), "generated": generated,
                  "archived_only": len(candidates) - len(to_process),
                  "cost": router.cost_summary()}
        if self.dry_run:
            self._dump()
            result["sink_records"] = len(self._sink)
        return result

    # ── 入口 2：单链接 ──
    def run_single_link(self, url: str) -> dict:
        from src.adapters.tikhub_client import detect_platform
        platform = detect_platform(url)
        if not platform:
            return {"error": f"无法识别平台：{url}"}
        logger.info(f"[单链接] {platform} {url}")
        if self.dry_run:
            from src.adapters import mock
            item = mock.mock_search(platform, "单链接", 1)[0]
        else:
            import re
            from urllib.parse import urlparse, parse_qs
            xsec_token = (parse_qs(urlparse(url).query).get("xsec_token") or [""])[0]
            path = url.split("?")[0].rstrip("/")
            m = re.search(r"/(?:video|short-video|note|explore|s)/([A-Za-z0-9_-]+)", path)
            aid = m.group(1) if m else path.split("/")[-1]
            item = self.tik.fetch_detail(platform, aid, xsec_token=xsec_token)
            if not item:
                if platform in ("xiaohongshu", "xhs"):
                    # 已级联 精确(xsec_token)/图文/视频 三端点仍不中:多为笔记已删或 ID 不对。
                    return {"error": f"小红书单链接取不到本条(已试 图文/视频/精确 三端点)——笔记可能已删除"
                                     f"或链接不完整;可换带 xsec_token 的完整分享链接重试,或用关键词采集。aid={aid}"}
                # 失败不丢任务(验收11):进失败队列,od baokuan retry 可重跑
                self._report_failure("link", {"url": url, "platform": platform},
                                     RuntimeError(f"取详情失败 aid={aid}"))
                return {"error": f"取详情失败(可能是短链需先跳转或ID解析问题)：aid={aid},已进失败队列"}
        rc = normalize.normalize(platform, item)
        # 详情返回空壳(如无效ID时 TikHub 返回空对象)→ content_id 为「平台_」空后缀,拒收并
        # 入失败队列,绝不带垃圾数据往下走(2026-07-16 真测:假ID曾以 content_id="douyin_" 继续跑;
        # 注意 strip("_") 判不出这种——"douyin_".strip("_")=="douyin" 为真值,必须判 ID 后缀)。
        if not rc.content_id.split("_", 1)[-1].strip("_ "):
            self._report_failure("link", {"url": url, "platform": platform},
                                 RuntimeError(f"详情返回空数据(无内容ID),aid={aid}"))
            return {"error": "取详情失败(返回空数据),已进失败队列"}
        # 验收3:已入库过的内容不重复建主记录——复用既有 record_id 并刷新最新数据,
        # 拆解/脚本照常重跑(用户点名要处理这条链接,产出新版成品)。
        prev = store.feishu_rid(rc.content_id)
        if prev:
            store.add_snapshot(rc.content_id, rc.likes, rc.comments, rc.collects, rc.plays)
            self._refresh_raw_stats(rc)
            raw_rid = prev
            logger.info(f"[单链接] 内容已在原始库,复用主记录 {prev}")
        else:
            raw_rid = self._write_raw(rc, ["单链接手动"])
            store.mark_seen(rc.content_id, rc.fingerprint, platform, raw_rid)
        ok = self._process_candidate(rc, raw_rid=raw_rid)
        if self.dry_run:
            self._dump()
        return {"platform": platform, "content_id": rc.content_id, "generated": ok}

    # ── 入口 2b：竞品账号监控（验收：按时间窗采集指定账号近作品）──
    def run_account(self, account: str, platforms: list[str], *,
                    time_window: str = "7d", count: int = 20) -> dict:
        logger.info(f"[竞品账号] {account} 平台={platforms} 窗口={time_window}")
        candidates: list[normalize.RawContent] = []
        for p in platforms:
            try:
                if self.dry_run:
                    from src.adapters import mock
                    raw = mock.mock_account_posts(p, account, count)
                    recent = mock.mock_account_recent_likes(p, account)
                else:
                    # 优先按主页链接/ID 抓该账号自己的作品；拿不到再降级为关键词搜
                    raw = self.tik.fetch_account_videos(p, account, count=count)
                    if not raw:
                        logger.info(f"[竞品账号] {p} 无法按ID取作品，降级关键词搜（建议填主页链接）")
                        raw = self.tik.search_keyword(p, account, count=count)
                    recent = [normalize._to_int(normalize._pick(
                        it, "statistics.digg_count", "stat.like", "like_count", default=0)) for it in raw]
            except Exception as e:
                logger.warning(f"账号采集失败 {p}: {e}")
                continue
            skipped_window = 0
            for it in raw:
                rc = normalize.normalize(p, it)
                # 验收2:按指定时间窗采集——窗口外发布的作品不收(此前 time_window 只打日志没生效)。
                if not _within_window(rc.publish_time, time_window):
                    skipped_window += 1
                    continue
                if store.is_duplicate(rc.content_id, rc.fingerprint):
                    # 重复抓取(验收3):不重建主记录,但记快照+刷新最新数据。
                    store.add_snapshot(rc.content_id, rc.likes, rc.comments, rc.collects, rc.plays)
                    self._refresh_raw_stats(rc)
                    continue
                rid = self._write_raw(rc, ["竞品账号监控"])
                store.mark_seen(rc.content_id, rc.fingerprint, p, rid)
                candidates.append((rc, recent, rid))
            if skipped_window:
                logger.info(f"[竞品账号] {p} 窗口外跳过 {skipped_window} 条(时间窗 {time_window})")
        # 批量内容评分(同 run_keyword):账号监控候选全量精处理,逐条 LLM 进程启动开销更大。
        prefetched_acct: dict[str, dict] = {}
        for rc, _recent, _rid in candidates:
            prefetched_acct[rc.content_id] = {
                "transcript": self._transcript(rc),
                "comments": self._comments(rc.platform, rc.content_id),
            }
        cdims_acct = EV.batch_content_dims(
            [(rc.title, prefetched_acct[rc.content_id]["transcript"]) for rc, _, _ in candidates])
        for (rc, _, _), cd in zip(candidates, cdims_acct):
            prefetched_acct[rc.content_id]["cdims"] = cd
        generated = sum(1 for rc, recent, rid in candidates
                        if self._process_candidate(rc, account_recent_likes=recent, raw_rid=rid,
                                                   prefetched=prefetched_acct.get(rc.content_id)))
        if self.dry_run:
            self._dump()
        return {"account": account, "candidates": len(candidates), "generated": generated}

    # ── 入口 4：重新生成（验收：飞书状态改「重新生成」→ 出新版本保留旧版）──
    def regenerate(self) -> dict:
        rows = self.fs.list_records("成品内容审核库")
        # lark-cli 后端不下推筛选，这里客户端过滤出"重新生成"的记录
        rows = [r for r in rows if _txt(r.get("fields", {}).get("审核状态")) == "重新生成"]
        logger.info(f"[重新生成] 待处理 {len(rows)} 条")
        done = 0
        for r in rows:
            try:
                f = r.get("fields", {})
                old_ver = int(f.get("生成版本", 1) or 1)
                title = _txt(f.get("平台标题"))
                decon = {"hook": title, "structure": "沿用"}
                style = self._current_style()
                materials = self._recall_materials(title)
                for mode in _script_modes():
                    script = GEN.generate(decon, materials, style, mode)
                    fields = script.to_feishu(_txt(f.get("平台版本")), version=old_ver + 1)
                    self._add("成品内容审核库", fields)   # 新版本，旧版保留
                self.fs.update_record("成品内容审核库", r["record_id"], {"审核状态": "已重生成"})
                done += 1
            except Exception as e:  # noqa: BLE001  单条失败不拖垮整轮,进失败队列
                self._report_failure("regenerate", {"record_id": r.get("record_id", "")}, e)
        return {"regenerated": done}

    # ── 入口 3：定时批量 ──
    def run_scheduled(self) -> dict:
        if not self.dry_run:
            from src.feishu import config_sync
            applied = config_sync.sync_from_feishu(self.fs)
            if applied:
                logger.info(f"飞书配置热更新生效：{applied}")
        rows = self.fs.list_records("监控配置库", filter_="CurrentValue.[是否启用]=true")
        logger.info(f"[定时] 启用配置 {len(rows)} 条")
        summary = []
        for r in rows:
            f = r.get("fields", {})
            kw = _txt(f.get("关键词/账号"))
            platforms = _parse_platforms(f.get("平台")) or S.PLATFORMS
            thr = int(float(_txt(f.get("最低阈值")) or 0)) if _txt(f.get("最低阈值")) else 0
            if not kw:
                continue
            try:
                if _txt(f.get("类型")) == "竞品账号":
                    summary.append(self.run_account(kw, platforms,
                                                    time_window=_txt(f.get("时间窗")) or "7d"))
                else:
                    summary.append(self.run_keyword(kw, platforms, min_threshold=thr))
            except Exception as e:  # noqa: BLE001  单项失败不拖垮整轮定时,进失败队列可重跑
                kind = "account" if _txt(f.get("类型")) == "竞品账号" else "keyword"
                self._report_failure(kind, {"keyword": kw, "platforms": platforms,
                                            "min_threshold": thr,
                                            "time_window": _txt(f.get("时间窗")) or "7d"}, e)
                summary.append({"keyword": kw, "error": str(e)[:120]})
        self.regenerate()   # 每轮顺带处理「重新生成」
        # 顺带把本轮采到的选题候选吐回去——此前只返回计数,daemon 拿不到内容,监控采的爆款
        # 只存在于飞书,创作台候选列表里一条都看不到("监控到的视频在哪操作?" 2026-08-02 客户反馈)。
        # daemon 收到后回灌本地 media_topics,用户在创作台就能直接「去创作」。
        items = sorted(self.radar_items,
                       key=lambda x: (x.get("流量爆款分", 0) + x.get("精准意向分", 0)),
                       reverse=True)
        return {"runs": summary, "选题候选": items}

    # ── 候选 → 评分 → 脚本 → 封面 → 复盘/成本 ──
    def _process_candidate(self, rc: normalize.RawContent, *,
                           account_recent_likes: list[int] | None = None,
                           raw_rid: str = "",
                           prefetched: dict | None = None) -> bool:
        try:
            # 原生关联字段值：指向「爆款内容原始库」那条记录（空则不写关联）
            link = [{"id": raw_rid}] if raw_rid else None
            # prefetched(2026-07-22 批量评分):调用方已取齐 文案/评论/内容维度评分,
            # 不再逐条重取——批量场景下省掉 N-1 次重复抓取与 N-1 次 CLI 进程启动。
            prefetched = prefetched or {}
            transcript = prefetched["transcript"] if "transcript" in prefetched else self._transcript(rc)
            # 原视频文案(口播原文/图文正文)回写原始库那条记录，供审核与追溯
            if raw_rid and transcript and transcript != rc.title:
                try:
                    self.fs.update_record("爆款内容原始库", raw_rid, {"原视频文案": transcript})
                except Exception as e:
                    logger.warning(f"回写原视频文案跳过：{e}")
            comments = prefetched["comments"] if "comments" in prefetched else self._comments(rc.platform, rc.content_id)
            ev = EV.evaluate(rc, transcript=transcript, comments=comments,
                             account_recent_likes=account_recent_likes,
                             growth_per_hour=store.growth_per_hour(rc.content_id),
                             cdims=prefetched.get("cdims"))
            topic_rid = self._write_topic(rc, ev, link)   # 选题池 record_id(供审核库关联)
            topic_link = [{"id": topic_rid}] if topic_rid else None
            if self._radar_mode:
                return True    # 雷达模式：评分选题即止，跳过拆解/脚本/封面
            if ev.traffic < 65 and ev.intent < 65:
                return False   # 仅归档，不自动生成
            decon = GEN.deconstruct(rc.title, transcript,
                                    {"likes": rc.likes, "comments": rc.comments})
            # 把 AI 爆点拆解写进「爆点拆解库」（关联爆款=原始库记录）
            self._add("爆点拆解库", {
                "关联内容": link, "选题类型": str(decon.get("selectopic", "")),
                "前3秒钩子": str(decon.get("hook", "")), "核心矛盾": str(decon.get("conflict", "")),
                "用户痛点": str(decon.get("pain", "")),
                "情绪点": decon.get("emotion") if isinstance(decon.get("emotion"), list) else str(decon.get("emotion", "")),
                "争议点": str(decon.get("controversy", "")), "内容结构": str(decon.get("structure", "")),
                "可借鉴结构": str(decon.get("reusable", "")), "不应复制元素": str(decon.get("no_copy", "")),
                "转化机会": str(decon.get("chance", "")), "模型/Prompt版本": "deepseek/v1",
                "原视频文案": transcript if transcript != rc.title else "",
            })
            materials = self._recall_materials(rc.title)
            style = self._current_style()
            last_script = None
            last_rid = ""
            for mode in _script_modes():
                last_script = GEN.generate(decon, materials, style, mode, original_text=transcript)
                script_fields = last_script.to_feishu(rc.platform, version=1)
                script_fields["关联选题"] = topic_link   # 审核库→选题池 真双向关联
                last_rid = self._add("成品内容审核库", script_fields)
            # 封面(Seedream)最慢：批量默认不出图，需要时设 COVER_IN_BATCH=1；出图后上传到该脚本记录
            if last_script and os.getenv("COVER_IN_BATCH") == "1":
                self._make_cover(rc, last_script, last_rid)
            review = {"平台": normalize.cn_platform(rc.platform),
                      "模型/接口成本": router.cost_summary().get("calls", 0),
                      "复盘结论": f"待发布；判定理由：{ev.reason}",
                      "关联成品": [{"id": last_rid}] if last_rid else None}   # 复盘库→审核库 真双向关联
            self._add("发布复盘库", review)
            return True
        except Exception as e:
            logger.exception(f"处理失败 {rc.content_id}: {e}")
            # 验收11:失败不丢任务——进本地失败队列(od baokuan retry 可重跑),
            # 并写一条复盘库「错误摘要」让客户在飞书直接看到失败原因。
            self._report_failure("candidate",
                                 {"platform": rc.platform, "content_id": rc.content_id, "url": rc.url},
                                 e)
            return False

    def _report_failure(self, kind: str, payload: dict, exc: Exception) -> None:
        """失败上报三件套:本地失败队列 + 日志 + 飞书复盘库错误摘要(可见原因)。绝不再抛。

        重试期间(ops.py retry 设 BC_NO_ENQUEUE=1)不再重复入队——原条目还在 pending,
        再入队会让队列越滚越多(2026-07-17 打包实测发现)。"""
        reason = f"{type(exc).__name__}: {str(exc)[:200]}"
        try:
            if os.getenv("BC_NO_ENQUEUE") != "1":
                fid = store.enqueue_failure(kind, payload, reason)
                logger.warning(f"[失败队列] #{fid} {kind} 已入队:{reason[:80]}")
            else:
                logger.warning(f"[失败队列] 重试仍失败(保留原条目):{reason[:80]}")
        except Exception:  # noqa: BLE001
            pass
        try:
            self._add("发布复盘库", {
                "平台": normalize.cn_platform(str(payload.get("platform") or "")) or "",
                "复盘结论": f"任务失败({kind}),已进失败队列,可用 od baokuan retry 重跑",
                "错误摘要": reason,
            })
        except Exception:  # noqa: BLE001
            pass

    def _make_cover(self, rc: normalize.RawContent, script, record_id: str = "") -> None:
        """封面：Seedream 出背景+中文叠字，上传到成品记录的「封面成品」附件字段。"""
        title = script.cover_titles[0] if script.cover_titles else script.platform_title
        plat = "bilibili" if rc.platform == "bilibili" else "douyin"
        if self.dry_run:
            return
        try:
            from src.cover.seedream import CoverRequest, SeedreamCover
            out = f"./data/covers/{rc.content_id}_{plat}.png"
            os.makedirs(os.path.dirname(out), exist_ok=True)
            SeedreamCover().render(CoverRequest(platform=plat, main_title=title), out)
            if record_id and hasattr(self.fs, "upload_attachment"):
                ok = self.fs.upload_attachment("成品内容审核库", record_id, "封面成品", out)
                logger.info(f"封面{'已上传飞书' if ok else '上传失败'}: {title}")
        except Exception as e:
            logger.warning(f"封面生成/上传跳过：{e}")

    # ── 写入抽象：真实写飞书 / dry-run 收集 ──
    def _add(self, table: str, fields: dict) -> str:
        fields = {k: v for k, v in fields.items() if v is not None}  # 丢掉空值(如无关联时)
        if self.dry_run:
            self._sink.append({"table": table, "fields": fields})
            return f"dry_{len(self._sink)}"
        if self._radar_mode and self._feishu_broken:
            return ""  # radar 下飞书已判定不可用：瞬间跳过，别再慢重试
        try:
            return self.fs.add_record(table, fields)
        except Exception as e:  # noqa: BLE001
            return self._feishu_soft_fail(table, e)

    def _add_batch(self, table: str, fields_list: list[dict]) -> list[str]:
        """批量写入（真实模式一次 lark-cli 调用，最多 200/批）。"""
        if not fields_list:
            return []
        if self.dry_run:
            for f in fields_list:
                self._sink.append({"table": table, "fields": f})
            return [f"dry_{i}" for i in range(len(fields_list))]
        if self._radar_mode and self._feishu_broken:
            return []
        ids: list[str] = []
        try:
            for i in range(0, len(fields_list), 200):
                ids.extend(self.fs.batch_add(table, fields_list[i:i + 200]))
        except Exception as e:  # noqa: BLE001
            self._feishu_soft_fail(table, e)
        return ids

    def _feishu_soft_fail(self, table: str, exc: Exception) -> str:
        """飞书回写失败的统一兜底。

        radar 模式(给爆创选题步骤用)必须稳出选题 JSON，飞书数据中心是加分项：
        第一次写失败即「上锁」(_feishu_broken)，后续所有写入瞬间跳过，不再慢重试，
        保证雷达秒级产出选题。非 radar 的完整管道遇到飞书写失败时如实抛出。
        """
        if self._radar_mode:
            if not self._feishu_broken:
                self._feishu_broken = True
                logger.warning(f"[radar] 飞书数据中心暂不可用(未连接/未建表)，本轮跳过回写、只产出选题：{type(exc).__name__}: {str(exc)[:100]}")
            return ""
        raise exc

    def _refresh_raw_stats(self, rc: normalize.RawContent) -> None:
        """重复抓取时把最新互动数据刷回「爆款内容原始库」既有主记录(不新建,best-effort)。

        验收3 的后半句:同一内容重复抓取→不重复建主记录,但更新最新数据快照。本地
        snapshot 表负责增速计算;这里把飞书主记录的可见数据也刷新,客户看到的是最新值。"""
        if self.dry_run:
            return
        rid = store.feishu_rid(rc.content_id)
        if not rid:
            return
        try:
            import time as _t
            self.fs.update_record("爆款内容原始库", rid, {
                "播放/阅读": rc.plays, "点赞": rc.likes, "评论": rc.comments,
                "收藏/投币": rc.collects, "转发": rc.shares,
                "最近更新": normalize._fmt_time(int(_t.time())),
            })
        except Exception as e:  # noqa: BLE001
            logger.warning(f"刷新原始库数据跳过 {rc.content_id}: {type(e).__name__}: {str(e)[:80]}")

    def _write_raw(self, rc: normalize.RawContent, hits: list[str]) -> str:
        fields = rc.to_feishu()
        fields["命中规则"] = hits
        fields["处理状态"] = "待转写"
        return self._add("爆款内容原始库", fields)

    def _write_topic(self, rc: normalize.RawContent, ev: EV.Evaluation,
                     link: list[dict] | None = None) -> str:
        # 收集给爆创「选题步骤」的选题候选(标题/平台/热度/来源/评分/推荐承接)
        item = {
            "标题": rc.title, "平台": normalize.cn_platform(rc.platform),
            "流量爆款分": ev.traffic, "精准意向分": ev.intent,
            "热度": ev.traffic_grade, "所属榜单": EV.classify_boards(ev),
            "查看原文": rc.url,
            "点赞": rc.likes, "播放": rc.plays, "评论": rc.comments,
            "收藏": rc.collects, "粉丝": rc.fans,
            "高频用户问题": ev.top_questions, "推荐承接服务": ev.recommend_service,
            "评分理由": ev.reason,
        }
        # 小红书图文:把【本条】原文案(desc)+ 原图直链一并带出,给图文笔记台「提取图文仿写」用。
        # 搜索结果自带完整 desc + images_list,直接用它保证【和用户点的这条一致】——详情接口
        # (get_video_note_detail)按 id 返回的是推荐流不是本条,内容对不上号(2026-07-16 用户报)。
        raw = rc.raw if isinstance(getattr(rc, "raw", None), dict) else {}
        if rc.platform == "xiaohongshu" and raw.get("images_list"):
            imgs = []
            for it in raw.get("images_list") or []:
                if isinstance(it, dict):
                    u = it.get("url_size_large") or it.get("url") or it.get("original")
                    if u:
                        imgs.append(u)
            item["原文案"] = (raw.get("desc") or raw.get("title") or "").strip()
            item["原图"] = imgs
        self.radar_items.append(item)
        # 选题池「来源内容」是真双向关联字段 → 指向「爆款内容原始库」那条记录,
        # 客户在飞书点一下即可跳到原始爆款。返回本条选题的 record_id,供审核库反查关联。
        return self._add("今日爆款选题池", {
            "来源内容": link,
            "流量爆款分": ev.traffic, "精准意向分": ev.intent,
            "内容类型": EV.content_type(ev), "推荐优先级": ev.traffic_grade,
            "所属榜单": EV.classify_boards(ev), "评分理由": ev.reason,
            "高频用户问题": "；".join(ev.top_questions),
            "推荐承接服务": ev.recommend_service,
        })

    def _recall_materials(self, query: str, *, topk: int = 5) -> list[str]:
        """从飞书「我的素材库」按主题标签匹配，返回你自己的素材喂给脚本。

        简单标签/关键词匹配（素材量小足够，无需向量库）；无匹配也给几条，保证脚本有料。
        只取「是否可召回」打勾的。
        """
        if self.dry_run:
            return ["我的观点素材A", "我的方法素材B"]
        if self._materials is None:
            try:
                rows = self.fs.list_records("我的素材库", filter_="CurrentValue.[是否可召回]=true")
            except Exception:
                rows = []
            self._materials = []
            for r in rows:
                f = r.get("fields", {})
                content = _txt(f.get("原始内容"))
                if not content:
                    continue
                tags = [t for t in _txt(f.get("主题标签")).replace("、", " ").split() if t]
                self._materials.append({"title": _txt(f.get("素材标题")),
                                        "content": content, "tags": tags})
            if self._materials:
                logger.info(f"我的素材库：加载可召回素材 {len(self._materials)} 条")
        if not self._materials:
            return []
        q = query or ""

        def score(m):
            return sum(1 for t in m["tags"] if t in q)
        ranked = sorted(self._materials, key=score, reverse=True)
        picked = [m for m in ranked if score(m) > 0][:topk] or ranked[:min(topk, 3)]
        return [f"{m['title']}：{m['content']}" if m["title"] else m["content"] for m in picked]

    def _current_style(self) -> dict | None:
        if self.dry_run:
            return None
        try:
            rows = self.fs.list_records("风格画像库", filter_="CurrentValue.[是否生效]=true")
            return rows[0].get("fields") if rows else None
        except Exception:
            return None

    def _dump(self) -> None:
        os.makedirs("./data", exist_ok=True)
        with open("./data/dryrun_output.json", "w", encoding="utf-8") as f:
            json.dump(self._sink, f, ensure_ascii=False, indent=2)
        logger.info(f"dry-run 结果已写入 data/dryrun_output.json（{len(self._sink)} 条）")


def _txt(v) -> str:
    if isinstance(v, list) and v:
        return v[0].get("text", "") if isinstance(v[0], dict) else str(v[0])
    return str(v or "")


_PLAT_CN = {"抖音": "douyin", "小红书": "xiaohongshu", "b站": "bilibili", "B站": "bilibili",
            "快手": "kuaishou", "公众号": "gzh", "视频号": "channels"}


def _win_seconds(window: str) -> int:
    """时间窗字符串→秒。支持 1d/7d/30d/180d(及任意 Nd/Nh);解析失败按 7d。"""
    m = re.match(r"^\s*(\d+)\s*([dh])\s*$", str(window or "").lower())
    if not m:
        return 7 * 86400
    return int(m.group(1)) * (86400 if m.group(2) == "d" else 3600)


def _within_window(publish_ts: int | float, window: str) -> bool:
    """发布时间是否落在时间窗内。无发布时间(0/缺失)不淘汰——宁可多收不漏。"""
    if not publish_ts:
        return True
    import time as _t
    ts = publish_ts / 1000 if publish_ts > 1e12 else publish_ts
    return (_t.time() - ts) <= _win_seconds(window)


def _script_modes() -> list[str]:
    """脚本版本：默认只写一版（rewrite=按你风格改写）。要两版设 SCRIPT_MODES=imitate,rewrite。"""
    raw = os.getenv("SCRIPT_MODES", "rewrite")
    modes = [m.strip() for m in raw.split(",") if m.strip() in ("imitate", "rewrite")]
    return modes or ["rewrite"]


_PLAT_CODES = {"douyin", "xiaohongshu", "bilibili", "kuaishou", "gzh", "channels"}


def _parse_platforms(v) -> list[str]:
    """把「平台」多选字段转成内部代号列表。中文标签(抖音/小红书…)和内部代号
    (douyin/xiaohongshu…)【两种都认】——od baokuan/监控库传中文名,web 传代号,都要能跑。
    list 或顿号/逗号串均可;空→[]（上层用默认全平台）。"""
    if not v:
        return []
    if isinstance(v, list):
        names = [x.get("text", x) if isinstance(x, dict) else x for x in v]
    else:
        names = str(v).replace("、", ",").replace(" ", ",").split(",")
    out: list[str] = []
    for n in names:
        n = str(n).strip()
        if n in _PLAT_CN:
            out.append(_PLAT_CN[n])
        elif n in _PLAT_CODES:
            out.append(n)
    return out


def main():
    ap = argparse.ArgumentParser(description="自媒体爆款监控主链路")
    ap.add_argument("--keyword")
    ap.add_argument("--account", help="竞品账号监控")
    ap.add_argument("--platforms", default=",".join(S.PLATFORMS))
    ap.add_argument("--link")
    ap.add_argument("--scheduled", action="store_true")
    ap.add_argument("--regenerate", action="store_true", help="处理飞书「重新生成」")
    ap.add_argument("--min-threshold", type=int, default=0, help="本关键词自定最低点赞/热度门槛")
    ap.add_argument("--dry-run", action="store_true", help="离线假数据跑通全链路，无需 Key")
    ap.add_argument("--radar", action="store_true",
                    help="爆款雷达：只输出选题候选JSON(给爆创选题步骤用),不出脚本")
    ap.add_argument("--collect-file",
                    help="内置浏览器采集的数据文件(JSON: {平台:[条目...]}),提供后绕过 TikHub/极致了 API 采集")
    ap.add_argument("--criteria",
                    help='灵活爆款标准 JSON(或 @文件): {"time_window":"7d","rules":[{"fans_max":3000,"plays_min":100000}]}')
    ap.add_argument("--xhs-note-type", type=int, choices=[1, 2],
                    help="小红书内容类型:2 图文(图文笔记台)/1 视频(短视频台);不传=综合。前后端对应用。")
    ap.add_argument("--time-window", default="7d", help="竞品账号采集时间窗(1d/7d/30d/180d)")
    args = ap.parse_args()
    # 平台名归一化:od baokuan/监控库传中文名(小红书),web 传代号(xiaohongshu),两种都转成代号跑。
    _plats = _parse_platforms(args.platforms) or list(S.PLATFORMS)
    # 成本台账的任务上下文(store.add_cost 读 BC_TASK,按任务归因)
    if args.link:
        os.environ.setdefault("BC_TASK", f"link:{args.link[:60]}")
    elif args.account:
        os.environ.setdefault("BC_TASK", f"account:{args.account[:40]}")
    elif args.scheduled:
        os.environ.setdefault("BC_TASK", "scheduled")
    elif args.regenerate:
        os.environ.setdefault("BC_TASK", "regenerate")
    elif args.keyword:
        os.environ.setdefault("BC_TASK", f"keyword:{args.keyword[:40]}")
    pipe = Pipeline(dry_run=args.dry_run)
    if args.xhs_note_type:
        pipe.xhs_note_type = args.xhs_note_type
    if args.criteria:
        raw = args.criteria
        if raw.startswith("@"):
            with open(raw[1:], encoding="utf-8") as f:
                raw = f.read()
        pipe._criteria = json.loads(raw)
        logger.info(f"[标准] 用灵活爆款标准：时间窗={pipe._criteria.get('time_window','all')} "
                    f"规则数={len(pipe._criteria.get('rules', []))}")
    collect_path = args.collect_file or os.getenv("COLLECT_FILE")
    if collect_path:
        with open(collect_path, encoding="utf-8") as f:
            pipe._collect_data = json.load(f)
        logger.info(f"[采集] 用内置浏览器数据 {collect_path}："
                    + "、".join(f"{k}×{len(v)}" for k, v in pipe._collect_data.items()))
    if args.radar and args.keyword:
        # 雷达模式:采集+评分选题,跳过脚本/封面(快);数据照常回写飞书(数据中心)
        pipe._radar_mode = True
        # 雷达精评条数：默认 8(取头部选题，约 1 分钟出结果)；量大想更全可设 RADAR_MAX。
        os.environ["MAX_PROCESS"] = os.getenv("RADAR_MAX", "8")
        os.environ["ASR_OFF"] = "1"                  # 选题阶段不转写,提速
        # 采集候选量:TikHub 直采时多翻几页(默认 30)让筛选(尤其低粉爆款这类稀有条件)有足够
        # 候选;浏览器采集(collect-file)则用其提供的量,count 不影响。
        collect_n = int(os.getenv("RADAR_COLLECT", "30"))
        pipe.run_keyword(args.keyword, _plats,
                         count=collect_n, min_threshold=args.min_threshold)
        items = sorted(pipe.radar_items, key=lambda x: (x["流量爆款分"] + x["精准意向分"]), reverse=True)
        # feishu_synced=False 说明本轮飞书数据中心回写失败(多为 lark-cli 未装/未连接)——上报给前端
        # 提示用户,不再静默(2026-07-16 用户报"没和飞书数据中心同步")。
        # collect_errors:数据源本身挂了(令牌失效/欠费/限流)时,前端要能和"这个词没爆款"
        # 区分开——只有 0 条而没有原因的话,用户会一直以为是自己关键词选得不好。
        print(json.dumps({"keyword": args.keyword, "count": len(items),
                          "tier": pipe.radar_tier, "feishu_synced": not pipe._feishu_broken,
                          "collect_errors": pipe.collect_errors,
                          "选题候选": items},
                         ensure_ascii=False, indent=2))
        return
    if args.scheduled:
        print(json.dumps(pipe.run_scheduled(), ensure_ascii=False, indent=2))
    elif args.regenerate:
        print(json.dumps(pipe.regenerate(), ensure_ascii=False, indent=2))
    elif args.account:
        print(json.dumps(pipe.run_account(args.account, _plats,
                                          time_window=args.time_window),
                         ensure_ascii=False, indent=2))
    elif args.link:
        print(json.dumps(pipe.run_single_link(args.link), ensure_ascii=False, indent=2))
    elif args.keyword:
        print(json.dumps(pipe.run_keyword(args.keyword, _plats,
                                          min_threshold=args.min_threshold),
                         ensure_ascii=False, indent=2))
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
