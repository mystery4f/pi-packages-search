import type { PiPackage } from "../shared/types";

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** 从 dl 列表中提取字段值 */
function field(html: string, label: string): string | null {
  const re = new RegExp(`<dt[^>]*>${label}</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, "i");
  const m = html.match(re);
  return m ? clean(m[1]) : null;
}

/** "118.3K/mo" → 118300；"17.8K/wk"→17800 */
function parseDownloads(text: string | null): { monthly: number; weekly: number | null } {
  const monthly = { monthly: 0, weekly: null as number | null };
  if (!text) return monthly;
  const num = (s: string) => {
    const m = s.match(/([\d.]+)\s*([KMB]?)/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    return Math.round(v * (u === "K" ? 1000 : u === "M" ? 1e6 : u === "B" ? 1e9 : 1));
  };
  const moM = text.match(/([\d.KMB]+)\s*\/?\s*mo/i);
  const wkM = text.match(/([\d.KMB]+)\s*\/?\s*wk/i);
  monthly.monthly = moM ? num(moM[1]) : 0;
  monthly.weekly = wkM ? num(wkM[1]) : null;
  return monthly;
}

function parseDate(text: string | null): string | null {
  if (!text) return null;
  const d = new Date(text);
  return isNaN(d.getTime()) ? text : d.toISOString().split("T")[0];
}

/** 从 manifest JSON 提取工具/扩展名（去路径前缀）*/
export function extractManifestTools(manifest: string): string[] {
  try {
    const obj = JSON.parse(manifest);
    const out: string[] = [];
    for (const key of ["extensions", "skills", "tools", "commands"]) {
      const arr = obj[key];
      if (Array.isArray(arr)) for (const p of arr) if (typeof p === "string") out.push(p.split("/").pop() || p);
    }
    return out;
  } catch {
    return [];
  }
}

/** 解析详情页 HTML，输出完整 PiPackage */
export function parseDetailHtml(html: string, name: string): PiPackage {
  const installMatch = html.match(/data-copy-text="([^"]*)"/);
  const npmMatch = html.match(/href="(https:\/\/www\.npmjs\.com\/package\/[^"]*)"/i);
  const repoMatch = html.match(/href="(https:\/\/github\.com\/[^"]*)"/i);
  const readmeMatch = html.match(/<main[^>]*id=["']readme["'][\s\S]*?<\/main>/i);
  const manifestMatch = html.match(/<pre[^>]*><code[^>]*>(\{[\s\S]*?\})<\/code><\/pre>/);

  const description = clean(field(html, "Description") || "");
  const dl = parseDownloads(field(html, "Downloads"));
  const manifest = manifestMatch ? manifestMatch[1].trim() : null;

  return {
    name,
    description,
    readme: readmeMatch ? clean(readmeMatch[0]) : null,
    types: [],
    author: field(html, "Author"),
    version: field(html, "Version"),
    license: field(html, "License"),
    size: field(html, "Size"),
    dependenciesCount: (() => {
      const t = field(html, "Dependencies");
      const m = t?.match(/(\d+)\s*dependencies/i);
      return m ? parseInt(m[1]) : null;
    })(),
    downloadsMonthly: dl.monthly,
    downloadsWeekly: dl.weekly,
    publishedAt: parseDate(field(html, "Published")),
    updatedAt: "",
    installCmd: installMatch ? installMatch[1] : `pi install npm:${name}`,
    npmUrl: npmMatch?.[1] ?? `https://www.npmjs.com/package/${name}`,
    repoUrl: repoMatch?.[1] ?? null,
    detailUrl: `https://pi.dev/packages/${encodeURIComponent(name)}`,
    manifest,
    searchText: clean(`${name} ${description} ${manifest ? extractManifestTools(manifest).join(" ") : ""}`),
    detailSource: null,
  };
}
