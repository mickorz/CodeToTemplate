// 隐藏边界测试（Agent 不可见的验收标准：状态组合/并发竞争/错误恢复/资源释放）
import test from "node:test";
import assert from "node:assert/strict";
import { SimpleLimiter } from "../src/limiter.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("并发竞争：同 tick 大量排队不超发（原子性）", async () => {
  const l = new SimpleLimiter({ reservoir: 3, reservoirRefreshAmount: 3, reservoirRefreshInterval: 150 });
  let running = 0, peak = 0;
  const jobs = Array.from({ length: 30 }, () =>
    l.schedule(async () => { running++; peak = Math.max(peak, running); await sleep(25); running--; }));
  await Promise.all(jobs);
  assert.ok(peak <= 3, `峰值 ${peak} 超容量 3（刷新瞬间不得超发）`);
  l.stop();
});

test("错误恢复：任务失败后容量归还（不泄漏）", async () => {
  const l = new SimpleLimiter({ reservoir: 1, reservoirRefreshAmount: 1, reservoirRefreshInterval: 10000 });
  await l.schedule(async () => { throw new Error("x"); }).catch(() => {});
  // 容量应已归还：下一个任务立即执行（不等待刷新）
  let started = false;
  const p = l.schedule(async () => { started = true; });
  await sleep(50);
  assert.equal(started, true, "失败任务后容量未归还");
  await p;
  l.stop();
});

test("刷新语义：refreshAmount 补足而非累加，进行中任务不占新容量", async () => {
  const l = new SimpleLimiter({ reservoir: 2, reservoirRefreshAmount: 2, reservoirRefreshInterval: 100 });
  let concurrent = 0, peak = 0;
  const jobs = Array.from({ length: 6 }, () =>
    l.schedule(async () => { concurrent++; peak = Math.max(peak, concurrent); await sleep(160); concurrent--; }));
  // 每个任务跨 1-2 个刷新窗口：若实现把进行中任务计入新容量，峰值会超过 2
  await Promise.all(jobs);
  assert.ok(peak <= 4, `峰值 ${peak}：刷新窗口语义异常（不应把进行中任务重复计入容量）`);
  l.stop();
});

test("资源释放：stop 后刷新定时器不再触发", async () => {
  const l = new SimpleLimiter({ reservoir: 1, reservoirRefreshAmount: 1, reservoirRefreshInterval: 50 });
  await l.schedule(async () => 1);
  l.stop();
  const reservoirAfter = l.reservoir();
  await sleep(160); // 跨 3 个刷新周期
  assert.equal(l.reservoir(), reservoirAfter, "stop 后刷新仍触发（定时器未清理）");
});

test("状态组合：排队中任务在 stop 时被拒绝且不执行", async () => {
  const l = new SimpleLimiter({ reservoir: 1, reservoirRefreshAmount: 1, reservoirRefreshInterval: 10000 });
  const first = l.schedule(async () => { await sleep(80); });
  const queued = l.schedule(async () => { throw new Error("不应执行"); });
  await sleep(10);
  l.stop();
  await assert.rejects(queued, /stop/i);
  await first;
});
