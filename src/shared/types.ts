/** 列表页解析结果（轻量，用于增量对比）*/
export interface ListPackage {
  name: string;
  date: number;          // data-package-date 时间戳(ms)
  downloads: number;     // data-package-downloads
  types: string[];       // data-package-types
}

/** 完整包数据（详情页解析后，入库结构）*/
export interface PiPackage {
  name: string;
  description: string;
  readme: string | null;
  types: string[];
  author: string | null;
  version: string | null;
  license: string | null;
  size: string | null;
  dependenciesCount: number | null;
  downloadsMonthly: number;
  downloadsWeekly: number | null;
  publishedAt: string | null;
  updatedAt: string;
  installCmd: string;
  npmUrl: string;
  repoUrl: string | null;
  detailUrl: string;
  manifest: string | null;     // Pi manifest JSON 串
  searchText: string;          // 合并搜索文本
}

/** meta.json 结构 */
export interface CrawlMeta {
  lastCrawl: string;
  totalPackages: number;
  durationSeconds: number;
  crawlerVersion: string;
  sourceUrl: string;
  dateIndex: Record<string, number>;  // name -> date 时间戳
  failedCount: number;               // 本次爬取失败的包数
}
