/**
 * npm registry 详情补充：当本地 DB 中某包的 README 为空（pi.dev 详情页是 JS 动态渲染，
 * 静态抓取常拿不到 README/manifest）时，向 npm registry 请求纯 JSON 元数据，
 * 补全 readme / manifest / description / license / author / repo 等字段。
 *
 * 设计约束：
 * - 纯函数模块，不依赖 db（依赖方向：shared 不依赖 db，由 db/query.ts 编排调用）
 * - 网络失败/包不存在一律返回 null，降级到本地数据，绝不抛错影响查询
 * - 只补充「空字段」，不覆盖本地已有的一手数据
 * - 默认走 npmmirror 镜像（国内访问快、API 与官方源兼容）；可改 NPM_REGISTRY 切换
 */
import type { PiPackage } from "./types";

/** npm registry 源（npmmirror 国内快；国外可改 https://registry.npmjs.org）*/
const NPM_REGISTRY = "https://registry.npmmirror.com";
/** 单次请求超时（ms）— fallback 不应拖慢查询太久 */
const FETCH_TIMEOUT = 12_000;

/** 判断是否需要 npm fallback：readme 为空（用户选择「README 为空就触发」）*/
export function needsNpmFallback(pkg: Pick<PiPackage, "readme">): boolean {
  return !pkg.readme || !pkg.readme.trim();
}

/** scoped 包名 @scope/name → @scope%2Fname（registry 要求斜杠编码）*/
function registryUrl(name: string): string {
  return `${NPM_REGISTRY}/${name.replace(/\//g, "%2F")}`;
}

/** git+https://...git → https://... */
function cleanGitUrl(url: string): string {
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

/**
 * 请求 npm registry，返回解析后的 JSON；失败/超时/404 返回 null。
 * 内置 AbortController 超时 + 单次重试。
 */
export async function fetchNpmRegistry(name: string): Promise<any | null> {
  const tryOnce = async (): Promise<any | null> => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
      const resp = await fetch(registryUrl(name), {
        signal: ac.signal,
        redirect: "follow",
        headers: { accept: "application/json" },
      });
      clearTimeout(timer);
      if (!resp.ok) return null;
      return JSON.parse(await resp.text());
    } catch {
      return null;
    }
  };
  // 第一次失败再试一次（registry 偶发抖动）
  return (await tryOnce()) ?? (await tryOnce());
}

/**
 * 用 registry JSON 补充 pkg 的空字段，返回补充后的副本（不修改入参）。
 * 只填空字段；detailSource 标记为 "npm"。
 */
export function enrichFromRegistry<T extends PiPackage>(pkg: T, json: any): T {
  const latest: string | undefined = json?.["dist-tags"]?.latest;
  const ver = latest ? json?.versions?.[latest] : undefined;
  const out = { ...pkg } as T;
  out.detailSource = "npm";

  if (!out.readme && json?.readme) out.readme = json.readme;
  if (!out.description && json?.description) out.description = json.description;
  // manifest：取 package.json 的 pi 字段（extensions/skills/tools/commands）
  if (!out.manifest && ver?.pi) out.manifest = JSON.stringify(ver.pi, null, 2);
  if (!out.license) {
    const lic = ver?.license ?? json?.license;
    out.license = typeof lic === "string" ? lic : lic?.type ?? out.license;
  }
  if (!out.author) {
    out.author = json?.maintainers?.[0]?.name ?? ver?.author?.name ?? out.author;
  }
  if (!out.version && latest) out.version = latest;
  if (!out.repoUrl) {
    const repo = ver?.repository?.url ?? json?.repository?.url;
    out.repoUrl = repo ? cleanGitUrl(repo) : ver?.homepage ?? json?.homepage ?? null;
  }
  if (out.dependenciesCount == null && ver) {
    const deps = { ...(ver.dependencies ?? {}), ...(ver.peerDependencies ?? {}) };
    out.dependenciesCount = Object.keys(deps).length;
  }
  if (!out.publishedAt && latest && json?.time?.[latest]) {
    out.publishedAt = String(json.time[latest]).split("T")[0];
  }

  return out;
}

/**
 * 高层封装：当 pkg 需要 fallback 时，请求 registry 并补充。
 * 返回补充后的 pkg（readme 已补、detailSource="npm"）；失败则原样返回（detailSource 不变）。
 */
export async function enrichFromNpm<T extends PiPackage>(pkg: T): Promise<T> {
  if (!needsNpmFallback(pkg)) return pkg;
  const json = await fetchNpmRegistry(pkg.name);
  if (!json) return pkg;
  const enriched = enrichFromRegistry(pkg, json);
  // 只有真正补到了 readme 才算成功
  return enriched.readme && enriched.readme.trim() ? enriched : pkg;
}
