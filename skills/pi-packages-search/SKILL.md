---
name: pi-packages-search
description: "智能搜索 Pi 包目录（FTS5 全文 + JSON 命令双路径）。触发：找 pi 插件/扩展/技能/主题、pi-package-search、/pi-packages-search。"
---

# Pi Packages Search

根据用户需求，在本地 Pi 包库（`~/pi-data/pi-packages-search/`）中智能检索。

## 双检索路径（核心）

| 用户需求 | 路径 | 做法 |
|----------|------|------|
| 描述功能("我需要记忆插件") | FTS5 | 调 `search_packages`(query=英文关键词) |
| 指定类型("热门主题") | FTS5 | 调 `list_packages`(type=theme, sort=downloads) |
| 查特定包("X是什么") | FTS5 | 调 `get_package_detail`(name=X) |
| 精确字段("作者Y的包") | JSON | `jq`/`rg` `~/pi-data/pi-packages-search/packages.json` |
| 模式匹配("名字带Z的") | JSON | `rg '"name"...\bZ\b' packages.json` |

## 中英转换

索引是英文。用户中文提问时，**先转英文关键词**再查（记忆→memory/persistent/session；插件→plugin/extension）。

## 流程

1. 调 `get_stats` 确认库存在；若过期或为空，提示用户运行 `pi-packages-search:crawl` 更新
2. 按上表选择检索路径
3. 结果按 **排名 / 类型 / 下载量 / 安装命令 / 链接** 呈现，限 5-10 条

## 更新索引

pi 命令：`pi-packages-search:crawl`（增量）。首次或数据损坏用 `pi-packages-search:crawl --full`。
