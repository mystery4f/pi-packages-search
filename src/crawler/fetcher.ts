const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** 抓取页面文本，带超时和重试 */
export async function fetchPage(
  url: string,
  retries: number = DEFAULT_RETRIES,
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const resp = await fetch(url, { signal: ac.signal, redirect: "follow" });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (err: any) {
      const isLast = attempt === retries;
      if (isLast) throw err;
      await sleep(800 * attempt);
    }
  }
  throw new Error("unreachable");
}
