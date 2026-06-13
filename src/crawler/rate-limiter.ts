/** 自适应并发限流：遇失败(429/超时)降并发，连续成功逐步回升 */
export class AdaptiveLimiter {
  private cur: number;
  private successStreak = 0;
  constructor(
    private target: number,
    private min = 2,
  ) {
    this.cur = target;
  }
  current(): number {
    return this.cur;
  }
  recordFailure(): void {
    this.successStreak = 0;
    this.cur = Math.max(this.min, Math.floor(this.cur / 2));
  }
  recordSuccess(): void {
    this.successStreak++;
    if (this.successStreak >= 5 && this.cur < this.target) {
      this.cur = Math.min(this.target, this.cur + 1);
      this.successStreak = 0;
    }
  }
}
