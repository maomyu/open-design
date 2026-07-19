// 账号中心是唯一账号来源(2026-07-09 用户拍板):创作台的发布/后台入口
// 不再出现 'main' 这类内部兜底档案名——有账号=下拉绑定,没账号=引导去
// 「账号」页添加。本 hook 把账号中心数据按平台聚成 {平台id: [账号名]}。
import { useEffect, useState } from 'react';
import { fetchPlatformAccounts } from '../../providers/daemon';

export function usePlatformAccountNames(): Record<string, string[]> {
  const [byPlatform, setByPlatform] = useState<Record<string, string[]>>({});
  useEffect(() => {
    void fetchPlatformAccounts().then((resp) => {
      if (!resp) return;
      const map: Record<string, string[]> = Object.fromEntries(
        resp.platforms.map((p) => [p.id, p.accounts.map((a) => a.name)]),
      );
      // 视频号历史遗留三套 id:账号系统存 `shipinhao`、发布归属(VIDEO_TARGETS)用 `tencent`、
      // 采集引擎用 `channels`。存草稿账号门禁按发布 id 查账号,与账号存储 id 不一致就会
      // 「加了视频号账号仍永久禁用」(2026-07-20 真机验收撞出)。这里把视频号账号名镜像到
      // 三个 id 下,任一入口都查得到,免得门禁误判。
      const shipinhao = map.shipinhao ?? map.tencent ?? map.channels;
      if (shipinhao && shipinhao.length > 0) {
        map.shipinhao = shipinhao;
        map.tencent = shipinhao;
        map.channels = shipinhao;
      }
      setByPlatform(map);
    });
  }, []);
  return byPlatform;
}
