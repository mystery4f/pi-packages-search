---
name: pi-packages-search
description: "智能搜索 Pi 包目录（FTS5 全文 + JSON 命令双路径）。触发：找 pi 插件/扩展/技能/主题、pi-package-search、/pi-packages-search。"
---

# Pi Packages Search

**核心原则：用户输入即搜索意图。直接执行，不要反问"你想搜什么"。只有用户确实没提供任何需求时才问。**

## 执行步骤（收到用户需求后立即执行，不对话）

### 1. 确认库存在

先调 `get_stats`。若库为空或过期（lastCrawl 超过 7 天），**一句话**告知用户先更新：`库为空/过期，请先运行 pi-packages-search:crawl`——然后停止，不要再问。

### 2. 选路径 + 执行

| 用户需求 | 直接执行（不反问） |
|----------|-------------------|
| 描述功能（"记忆插件"）| `search_packages(query=英文关键词)` |
| 指定类型（"热门主题"）| `list_packages(type=theme, sort=downloads)` |
| 查特定包（"X 是什么"）| `get_package_detail(name=X)` |
| 精确字段（"作者 Y"）| `rg`/`jq` 搜 `packages.json` |

### 3. 呈现结果

- 按 **排名 / 类型 / 下载量 / 安装命令 / 链接** 呈现，默认 5-10 条
- 如果没结果：说没找到，建议换关键词或扩大范围
- **不要**问"要不要再看看别的"之类废话——用户想的话自己会说

## 中英转换

索引全是英文。中文需求→先转英文关键词→再搜索：
- 记忆→memory/persistent/session
- 插件/扩展→plugin/extension
- 搜索→search/fetch
- 主题→theme
- 工具→tool

## 更新索引

`pi-packages-search:crawl`（增量）。首次或数据损坏用 `--full`。
