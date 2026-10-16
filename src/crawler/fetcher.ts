export const DEFAULT_TIMEOUT = 30_000;
export const DEFAULT_RETRIES = 3;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** 抓取页面文本，带超时和重试；外部 signal 中止时立即失败且不重试 */
export async function fetchPage(
  url: string,
  retries: number = DEFAULT_RETRIES,
  timeoutMs: number = DEFAULT_TIMEOUT,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const resp = await fetch(url, { signal: merged, redirect: "follow" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (err: any) {
      // 外部中止：不重试，直接以中止原因抛出
      if (signal?.aborted) throw signal.reason ?? err;
      const isLast = attempt === retries;
      if (isLast) throw err;
      await sleep(800 * attempt);
    }
  }
  throw new Error("unreachable");
}
