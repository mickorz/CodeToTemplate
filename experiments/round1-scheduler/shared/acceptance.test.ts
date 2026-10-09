// P2-3 验收测试（两组共用，确定性标准，Agent 不得修改）
import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("并发上限：concurrency=2 时同时运行的任务不超过 2", async () => {
  const s = new Scheduler({ concurrency: 2 });
  let running = 0, peak = 0;
  const tasks = Array.from({ length: 6 }, () =>
    s.add(async () => { running++; peak = Math.max(peak, running); await sleep(50); running--; }, {})
  );
  await Promise.all(tasks);
  assert.ok(peak <= 2, `峰值并发 ${peak} 超过 2`);
  assert.equal(peak, 2, "应确实达到 2 并发");
});

test("优先级：concurrency=1 时高优先级先执行", async () => {
  const s = new Scheduler({ concurrency: 1 });
  const order: number[] = [];
  // 同步连续入队三个任务，priority 大者先执行
  s.add(async () => { await sleep(5); order.push(1); }, { priority: 1 });
  s.add(async () => { await sleep(5); order.push(10); }, { priority: 10 });
  s.add(async () => { await sleep(5); order.push(5); }, { priority: 5 });
  await s.onIdle();
  assert.deepEqual(order, [10, 5, 1]);
});

test("暂停与恢复：pause 后新任务不启动，start 后继续", async () => {
  const s = new Scheduler({ concurrency: 1 });
  let started = 0;
  const first = s.add(async () => { started++; await sleep(30); }, {});
  s.pause();
  const second = s.add(async () => { started++; }, {});
  await sleep(60);
  assert.equal(started, 1, "pause 后第二个任务不应启动");
  s.start();
  await Promise.all([first, second]);
  assert.equal(started, 2);
});

test("串行边界：concurrency=1 严格串行", async () => {
  const s = new Scheduler({ concurrency: 1 });
  const seq: number[] = [];
  await Promise.all([1, 2, 3, 4].map((i) =>
    s.add(async () => { seq.push(i); await sleep(10); }, {})
  ));
  assert.deepEqual(seq, [1, 2, 3, 4]);
});

test("返回值与错误传播", async () => {
  const s = new Scheduler({ concurrency: 1 });
  assert.equal(await s.add(async () => 42, {}), 42);
  await assert.rejects(s.add(async () => { throw new Error("boom"); }, {}), /boom/);
});
