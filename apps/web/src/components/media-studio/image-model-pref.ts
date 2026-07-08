// 生图模型偏好：选一次即记住（localStorage），封面/配图/图集所有模型
// 下拉共享同一偏好——刷新、换文章、换创作台都保持，不用每次重选。
const KEY = 'open-design:studio:image-model';

export function loadPreferredImageModel(): string {
  try {
    return window.localStorage.getItem(KEY) || 'qwen';
  } catch {
    return 'qwen';
  }
}

export function savePreferredImageModel(id: string): void {
  try {
    if (id === 'qwen') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable — selection stays for this session only */
  }
}
