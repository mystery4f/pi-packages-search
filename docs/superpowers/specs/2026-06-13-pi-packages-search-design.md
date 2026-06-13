---
title: pi-packages-search 设计文档
created: 2026-06-13
updated: 2026-06-13
tags: [pi-packages-search, crawler, fts5, sqlite, pi-extension, brainstorming, spec]
status: design-confirmed
---

# pi-packages-search 设计文档

## 1. 概述

### 目标

构建一个 pi 包智能搜索系统：爬取 https://pi.dev/packages 全量数据，存入本地 SQLite(含 FTS5) + JSON，通过 pi 扩展工具 + pi 技能，让 LLM 能根据用户的自然语言需求智能检索 Pi 包。

### 背景

现有 `pi-package-search` 技能已能爬取 ~3185 个包到 `packages.json`，但搜索方式是「LLM 直接读整个 JSON 做关键词匹配」——没有真正的数据库和分词索引。本项目是对其能力的升级：引入 SQLite + FTS5 全文索引 + 多线程爬虫，并提供 LLM 可调用的查询工具。

**与现有 `pi-package-search` 的关系**：全新独立项目，不依赖现有 crawler.ts，但参考其揭示的 pi.dev 数据接口事实。

### 核心价值

- **FTS5 全文搜索 + BM25 相关性排序**（替代纯字符串匹配）
- **双检索路径**：FTS5 工具查询 + JSON 命令(rg/jq)查询，LLM 按场景选择
- **多线程爬虫**：主从分工，I/O 与 CPU 解析重叠，全量 ~3 分钟
- **增量更新**：全量列表 + 增量详情，日常更新 <30 秒

---

## 2. 设计决策汇总（已与用户确认）

| # | 决策点 | 选定方案 |
|---|--------|---------|
| 1 | 搜索路线 | FTS5 + LLM 包装（不用向量搜索）|
| 2 | 交付形态 | pi 扩展（注册查询工具）+ pi 技能（智能指导）|
| 3 | 爬虫 | 全新 TS 爬虫，不依赖现有 crawler.ts |
| 4 | 技术栈 | 全栈 TypeScript / bun |
| 5 | 数据深度 | 完整版（列表页 + 详情页全部，含完整 README）|
| 6 | 存储架构 | SQLite(含 FTS5) + JSON 镜像 |
| 7 | JSON 角色 | 不只是备份，也是 LLM 用 rg/jq 高效搜索的数据源（双检索路径）|
| 8 | 增量更新 | 全量列表 + 增量详情（对比 `data-package-date` 时间戳）|
| 9 | 多线程 | Worker 纳入设计：主从分工，I/O 留主线程，CPU 解析交 Worker |

---

## 3. 总体架构

### 组件架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      用户提问（自然语言）                      │
│            "我需要一个持久化记忆的 pi 插件"                   │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│   pi 技能 (skills/pi-packages-search/SKILL.md)              │
│   ─ 指导 LLM 理解需求、选择检索路径、分析呈现结果             │
└──────────────────────────┬──────────────────────────────────┘
                           ▼ (LLM 决策：用哪条路径)
          ┌────────────────┴────────────────┐
          ▼                                  ▼
┌─────────────────────┐          ┌─────────────────────────┐
│  pi 扩展 (extension) │          │  路径② JSON + 命令搜索   │
│  ─ search_packages   │          │  LLM 用 rg/jq 直接搜    │
│    等工具(查 FTS5)   │          │  packages.json          │
└──────────┬──────────┘          └────────────┬────────────┘
           ▼ 路径① FTS5                       │
           BM25 排序                           │
           └────────────────┬─────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│       ~/pi-data/pi-packages-search/  (数据层)               │
│   ├── pi-packages.sqlite   结构化表 + FTS5 虚拟表           │
│   ├── packages.json        全量镜像（LLM 友好，jq/rg 可搜）  │
│   └── meta.json            爬取元信息 + dateIndex           │
└─────────────────────────────────────────────────────────────┘
                            ▲ Worker 解析结果 + Writer 批量写
