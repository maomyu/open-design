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
      setByPlatform(
        Object.fromEntries(resp.platforms.map((p) => [p.id, p.accounts.map((a) => a.name)])),
      );
    });
  }, []);
  return byPlatform;
}
