export interface SchedulerOptions {
  concurrency: number;
}

export interface AddOptions {
  priority?: number;
}

interface Task {
  fn: () => Promise<unknown>;
  priority: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class Scheduler {
  #concurrency: number;
  #paused = false;
  #running = 0;
  #queue: Task[] = [];
  #pumpScheduled = false;
  #idleResolvers: Array<() => void> = [];

  constructor(options: SchedulerOptions) {
    this.#concurrency = options.concurrency;
  }

  add<T>(fn: () => Promise<T>, options: AddOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        fn: fn as () => Promise<unknown>,
        priority: options.priority ?? 0,
        resolve: resolve as (value: unknown) => void,
        reject: reject as (error: unknown) => void,
      };
      this.#queue.push(task);
      this.#pump();
    });
  }

  pause(): void {
    this.#paused = true;
  }

  start(): void {
    this.#paused = false;
    this.#pump();
  }

  onIdle(): Promise<void> {
    if (this.#queue.length === 0 && this.#running === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#idleResolvers.push(resolve);
    });
  }

  #pump(): void {
    if (this.#paused) return;
    if (this.#running >= this.#concurrency) return;
    if (this.#queue.length === 0) return;
    if (this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      while (this.#running < this.#concurrency && this.#queue.length > 0) {
        const task = this.#extractMax();
        this.#running++;
        this.#runTask(task);
      }
    });
  }

  #extractMax(): Task {
    let maxIdx = 0;
    for (let i = 1; i < this.#queue.length; i++) {
      if (this.#queue[i].priority > this.#queue[maxIdx].priority) {
        maxIdx = i;
      }
    }
    return this.#queue.splice(maxIdx, 1)[0];
  }

  #runTask(task: Task): void {
    Promise.resolve()
      .then(() => task.fn())
      .then((result) => task.resolve(result))
      .catch((error) => task.reject(error))
      .finally(() => {
        this.#running--;
        this.#checkIdle();
        this.#pump();
      });
  }

  #checkIdle(): void {
    if (this.#queue.length === 0 && this.#running === 0) {
      const resolvers = this.#idleResolvers;
      this.#idleResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }
}