┌─────────────────────────────────────────────────────────────┐
│   爬虫 (src/crawler/) + Worker 池 (parser-worker.ts)        │
│   ─ 列表全量 → 增量对比 → 详情增量(并发) → Worker 解析 → 入库│
└─────────────────────────────────────────────────────────────┘
```

### 双检索路径

| 路径 | 何时用 | 优势 |
|------|--------|------|
| ① FTS5（扩展工具）| 关键词/模糊搜索、相关性排序、全文匹配 | BM25 排序、分词、快 |
| ② JSON + rg/jq（命令）| 精确字段查找、模式匹配、LLM 自由发挥 | 灵活、无需 SQL、LLM 擅长 |

### 目录结构

```
项目代码 D:/Documents/Code/AI/pi/pi-packages-search/
├── src/
│   ├── crawler/        # 列表爬取 + 增量 + 详情爬取 + 并发池
│   ├── parser-worker.ts# Worker: HTML/README 解析引擎
│   ├── db/             # SQLite schema + FTS5 + 批量事务
│   ├── extension/      # pi 扩展入口(registerTool ×4, registerCommand)
│   └── shared/         # 共享类型定义
├── skills/pi-packages-search/SKILL.md
├── package.json
├── tests/
└── docs/

数据 ~/pi-data/pi-packages-search/   (用户指定，与代码分离)
├── pi-packages.sqlite
├── packages.json
└── meta.json
```

**设计要点**：代码与数据分离（数据在 `~/pi-data/`，可被多项目共享，不污染 git）；单一语言栈 TS；扩展提供 FTS5 工具，技能指导 LLM 在两条路径间选择。

---

## 4. 数据模型

### 4.1 SQLite 主表 `packages`（关系型）

```sql
CREATE TABLE packages (
  id                  INTEGER PRIMARY KEY,   -- 也是 FTS5 关联键 (rowid)
  name                TEXT UNIQUE NOT NULL,  -- context-mode
  description         TEXT,                  -- 列表页短描述
  readme              TEXT,                  -- 详情页完整 README（完整版核心语料）
  types               TEXT,                  -- '["extension","skill"]' JSON 串
  author              TEXT,                  -- mksglu
  version             TEXT,                  -- 1.0.162
  license             TEXT,                  -- Elastic-2.0
  size                TEXT,                  -- 3.9 MB
  dependencies_count  INTEGER,               -- 8
  downloads_monthly   INTEGER,               -- 118300
  downloads_weekly    INTEGER,               -- 17800
  published_at        TEXT,                  -- 2026-06-02
  updated_at          TEXT,                  -- 列表页 data-package-date 映射
  install_cmd         TEXT,                  -- pi install npm:context-mode
  npm_url             TEXT,
  repo_url            TEXT,
  detail_url          TEXT,                  -- https://pi.dev/packages/context-mode
  manifest            TEXT,                  -- Pi manifest JSON 串
  archived            INTEGER DEFAULT 0,     -- 下架标记(增量时检测消失包)
  crawled_at          TEXT                   -- 本条爬取时间
);

CREATE INDEX idx_packages_types ON packages(types);
CREATE INDEX idx_packages_downloads ON packages(downloads_monthly DESC);
```

### 4.2 FTS5 虚拟表 `packages_fts`（external content 模式，省空间）

```sql
CREATE VIRTUAL TABLE packages_fts USING fts5(
  name,
  description,
  readme,
  types,
  manifest_tools,        -- 从 manifest 提取的工具/扩展名(如 ctx_search)
  content='packages',    -- 外部内容模式: 原始数据留在 packages 表
  content_rowid='id',    -- 通过 id 关联
  tokenize = 'unicode61 remove_diacritics 2'
);
```

**查询示例**（一次 JOIN 拿全文匹配 + 结构化字段）：

```sql
SELECT p.name, p.description, p.install_cmd, p.downloads_monthly,
       bm25(packages_fts) AS rank      -- BM25 评分(越小越相关)
FROM packages_fts
JOIN packages p ON p.id = packages_fts.rowid
WHERE packages_fts MATCH 'memory plugin persistent'
  AND p.archived = 0
