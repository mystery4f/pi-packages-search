import type { PiPackage } from "../shared/types";
import { WORKER_COUNT } from "../shared/config";
import { parseDetailHtml } from "./detail-parser";

interface Job {
  id: number;
  resolve: (pkg: PiPackage) => void;
  reject: (err: Error) => void;
}

const isBun = typeof (globalThis as any).Bun !== "undefined";

/**
 * Worker 池：分发 HTML 解析任务，CPU 并行。
 *
 * 运行时分流（与 driver.ts 同理的适配策略）：
 * - Bun (爬虫 CLI): 真 Worker 池，parser-worker.ts 在多线程并行解析
 * - Node (pi 扩展): 内联降级，parse() 直接在主线程调 parseDetailHtml
 *   理由: Node worker_threads 加载 .ts 需 --experimental-strip-types (pi 未开启);
 *         且解析是轻量正则操作(<1ms/包), 主线程串行 vs 网络爬取(分钟级)可忽略。
 *         YAGNI: Node 下 Worker 收益 < 复杂度。
 */
export class WorkerPool {
  private workers: any[] = [];
  private jobs = new Map<number, Job>();
  private nextId = 0;
  private roundRobin = 0;

  constructor(count: number = WORKER_COUNT) {
    if (isBun) {
      for (let i = 0; i < count; i++) {
        const w = new (globalThis as any).Worker(new URL("./parser-worker.ts", import.meta.url).href);
        const idx = i;
        w.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
        this.workers.push(w);
      }
    }
    // Node: workers 数组保持空, parse() 走内联降级
  }

  private handleMessage(data: any) {
    const job = this.jobs.get(data.id);
    if (!job) return;
    this.jobs.delete(data.id);
    if (data.ok) job.resolve(data.pkg);
    else job.reject(new Error(data.error));
  }

  /** 提交一个解析任务，返回 PiPackage Promise */
  parse(name: string, html: string): Promise<PiPackage> {
    // Node 降级: 主线程内联解析（无 Worker，避免 node 下 Worker/TS 加载问题）
    if (!isBun) {
      return new Promise((resolve, reject) => {
        try {
          resolve(parseDetailHtml(html, name));
        } catch (err: any) {
          reject(err);
        }
      });
    }

    // Bun: 分发到 Worker 池并行解析
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { id, resolve, reject });
      const w = this.workers[this.roundRobin % this.workers.length];
      this.roundRobin++;
      w.postMessage({ id, name, html });
    });
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
