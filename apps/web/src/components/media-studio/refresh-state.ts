/** HTTP 读取失败(null)只表示本地 daemon 暂时不可用，不能解释成数据库为空。
 *  只有成功返回的数组（包括真正的空数组）才有资格替换当前界面数据。 */
export function keepMediaStudioListOnLoadFailure<T>(current: T[], loaded: T[] | null): T[];
export function keepMediaStudioListOnLoadFailure<T>(current: T[] | null, loaded: T[] | null): T[] | null;
export function keepMediaStudioListOnLoadFailure<T>(current: T[] | null, loaded: T[] | null): T[] | null {
  return loaded === null ? current : loaded;
}