ORDER BY rank
LIMIT 10;
```

### 4.3 中文分词说明

| 项 | 处理 |
|----|------|
| 分词器 | `unicode61`（默认，英文友好，按词/标点切分）|
| 索引内容 | 全英文（README/description 均为英文）|
| 中文查询 | **靠 LLM 包装层处理**——用户问"记忆插件"，LLM 先转英文关键词 `memory/persistent/session` 再查 FTS5 |
| 可选增强 | 后续若需可切 `trigram` 分词器支持中英混合，但索引变大约 3 倍。**初版用 unicode61** |

### 4.4 JSON 镜像 `packages.json`（LLM 友好，jq/rg 可搜）

```json
{
  "generated": "2026-06-13T10:00:00Z",
  "total": 3185,
  "crawledAt": "2026-06-13T10:08:32Z",
  "packages": [
    {
      "id": 1,
      "name": "context-mode",
      "description": "MCP plugin that saves 98% of your context window...",
      "readme": "完整 README 全文...",
      "types": ["extension", "skill"],
      "author": "mksglu",
      "version": "1.0.162",
      "license": "Elastic-2.0",
      "size": "3.9 MB",
      "dependenciesCount": 8,
      "downloadsMonthly": 118300,
      "publishedAt": "2026-06-02",
      "updatedAt": "2026-06-02",
      "installCmd": "pi install npm:context-mode",
      "npmUrl": "https://www.npmjs.com/package/context-mode",
      "repoUrl": "https://github.com/mksglu/context-mode",
      "detailUrl": "https://pi.dev/packages/context-mode",
      "manifest": { "extensions": ["./build/adapters/pi/extension.js"], "skills": ["./skills"] },
      "searchText": "context-mode MCP plugin context window sandbox FTS5 knowledge base..."
    }
  ]
}
```

**`searchText` 设计**（继承现有思路并增强）：把 name + description + manifest 提取的工具名合并成一段纯文本，让 LLM 用 `rg "memory" packages.json` 一行命令即可命中。这是 JSON 路径高效的核心。

### 4.5 `meta.json`（爬取元信息 + 增量索引）

```json
{
  "lastCrawl": "2026-06-13T10:08:32Z",
  "totalPackages": 3185,
  "durationSeconds": 198,
  "crawlerVersion": "1.0.0",
  "sourceUrl": "https://pi.dev/packages",
  "dateIndex": { "context-mode": 1749800000, "pi-subagents": 1749700000 }
}
```

`dateIndex`（name → `data-package-date` 时间戳）是增量更新的核心：本次列表全量爬取后，逐包对比上次记录的时间戳，识别新增/更新/消失。

### 4.6 存储评估

3000+ 包 × 完整 README（均值 ~3KB）≈ 9MB 原始数据，FTS5 倒排索引约再 +10-15MB，**总 ~25MB，SQLite 轻松处理**。

---

## 5. 爬虫模块 + 性能

### 5.1 pi.dev 数据接口事实（调研所得）

| 项 | 事实 |
|----|------|
| 列表分页 | `https://pi.dev/packages?page=N`，约 160 页 / 3185 包，每页 ~20 个 |
| 列表数据 | 全 SSR 在 HTML，每包是 `<article data-package-card="true">` 块 |
| 列表字段 | `data-package-name` / `data-package-search` / `data-package-types` / `data-package-downloads` / **`data-package-date`（更新时间戳）** |
| 总页数探测 | 首页 HTML 正则匹配所有 `page=(\d+)` 取最大值 |
| 总包数探测 | HTML 里 `X-Y / Z` 格式计数（如 `1-20 / 3185`）|
| 详情页 | `https://pi.dev/packages/{name}`，含完整 README + manifest + 元数据 |
| 列表排序 | 混合排序（非纯按更新时间）→ 增量更新必须全量遍历列表页 |

### 5.2 关键技术澄清：瓶颈是 I/O，不是 CPU

爬虫主要成本是 **3000+ 次网络请求（I/O 密集）**，不是计算。bun 的单线程异步事件循环天生擅长 I/O 并发——一个线程能挂起上万个网络请求。真正的多线程（Worker）只在 **CPU 密集**部分（HTML/README 解析、FTS5 索引）有价值。

