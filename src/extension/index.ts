import { Type } from "typebox";
import { openDb } from "../db/connection";
import { searchPackages, getPackageDetail, listPackages, getStats } from "../db/query";
import { runCrawler } from "../crawler";
import { FAILED_PATH } from "../shared/config";
import { readFileSync, existsSync } from "node:fs";

/** 读取 failed.json，返回失败摘要（含原因，最多展示 5 个）*/
async function readFailedSummary(): Promise<string> {
  try {
    if (!existsSync(FAILED_PATH)) return "";
    const data = JSON.parse(readFileSync(FAILED_PATH, "utf-8"));
    const items: { name: string; error: string }[] = data.items ?? data.names?.map((n: string) => ({ name: n, error: "未知" })) ?? [];
    if (items.length === 0) return "";
    const shown = items.slice(0, 5).map((i) => `${i.name}(${i.error})`).join(", ");
    const more = items.length > 5 ? ` 等${items.length}个` : "";
    return `${shown}${more} (补漏: /pi-packages-search:retry)`;
  } catch {
    return "";
  }
}

const PkgTypeUnion = Type.Union([
  Type.Literal("extension"), Type.Literal("package"), Type.Literal("skill"),
  Type.Literal("theme"), Type.Literal("prompt"),
]);
const SortUnion = Type.Union([
  Type.Literal("relevance"), Type.Literal("downloads"), Type.Literal("updated"),
]);

function fmtRows(rows: any[]): string {
  if (rows.length === 0) return "未找到匹配包。";
  return rows.map((r, i) =>
    `${i + 1}. ${r.name} [${(r.types || []).join(",")}] ${(r.downloadsMonthly ?? 0).toLocaleString()}/mo\n` +
    `   ${(r.description ?? "").slice(0, 120)}\n` +
    `   安装: ${r.installCmd}`).join("\n");
}

