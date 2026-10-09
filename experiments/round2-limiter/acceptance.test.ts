// 显性验收（需求文档中已声明的行为）
import test from "node:test";
import assert from "node:assert/strict";
import { SimpleLimiter } from "../src/limiter.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("容量内立即执行", async () => {
  const l = new SimpleLimiter({ reservoir: 3, reservoirRefreshAmount: 3, reservoirRefreshInterval: 1000 });
  let ran = 0;
  await Promise.all([1, 2, 3].map(() => l.schedule(async () => { ran++; })));
  assert.equal(ran, 3);
  l.stop();
});

test("超容量排队，刷新后继续", async () => {
  const l = new SimpleLimiter({ reservoir: 2, reservoirRefreshAmount: 2, reservoirRefreshInterval: 120 });
  const ran: number[] = [];
  const jobs = Array.from({ length: 4 }, (_, i) => l.schedule(async () => { ran.push(i); await sleep(20); }));
  await sleep(60);
  assert.equal(ran.length, 2, "首轮只跑 2 个");
  await Promise.all(jobs);
  assert.equal(ran.length, 4);
  l.stop();
});

test("结果与错误传播", async () => {
  const l = new SimpleLimiter({ reservoir: 1, reservoirRefreshAmount: 1, reservoirRefreshInterval: 1000 });
  assert.equal(await l.schedule(async () => 7), 7);
  await assert.rejects(l.schedule(async () => { throw new Error("job-fail"); }), /job-fail/);
  l.stop();
});

test("stop 后新任务被拒绝", async () => {
  const l = new SimpleLimiter({ reservoir: 1, reservoirRefreshAmount: 1, reservoirRefreshInterval: 1000 });
  l.stop();
  await assert.rejects(l.schedule(async () => {}), /stop/i);
});