| 瓶颈类型 | 优化技术 | 是否用多线程 |
|----------|---------|-------------|
| 网络请求（I/O，主要瓶颈）| **异步并发池** | 否（事件循环最优）|
| 连接建立开销（I/O）| **HTTP 连接复用 / keep-alive** | 否 |
| HTML/README 解析（CPU）| 批量 + **Worker 并行** | 是 |
| FTS5 索引构建（CPU）| **批量事务** + Worker 协助 | 部分 |
| 被限流/封禁（稳定性）| **自适应限流 + 退避** | 否 |

### 5.3 爬虫 4 阶段流水线

```
阶段A: 列表全量爬取      阶段B: 增量对比         阶段C: 详情增量爬取       阶段D: Worker解析+入库
(并发10, ~160页, ~16秒)  (本地瞬时)             (并发15自适应, 仅变化包)   (Worker池+Writer批量)
       │                       │                        │                        │
  fetch page=1..N         对比 dateIndex         fetch /packages/{name}    Worker解析
  拿 {name,date}          找新增/更新/消失        只对变化包               Writer批量事务
       └───────────┬───────────┘                └──────────┬──────────────┘
                   ▼                                       ▼
          meta.dateIndex 更新 ─────────────► SQLite + JSON + FTS5
```

**增量更新逻辑**（不依赖列表排序，可靠）：
1. **全量列表**：爬所有 page=1..N，拿到全部包的 `{name, date}`（保证不漏）
2. **本地对比**：与 meta.dateIndex 对比——新增包(DB 没有)/更新包(date 更新)/消失包(标记 archived)/未变包(跳过)
3. **增量详情**：只对「新增+更新」爬详情页

### 5.4 Worker 多线程架构（纳入设计）

**核心模型：主从分工 —— I/O 留主线程，CPU 交 Worker**

```
┌─────────────── 主线程 (Master) ───────────────────────────────┐
│  阶段A/B: 列表爬取(I/O并发10) + 增量对比                       │
│  阶段C:   详情页 fetch 池(I/O并发15) ──► 拿到 HTML 扔进队列     │
│                                                               │
│  ┌─── Worker 解析池 (CPU 并行) ───┐                           │
│  │ W1: HTML→结构化(元数据+manifest+README摘要+searchText)      │
│  │ W2: ...   数量 = min(CPU核数, 8)                            │
│  │ W3: ...                                                     │
│  │ W4: ...                                                     │
│  └────────────┬────────────────────────────────────────────────┘
│               ▼ 结构化数据                                     │
│  Writer (主线程单一写入点, 批量事务) ◄── 攒够50条/定时, 串行写  │
│               ▼                                               │
│        SQLite + FTS5 + JSON                                   │
└───────────────────────────────────────────────────────────────┘
```

**关键约束：SQLite 同一文件同一时刻只能一个写事务**，多 worker 各自连库并发写会触发 `SQLITE_BUSY` 锁冲突、反而更慢。因此：

| 角色 | 任务类型 | 为什么这样安排 |
|------|---------|---------------|
| 主线程 fetch | I/O | 事件循环擅长并发挂起请求，worker 做 fetch 反而更慢（线程切换开销）|
| Worker 解析 | CPU | HTML/README 解析是 CPU 密集，多核并行真提速 |
| Writer 串行批量 | CPU/I/O | 单一写入点批量事务，又快又无锁冲突 |

**Worker 职责**：接收原始 HTML/README，输出结构化数据（元数据 + manifest + README 摘要 + searchText）。主线程与 worker 通过 `postMessage` 通信。

**Worker 数量**：

```typescript
const WORKER_COUNT = Math.min(navigator.hardwareConcurrency || 4, 8);
```

**Writer 批量事务**（单一写入点，攒够 50 条或定时）：

```typescript
db.transaction(() => {
  for (const pkg of batch) {
    db.prepare("INSERT OR REPLACE INTO packages (...) VALUES (...)").run(...);
  }
  // FTS5 索引批量重建，而非逐条
  db.prepare("INSERT INTO packages_fts(rowid,name,description,readme,types,manifest_tools) SELECT id,...").run();
})();
```

### 5.5 性能优化策略

