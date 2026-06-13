import type { PiPackage } from "../shared/types";
import { WORKER_COUNT } from "../shared/config";

interface Job {
  id: number;
  resolve: (pkg: PiPackage) => void;
  reject: (err: Error) => void;
}

/** Worker 池：分发 HTML 解析任务到多个 worker，CPU 并行 */
export class WorkerPool {
  private workers: Worker[] = [];
  private jobs = new Map<number, Job>();
  private nextId = 0;
  private roundRobin = 0;

  constructor(count: number = WORKER_COUNT) {
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL("./parser-worker.ts", import.meta.url).href);
      w.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
      this.workers.push(w);
    }
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