export default function (pi: any) {
  pi.registerTool({
    name: "search_packages",
    label: "Search Pi Packages",
    description: "FTS5 全文搜索 Pi 包目录。传空格分隔的英文关键词（中文请先转译）。",
    parameters: Type.Object({
      query: Type.String({ description: "空格分隔关键词，如 'memory persistent'" }),
      type: Type.Optional(PkgTypeUnion),
      limit: Type.Optional(Type.Number()),
      sort: Type.Optional(SortUnion),
    }),
    async execute(_id: string, params: any) {
      const db = openDb();
      const rows = searchPackages(db, params.query, { type: params.type, limit: params.limit, sort: params.sort });
      db.close(false);
      return { content: [{ type: "text", text: fmtRows(rows) }], details: { count: rows.length } };
    },
  });

  pi.registerTool({
    name: "get_package_detail",
    label: "Get Package Detail",
    description: "按精确包名获取完整详情（含 README 与 manifest）。",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id: string, params: any) {
      const db = openDb();
      const r = await getPackageDetail(db, params.name);
      db.close(false);
      if (!r) return { content: [{ type: "text", text: `未找到包: ${params.name}` }], details: {} };
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], details: {} };
    },
  });

  pi.registerTool({
    name: "list_packages",
    label: "List Pi Packages",
    description: "按类型浏览/排序（如热门主题）。不传 type 则全部。",
    parameters: Type.Object({
      type: Type.Optional(PkgTypeUnion),
      sort: Type.Optional(SortUnion),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const db = openDb();
      const rows = listPackages(db, { type: params.type, sort: params.sort, limit: params.limit });
      db.close(false);
      return { content: [{ type: "text", text: fmtRows(rows) }], details: { count: rows.length } };
    },
  });

  pi.registerTool({
    name: "get_stats",
    label: "Package DB Stats",
    description: "返回包库统计（总数、各类型分布、上次爬取时间、是否过期）。",
    parameters: Type.Object({}),
    async execute() {
      const db = openDb();
      const s = getStats(db);
      db.close(false);
      const text = `总计 ${s.total} 包 | 各类型: ${JSON.stringify(s.byType)} | 上次爬取: ${s.lastCrawl ?? "无"}`;
      return { content: [{ type: "text", text }], details: s };
    },
  });

  // ── 后台爬取基础设施：handler 立即返回，不阻塞 pi 主输入循环 ──
  // pi 对命令 handler 是 await 的（interactive-mode 主循环串行 await prompt），
  // 在 handler 里直接 await runCrawler 会把整个 TUI 卡住直到爬取结束（表现为"冻结"）。
  const STATUS_KEY = "pi-pkg-search";
  let activeCrawl: AbortController | null = null;

  /** 节流状态栏日志：进度条 → setStatus，阶段头/补漏提示 → notify */
  function makeCrawlLogger(ui: any): (msg: string) => void {
    let lastStatusMs = 0;
    const THROTTLE_MS = 200;
    return (msg: string) => {
      if (!ui) return;
      const trimmed = msg.replace(/\r/g, "").trim();
      if (!trimmed) return;

      // 进度条 → setStatus（单行紧凑）
      if (/^\[?\d{1,3}%/.test(trimmed) || /列表页\s*\d+\/\d+/.test(trimmed)) {
        const now = Date.now();
        if (now - lastStatusMs < THROTTLE_MS) return;
        lastStatusMs = now;
        const compact = trimmed
          .replace(/\[?\s*(\d+)%\]?\s*(\d+)\/(\d+)\s+([\d.]+)\/s\s+剩余\s*~(\d+)s\s+失败\s*(\d+)\s+并发\s*(\d+)/,
            "$1% $2/$3 $4/s ←$5s 失败$6")
          .replace(/列表页\s*(\d+)\/(\d+)\s*\((\d+)\s*包\)/, "列表 $1/$2 ($3包)");
        ui.setStatus?.(STATUS_KEY, compact);
        return;
      }
      // 阶段头 → notify（简短一次性）
      if (/^[📋🌐🔍🔧]/.test(trimmed)) {
        const short = trimmed.replace(/^📋 阶段 A: 爬取列表页\.\.\.$/, "📋 扫描列表")
          .replace(/^🌐 阶段 C: 爬取详情页.*$/, "🌐 拉取详情")
          .replace(/^🔧 补漏模式.*$/, "🔧 补漏")
          .replace(/^🔧 全量模式.*$/, "🔧 全量爬取")
          .replace(/^🔍 阶段 B:.*$/, "🔍 增量对比");
        ui.notify?.(short, "info");
        return;
      }
      // 补漏提示 / 统计行 → notify
      if (/^[🔄]/.test(trimmed) || (trimmed.includes("补漏") && /需爬/.test(trimmed))) {
        ui.notify?.(trimmed, "info");
        return;
      }
      if (/^\s*发现\s*\d+\s*个包/.test(trimmed)) {
        ui.notify?.(trimmed, "info");
      }
    };
  }

  /** 启动后台爬取任务：并发守卫 + AbortSignal + 完成后落盘清理与分级通知 */
  function startCrawlBackground(ui: any, mode: { full?: boolean; retryOnly?: boolean; label: string }) {
    if (activeCrawl) {
      ui?.notify?.("⚠ 已有爬取在进行中，/pi-packages-search:stop 可中止", "warn");
      return;
    }
    const ac = new AbortController();
    activeCrawl = ac;
    ui?.notify?.(`🚀 ${mode.label}已转入后台，pi 可正常使用（/pi-packages-search:stop 中止）`, "info");
    void (async () => {
      const onLog = makeCrawlLogger(ui);
      let db: any;
      try {
        db = openDb();
        const meta = await runCrawler(db, {
          full: mode.full,
          retryOnly: mode.retryOnly,
          signal: ac.signal,
          onLog,
        });
        db.close(false);
        ui?.setStatus?.(STATUS_KEY, undefined);
        if (meta.failedCount > 0) {
          const failedSummary = await readFailedSummary();
          ui?.notify?.(`⚠ 爬取完成但 ${meta.failedCount} 个包失败: ${failedSummary}`, "warn");
        } else {
          ui?.notify?.(`✅ 爬取完成: ${meta.totalPackages} 包, 用时 ${meta.durationSeconds}s`, "info");
        }
      } catch (err: any) {
        try { db?.close(false); } catch { /* 已关闭 */ }
        ui?.setStatus?.(STATUS_KEY, undefined);
        if (ac.signal.aborted) ui?.notify?.("🛑 爬取已中止（已完成部分已落盘，下次增量自动补齐）", "info");
        else ui?.notify?.(`❌ 爬取失败: ${err?.message ?? err}`, "error");
      } finally {
        activeCrawl = null;
      }
    })();
  }

  pi.registerCommand("pi-packages-search:crawl", {
    description: "爬取/更新 Pi 包索引（后台执行，不阻塞 pi。默认增量，--full 全量, --retry 只补漏）",
    handler: async (args: string, ctx: any) => {
      startCrawlBackground(ctx?.ui, {
        full: args.includes("--full"),
        retryOnly: args.includes("--retry"),
        label: "爬取",
      });
    },
  });

  // 短命令：直接补漏，等效于 crawl --retry
  pi.registerCommand("pi-packages-search:retry", {
    description: "补漏：重试上次失败或缺失的包（后台执行，不阻塞 pi）",
    handler: async (_args: string, ctx: any) => {
      startCrawlBackground(ctx?.ui, { retryOnly: true, label: "补漏" });
    },
  });

  pi.registerCommand("pi-packages-search:stop", {
    description: "中止进行中的爬取（已完成部分保留）",
    handler: async (_args: string, ctx: any) => {
      if (!activeCrawl) {
        ctx?.ui?.notify?.("当前没有进行中的爬取", "info");
        return;
      }
      activeCrawl.abort();
      ctx?.ui?.notify?.("正在中止爬取…", "info");
    },
  });

  // pi 关闭时中止后台爬取，避免写库与退出流程纠缠
  pi.on("session_shutdown", async () => {
    activeCrawl?.abort();
  });
}