| # | 策略 | 说明 |
|---|------|------|
| ① | 异步并发池 | 控制并发数的 Promise pool，列表并发 10 / 详情并发 15 |
| ② | HTTP 连接复用 | 单一全局 fetcher，复用 TCP/TLS 连接（省 ~5 分钟握手）|
| ③ | 自适应限流 + 退避 | 遇 429/超时→并发减半(15→8→4)→指数退避；连续成功→逐步回升 |
| ④ | 批量事务入库 | bun:sqlite 事务包裹 N 条，比逐条快 50-100 倍 |
| ⑤ | Worker 解析并行 | I/O 与 CPU 重叠，消除解析等待 |
| ⑥ | 断点续爬 | 进度写 `progress.json`，中断可恢复 |

### 5.6 并发池实现（伪代码）

```typescript
async function pool<T>(items: T[], concurrency: number, worker: (t: T) => Promise<void>) {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p = worker(item).then(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= concurrency) await Promise.race(executing);
  }
  await Promise.all(executing);
}
```

### 5.7 性能预期

| 场景 | 并发 | 预期耗时 |
|------|------|---------|
| 全量列表（160 页）| 10 | ~16 秒 |
| 全量详情（3185 包）| 15 + Worker | **~3-4 分钟** |
| 增量详情（日常 ~50 包）| 15 | **<30 秒** |
| 入库（FTS5 索引）| 批量事务 | ~10 秒 |

### 5.8 爬虫 CLI 入口

| 命令 | 行为 |
|------|------|
| `pi-packages-search crawl`（默认增量）| 全量列表 + 增量详情 |
| `pi-packages-search crawl --full` | 全量列表 + 全量详情（首次/修复）|
| `pi-packages-search crawl --proxy http://localhost:4444` | 指定代理 |

---

## 6. pi 扩展工具

通过 `pi.registerTool` 注册（typebox 定义参数 schema），注册 **4 个工具**：

| 工具 | 参数 | 用途 |
|------|------|------|
| `search_packages` | `query`(string 必填,空格分隔关键词) · `type?`(enum:extension/package/skill/theme/prompt) · `limit?`(默认10) · `sort?`(relevance/downloads/updated) | **核心**：FTS5 全文搜索，BM25 排序。内部把关键词转 MATCH 表达式 |
| `get_package_detail` | `name`(string 必填) | 取单个包完整详情（含完整 README、manifest）|
| `list_packages` | `type?` · `sort?` · `limit?` | 浏览/排序（如"热门主题"按 downloads）|
| `get_stats` | (无) | 库统计（总包数、各类型分布、爬取时间、是否过期）|

### `search_packages` 工具定义示例

```typescript
pi.registerTool({
  name: "search_packages",
  label: "Search Pi Packages",
  description: "Search Pi package catalog via FTS5 full-text search. Pass space-separated keywords; auto-translated to MATCH query. Use for finding extensions/plugins by functionality.",
  parameters: Type.Object({
    query: Type.String({ description: "Space-separated keywords (English). e.g. 'memory persistent session'" }),
    type: Type.Optional(Type.Union([
      Type.Literal("extension"), Type.Literal("package"), Type.Literal("skill"),
      Type.Literal("theme"), Type.Literal("prompt"),
    ])),
    limit: Type.Optional(Type.Number({ description: "Max results, default 10" })),
    sort: Type.Optional(Type.Union([
      Type.Literal("relevance"), Type.Literal("downloads"), Type.Literal("updated"),
    ])),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 构造 FTS5 MATCH, 查询 DB, 格式化返回
    return { content: [{ type: "text", text: formattedResults }], details: {} };
  },
});
```

**返回格式**（LLM 友好）：

```
找到 8 个匹配（共 3185 包）：
1. pi-hermes-memory [extension,skill] 10.9K/mo
   Persistent memory + session search + secret scanning. SQLite FTS5...
   安装: pi install npm:pi-hermes-memory
2. gentle-engram [extension] 11.3K/mo
   ...
```

---

## 7. pi 技能（`skills/pi-packages-search/SKILL.md`）

技能是"LLM 包装"的智能层，指导 LLM 做三件事：

### ① 双检索路径决策（核心）

