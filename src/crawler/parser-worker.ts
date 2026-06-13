import { parseDetailHtml } from "./detail-parser";
import type { PiPackage } from "../shared/types";

declare var self: Worker;

// Worker 入口：收到 {name, html}，解析后回传 PiPackage
self.onmessage = (event: MessageEvent) => {
  const { id, name, html } = event.data;
  try {
    const pkg = parseDetailHtml(html, name);
    (self as any).postMessage({ id, ok: true, pkg });
  } catch (err: any) {
    (self as any).postMessage({ id, ok: false, error: err.message });
  }
};

export {};
