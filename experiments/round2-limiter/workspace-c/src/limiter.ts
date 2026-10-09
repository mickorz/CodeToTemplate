// SimpleLimiter 令牌桶限流器
//
// 核心语义（参考 vendor/bottleneck 的 reservoir 机制，简化为单一容量模型）：
//
//   schedule(fn)
//     ├─ 已 stop               ─> reject("stop")
//     ├─ capacity > 0          ─> capacity-- ; 立即执行 fn
//     └─ capacity == 0          ─> 入队，等待下次刷新调度
//
//   fn 成功完成                 ─> 令牌已被消费，不归还（与 bottleneck 一致）
//   fn 抛错失败                 ─> 归还令牌（capacity++）；触发 drain 排空队列
//
//   刷新定时器（每 interval ms）
//     └─ capacity = refreshAmount  ─> drain()  尽可能启动排队任务
//
//   stop()
//     ├─ clearInterval
//     ├─ 排队任务全部 reject("stop")
//     └─ 标记 stopped，此后 schedule 也 reject("stop")
//
//   reservoir()                 ─> 返回当前剩余容量

export interface SimpleLimiterOptions {
  /** 初始容量（令牌数） */
  reservoir: number;
  /** 每次刷新时将容量补足到此数量 */
  reservoirRefreshAmount: number;
  /** 刷新间隔（毫秒） */
  reservoirRefreshInterval: number;
}

interface QueuedJob {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class SimpleLimiter {
  /** 当前剩余令牌数 */
  private capacity: number;
  private readonly refreshAmount: number;
  private readonly refreshInterval: number;
  /** 刷新定时器句柄 */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 等待执行的任务队列（FIFO） */
  private readonly queue: QueuedJob[] = [];
  /** 是否已停止 */
  private stopped = false;

  constructor(options: SimpleLimiterOptions) {
    this.capacity = options.reservoir;
    this.refreshAmount = options.reservoirRefreshAmount;
    this.refreshInterval = options.reservoirRefreshInterval;
    this.timer = setInterval(() => this.onRefresh(), this.refreshInterval);
  }

  /**
   * 调度一个异步任务。
   * - 有容量时立即扣减并执行
   * - 无容量时排队等待下次刷新
   * - 返回的 Promise 会传播任务结果或错误
   */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(
        new Error("limiter has been stopped, cannot schedule new jobs"),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: unknown) => void,
      };

      if (this.capacity > 0) {
        // 有容量：立即扣减并执行
        this.capacity--;
        this.run(job);
      } else {
        // 无容量：入队等待下次刷新
        this.queue.push(job);
      }
    });
  }

  /**
   * 立即停止限流器：
   * - 清理刷新定时器
   * - 排队中的任务全部 reject（错误消息含 "stop"）
   * - 此后新的 schedule 调用也会被 reject
   * 注意：已经在执行中的任务不受影响，会自然完成。
   */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const error = new Error("limiter has been stopped");
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      job.reject(error);
    }
  }

  /** 返回当前剩余容量（令牌数） */
  reservoir(): number {
    return this.capacity;
  }

  /**
   * 刷新回调：将容量补足到 refreshAmount，然后排空队列。
   * 这是排队任务被唤醒的唯一入口（与 bottleneck 的 heartbeat 语义一致）。
   */
  private onRefresh(): void {
    if (this.stopped) {
      return;
    }
    // 补足而非累加：每次刷新重置到固定数量
    this.capacity = this.refreshAmount;
    this.drain();
  }

  /**
   * 尽可能从队列中启动任务，直到队列空或容量耗尽。
   * 在刷新后、失败归还后被调用。
   */
  private drain(): void {
    while (this.queue.length > 0 && this.capacity > 0) {
      const job = this.queue.shift()!;
      this.capacity--;
      this.run(job);
    }
  }

  /**
   * 执行单个任务，处理成功/失败的容量语义。
   */
  private run(job: QueuedJob): void {
    job.fn().then(
      (result) => {
        // 成功：令牌已被消费，不归还（与 bottleneck reservoir 语义一致）
        job.resolve(result);
      },
      (err) => {
        // 失败：归还令牌，使后续排队任务有机会执行
        if (!this.stopped) {
          this.capacity++;
          this.drain();
        }
        job.reject(err);
      },
    );
  }
}
