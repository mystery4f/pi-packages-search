import type { ListPackage } from "../shared/types";

export interface CrawlDiff {
  added: string[];     // 新增包名
  updated: string[];   // 更新包名（date 增大）
  removed: string[];   // 消失包名
  toFetch: string[];   // 需爬详情的包名 = added + updated
}

/** 对比本次列表与上次 dateIndex，产出增量差异 */
export function computeDiff(
  currentList: ListPackage[],
  prevDateIndex: Record<string, number>,
): CrawlDiff {
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const currentNames = new Set<string>();

  for (const pkg of currentList) {
    currentNames.add(pkg.name);
    const prevDate = prevDateIndex[pkg.name];
    if (prevDate === undefined) {
      added.push(pkg.name);
    } else if (pkg.date > prevDate) {
      updated.push(pkg.name);
    }
  }
  for (const name of Object.keys(prevDateIndex)) {
    if (!currentNames.has(name)) removed.push(name);
  }

  return { added, updated, removed, toFetch: [...added, ...updated] };
}

/** 从列表构建本次 dateIndex */
export function buildDateIndex(list: ListPackage[]): Record<string, number> {
  const idx: Record<string, number> = {};
  for (const pkg of list) idx[pkg.name] = pkg.date;
  return idx;
}
