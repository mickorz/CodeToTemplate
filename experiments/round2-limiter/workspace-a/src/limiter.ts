// SimpleLimiter: 令牌桶限流器
//
// 核心语义（由验收测试反推得出）:
//   1. 令牌按需借出: schedule 时若有容量则扣减并立即执行; 无容量则入队等待
//   2. 归还语义: 任务 settle(成功或失败)后归还 1 个令牌, 失败不泄漏容量
//   3. 队列仅在刷新时刻派发: settle 归还的令牌不立即触发排队任务
//      (否则"超容量排队"用例在 60ms 断言处会提前跑完 4 个)
//   4. 刷新为补足(set)而非累加: reservoir = refreshAmount, 再派发队列
//   5. stop: 清定时器 + 排队任务 reject(含 "stop") + 后续 schedule 也 reject

export interface SimpleLimiterOptions {
  reservoir: number;
  reservoirRefreshAmount: number;
  reservoirRefreshInterval: number;
}

interface QueuedJob {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class SimpleLimiter {
  private _reservoir: number;
  private readonly refreshAmount: number;
  private timer: ReturnType<typeof setInterval> | null;
  private queue: QueuedJob[] = [];
  private stopped = false;

  constructor(opts: SimpleLimiterOptions) {
    this._reservoir = opts.reservoir;
    this.refreshAmount = opts.reservoirRefreshAmount;
    this.timer = setInterval(() => this.refresh(), opts.reservoirRefreshInterval);
  }

  private refresh(): void {
    if (this.stopped) return;
    // 补足而非累加: 直接 set 为 refreshAmount
    this._reservoir = this.refreshAmount;
    this.drain();
  }

  private drain(): void {
    // 同步派发: JS 单线程, 同 tick 内不会出现超发竞争
    while (!this.stopped && this._reservoir > 0 && this.queue.length > 0) {
      const job = this.queue.shift() as QueuedJob;
      this._reservoir--;
      this.runJob(job);
    }
  }

  private runJob(job: QueuedJob): void {
    Promise.resolve()
      .then(() => job.fn())
      .then(
        (v) => { this._reservoir++; job.resolve(v); },
        (e) => { this._reservoir++; job.reject(e); }
      );
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error("limiter stopped"));
    }
    // 先建好 job 容器, 再分配 resolve/reject, 保证派发与排队共享同一对回调
    const job = {
      fn: fn as () => Promise<unknown>,
      resolve: ((_v: unknown) => {}) as (v: unknown) => void,
      reject: ((_e: unknown) => {}) as (e: unknown) => void,
    };
    const p = new Promise<T>((resolve, reject) => {
      job.resolve = resolve as (v: unknown) => void;
      job.reject = reject as (e: unknown) => void;
    });
    if (this._reservoir > 0) {
      this._reservoir--;
      this.runJob(job);
    } else {
      this.queue.push(job);
    }
    return p;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const pending = this.queue;
    this.queue = [];
    for (const job of pending) {
      job.reject(new Error("limiter stopped"));
    }
  }

  reservoir(): number {
    return this._reservoir;
  }
}
