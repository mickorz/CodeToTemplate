// 任务调度器：并发上限控制 + 优先级调度 + 暂停/恢复
// 参考实现：p-queue (MIT) 的 PQueue 核心调度逻辑

interface QueueItem {
  fn: () => Promise<unknown>;
  priority: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface SchedulerOptions {
  concurrency: number;
}

interface AddOptions {
  priority?: number;
}

export class Scheduler {
  private readonly concurrency: number;
  private activeCount = 0;
  private isPaused = false;
  private microtaskScheduled = false;
  private idleResolvers: Array<() => void> = [];

  // 优先级队列：priority 大者先出队，相同优先级 FIFO
  private queue: QueueItem[] = [];

  constructor(options: SchedulerOptions) {
    this.concurrency = options.concurrency;
  }

  add<T>(fn: () => Promise<T>, options: AddOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        fn: fn as () => Promise<unknown>,
        priority: options.priority ?? 0,
        resolve: resolve as (value: unknown) => void,
        reject: reject as (error: unknown) => void,
      };
      this.queue.push(item);
      this.tryToStartAnother();
    });
  }

  pause(): void {
    this.isPaused = true;
  }

  start(): void {
    this.isPaused = false;
    this.tryToStartAnother();
  }

  onIdle(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  // 延迟一拍调度：捕获当前暂停状态，确保同步连续入队的任务
  // 在微任务阶段统一按优先级出队，而非第一个入队即抢跑
  private tryToStartAnother(): void {
    if (this.microtaskScheduled) return;
    this.microtaskScheduled = true;
    const wasPaused = this.isPaused;
    queueMicrotask(() => {
      this.microtaskScheduled = false;
      if (!wasPaused) {
        this.processQueue();
      }
    });
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.activeCount < this.concurrency) {
      const item = this.dequeue();
      if (!item) break;
      this.activeCount++;
      Promise.resolve<unknown>(item.fn())
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeCount--;
          this.tryToStartAnother();
          this.checkIdle();
        });
    }
  }

  // 出队：选取 priority 最大的元素（相同优先级取最先入队的，保证 FIFO）
  private dequeue(): QueueItem | undefined {
    if (this.queue.length === 0) return undefined;
    let maxIndex = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].priority > this.queue[maxIndex].priority) {
        maxIndex = i;
      }
    }
    return this.queue.splice(maxIndex, 1)[0];
  }

  private checkIdle(): void {
    if (this.activeCount === 0 && this.queue.length === 0) {
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }
}
