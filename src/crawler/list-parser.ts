import type { ListPackage } from "../shared/types";

const ARTICLE_RE = /<article[^>]*data-package-card="true"[\s\S]*?<\/article>/gi;

function attr(block: string, name: string): string {
  const m = block.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

/** 解析单页 HTML 中的包列表（仅轻量字段，用于增量对比）*/
export function parseListHtml(html: string): ListPackage[] {
  const results: ListPackage[] = [];
  let m: RegExpExecArray | null;
  ARTICLE_RE.lastIndex = 0;
  while ((m = ARTICLE_RE.exec(html)) !== null) {
    const block = m[0];
    const name = attr(block, "data-package-name");
    if (!name) continue;
    results.push({
      name,
      date: parseInt(attr(block, "data-package-date")) || 0,
      downloads: parseInt(attr(block, "data-package-downloads")) || 0,
    });
  }
  return results;
}

/** 从首页 HTML 解析总页数 */
export function parseTotalPages(html: string): number {
  const matches = [...html.matchAll(/page=(\d+)/g)];
  if (matches.length === 0) return 1;
  return Math.max(...matches.map((m) => parseInt(m[1])));
}

/** 从首页 HTML 解析总包数（"1-20 / 60" 中的 60）*/
export function parseTotalCount(html: string): number {
  const m = html.match(/(\d[\d,]*)\s*-\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
  return m ? parseInt(m[3].replace(/,/g, "")) : 0;
}
