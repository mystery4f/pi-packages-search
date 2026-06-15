import { describe, test, expect } from "bun:test";
import { needsNpmFallback, enrichFromRegistry } from "../src/shared/npm-registry";
import type { PiPackage } from "../src/shared/types";

// 模拟 npm registry JSON（结构参考 @ifi/pi-spec 真实响应）
const REGISTRY = {
  "dist-tags": { latest: "0.5.1" },
  readme: "# pi-spec\n\nNative spec-kit workflow for pi.",
  description: "Native spec-kit workflow for pi with a /spec command.",
  license: "MIT",
  maintainers: [{ name: "ifiokjr" }],
  homepage: "https://github.com/ifiokjr/oh-pi",
  repository: { url: "git+https://github.com/ifiokjr/oh-pi.git" },
  time: { "0.5.1": "2026-04-28T05:50:25.298Z" },
  versions: {
    "0.5.1": {
      pi: { extensions: ["./extension"] },
      dependencies: { "@mariozechner/pi-ai": "*" },
      peerDependencies: { "@sinclair/typebox": "*" },
    },
  },
};

/** 构造一个"空详情"的包（模拟 pi.dev 抓不到 README 的情况）*/
function emptyDetailPkg(name: string): PiPackage {
  return {
    name, description: "", readme: null, types: ["package"], author: null,
    version: null, license: null, size: "155.1 KB", dependenciesCount: null,
    downloadsMonthly: 555, downloadsWeekly: null, publishedAt: null,
    updatedAt: "2026-04-28", installCmd: `pi install npm:${name}`,
    npmUrl: "", repoUrl: null, detailUrl: "", manifest: null,
    searchText: "", detailSource: null,
  };
}

describe("needsNpmFallback", () => {
  test("readme 为空/null/纯空白 触发", () => {
    expect(needsNpmFallback({ readme: null })).toBe(true);
    expect(needsNpmFallback({ readme: "" })).toBe(true);
    expect(needsNpmFallback({ readme: "   " })).toBe(true);
  });
  test("readme 有内容不触发", () => {
    expect(needsNpmFallback({ readme: "# Title" })).toBe(false);
  });
});

describe("enrichFromRegistry", () => {
  test("补充 readme/description/manifest 等空字段", () => {
    const pkg = enrichFromRegistry(emptyDetailPkg("@ifi/pi-spec"), REGISTRY);
    expect(pkg.detailSource).toBe("npm");
    expect(pkg.readme).toContain("Native spec-kit");
    expect(pkg.description).toContain("/spec command");
    expect(pkg.manifest).toContain('"extensions"');
    expect(pkg.license).toBe("MIT");
    expect(pkg.version).toBe("0.5.1");
    expect(pkg.author).toBe("ifiokjr");
    expect(pkg.publishedAt).toBe("2026-04-28");
  });

  test("repoUrl 清洗 git+ 前缀和 .git 后缀", () => {
    const pkg = enrichFromRegistry(emptyDetailPkg("x"), REGISTRY);
    expect(pkg.repoUrl).toBe("https://github.com/ifiokjr/oh-pi");
  });

  test("dependenciesCount = deps + peerDeps 数量", () => {
    const pkg = enrichFromRegistry(emptyDetailPkg("x"), REGISTRY);
    expect(pkg.dependenciesCount).toBe(2);
  });

  test("不覆盖本地已有的一手数据", () => {
    const local = emptyDetailPkg("x");
    local.readme = "# 本地已有 README";
    local.author = "local-author";
    const pkg = enrichFromRegistry(local, REGISTRY);
    expect(pkg.readme).toBe("# 本地已有 README");
    expect(pkg.author).toBe("local-author");
  });

  test("license 为对象形式时提取 type", () => {
    const reg = { ...REGISTRY, license: { type: "Apache-2.0" } };
    const pkg = enrichFromRegistry(emptyDetailPkg("x"), reg);
    expect(pkg.license).toBe("Apache-2.0");
  });

  test("保留传入对象上的额外属性（泛型展开）", () => {
    type WithId = PiPackage & { id: number };
    const local: WithId = { ...emptyDetailPkg("x"), id: 42 };
    const pkg = enrichFromRegistry(local, REGISTRY);
    expect((pkg as WithId).id).toBe(42);
  });
});