```
用户需求
  ├─ 描述功能需求("我需要记忆插件") → search_packages (FTS5 BM25)
  ├─ 指定类型("有什么热门主题") → list_packages(type=theme, sort=downloads)
  ├─ 查特定包("context-mode是什么") → get_package_detail(name)
  ├─ 精确字段查找("作者mksglu的包") → JSON路径: jq '.packages[] | select(.author=="mksglu")'
  └─ 模式匹配("名字带subagent的") → JSON路径: rg '"name":\s*"[^"]*subagent' packages.json
```

### ② 中英转换

索引是英文，用户中文提问时，技能指导 LLM 先转英文关键词（"记忆"→memory/persistent/session）再查 FTS5。

### ③ 结果呈现格式

统一输出（排名 + 类型 + 下载量 + 安装命令 + 链接），继承现有技能的好格式。

---

## 8. 错误处理与边界

| 场景 | 处理 |
|------|------|
| DB 不存在/过期 | `get_stats` 报告，技能提示用户先 `crawl` |
| 爬取网络失败 | 重试 3 次（指数退避）→ 仍失败则跳过该包，记入 `failed.json`，继续其余 |
| 429 限流 | 自适应降并发（15→8→4），退避后逐步回升 |
| 某详情页缺失 | 保留列表页数据，详情字段(README 等)置 null，不阻塞 |
| 包下架（增量消失）| 标记 `archived=1`，保留数据不删除（可 `--purge` 清理）|
| FTS5 查询语法异常 | 工具内部容错：关键词转义，空结果返回友好提示 |
| Worker 崩溃 | 主线程捕获，该批次重试/降级单线程解析，不中断整体 |
| SQLite 写锁 BUSY | 单 Writer 串行批量已规避；额外设 `busy_timeout` 兜底 |
| 进度中断 | `progress.json` 记录已完成 page/包名，重启跳过已完成部分 |

---

## 9. 测试策略（分层）

| 层级 | 测试内容 |
|------|---------|
| **单元** | HTML 解析函数、FTS5 MATCH 构造、增量 dateIndex 对比逻辑、并发池、Worker 消息协议 |
| **数据层** | schema 建表、FTS5 索引查询、批量事务正确性、去重、archived 标记 |
| **集成** | 爬虫端到端（mock HTTP）— 列表→对比→详情→入库 全流程 |
| **扩展工具** | 4 个工具的输入输出契约（typebox 校验 + 返回格式）|
| **性能 benchmark** | 全量/增量耗时基线，并发数与 Worker 数的最优配比 |

---

## 10. 技术依赖

| 依赖 | 用途 |
|------|------|
| `bun` (runtime) | 原生 fetch + bun:sqlite + Worker |
| `@earendil-works/pi-coding-agent` | pi 扩展类型（ExtensionAPI）|
| `typebox` | 工具参数 schema |
| bun:sqlite (内置) | SQLite + FTS5 |

> 零额外第三方依赖（遵循 pi 生态简洁原则，bun:sqlite 内置 FTS5）。

---

## 11. 范围与未来

### 本期范围（单一实现计划）
- 全新 TS 爬虫（列表全量 + 详情增量）
- SQLite + FTS5 + JSON 三存储
- Worker 多线程解析
- pi 扩展（4 工具）+ pi 技能

### 未来可选增强（不在本期）
- `trigram` 分词器（中英混合搜索）
- 向量嵌入语义搜索（如 FTS5 + LLM 包装仍不够智能）
- 定时自动爬取（cron / pi watch）
- Web UI 搜索界面

---

## 附录：相关文件

| 文件 | 用途 |
|------|------|
| `src/crawler/index.ts` | 爬虫主入口（4 阶段流水线）|
| `src/crawler/list.ts` | 列表页爬取 + 解析 |
| `src/crawler/detail.ts` | 详情页爬取 + 增量对比 |
| `src/crawler/pool.ts` | 异步并发池 |
| `src/parser-worker.ts` | Worker 解析引擎 |
| `src/db/schema.ts` | SQLite schema + FTS5 |
| `src/db/query.ts` | 查询函数（供扩展工具调用）|
| `src/extension/index.ts` | pi 扩展入口（registerTool ×4）|
| `skills/pi-packages-search/SKILL.md` | pi 技能 |
