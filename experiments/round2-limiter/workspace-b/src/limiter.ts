export interface SimpleLimiterOptions {
  reservoir: number;
  reservoirRefreshAmount: number;
  reservoirRefreshInterval: number;
}

interface QueuedTask {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class SimpleLimiter {
  private _reservoir: number;
  private readonly _refreshAmount: number;
  private readonly _refreshInterval: number;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _queue: QueuedTask[] = [];
  private _stopped = false;

  constructor(options: SimpleLimiterOptions) {
    this._reservoir = options.reservoir;
    this._refreshAmount = options.reservoirRefreshAmount;
    this._refreshInterval = options.reservoirRefreshInterval;
    this._startRefresh();
  }

  private _startRefresh(): void {
    if (this._refreshInterval > 0) {
      this._timer = setInterval(() => this._doRefresh(), this._refreshInterval);
      this._timer.unref?.();
    }
  }

  private _doRefresh(): void {
    this._reservoir = this._refreshAmount;
    this._drain();
  }

  private _drain(): void {
    while (this._queue.length > 0 && this._reservoir > 0) {
      const task = this._queue.shift()!;
      this._reservoir--;
      this._runTask(task);
    }
  }

  private _runTask(task: QueuedTask): void {
    Promise.resolve()
      .then(() => task.fn())
      .then(
        (result) => {
          this._reservoir++;
          task.resolve(result);
        },
        (error) => {
          this._reservoir++;
          task.reject(error);
        }
      );
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (this._stopped) {
      return Promise.reject(new Error("limiter stopped"));
    }

    if (this._reservoir > 0) {
      this._reservoir--;
      return new Promise<T>((resolve, reject) => {
        this._runTask({
          fn: fn as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject: reject as (error: unknown) => void,
        });
      });
    }

    return new Promise<T>((resolve, reject) => {
      this._queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject: reject as (error: unknown) => void,
      });
    });
  }

  stop(): void {
    if (this._stopped) return;
    this._stopped = true;

    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }

    while (this._queue.length > 0) {
      const task = this._queue.shift()!;
      task.reject(new Error("limiter stopped"));
    }
  }

  reservoir(): number {
    return this._reservoir;
  }
}
