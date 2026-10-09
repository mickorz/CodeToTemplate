// 层 2：源码特有兼容测试（yjs/y-protocols awareness @73b2ff75 的特殊行为，Agent 不可见）
import test from "node:test";
import assert from "node:assert/strict";
import { PresenceStore } from "../src/presence.ts";

test("特有1：旧 clock 消息被丢弃（不生效、无事件）", () => {
  const a = new PresenceStore(1);
  const b = new PresenceStore(2);
  b.setLocalState({ v: 2 });
  a.applyUpdate(b.encodeUpdate([2]), "n"); // clock=1
  let fired = 0;
  a.on("update", () => fired++);
  // 伪造旧 clock：手动构造（借助 meta 不可行则用 removeStates+重放）——用 b 的两次更新后重放第一次
  const first = b.encodeUpdate([2]); // 此刻 clock 已到 2（setLocalState 两次? 不）
  // 简化可靠法：c 实例独立演同一 client
  const c = new PresenceStore(2);
  c.setLocalState({ v: 1 }); // clock=1
  const oldBin = c.encodeUpdate([2]); // clock=1
  a.applyUpdate(oldBin, "n2"); // a 已有 clock=2 的 client2 → 旧消息
  assert.equal(a.getStates().get(2)?.v ?? a.getStates().get(2), 2, "旧 clock 状态未覆盖新状态");
  assert.equal(fired, 0, "被丢弃的消息不得触发事件");
});

test("特有2：等 clock 的 null 才能删除远端在线状态", () => {
  const a = new PresenceStore(1);
  const b = new PresenceStore(2);
  b.setLocalState({ v: 1 }); // clock=1
  a.applyUpdate(b.encodeUpdate([2]), "n");
  // 手工构造等 clock 的 null：借助新实例 encode 时 states 替换——用 removeStates 语义近似：
  // 公开路径：b 声明离线 = setLocalState(null)（clock=2, state null）→ a 应用 → 删除
  b.setLocalState(null);
  a.applyUpdate(b.encodeUpdate([2]), "n2");
  assert.ok(!a.getStates().has(2), "等 clock 的 null 声明应删除远端状态");
  // 旧 clock 的 null 不删除：
  const c1 = new PresenceStore(3);
  const c2 = new PresenceStore(3);
  c1.setLocalState({ v: 1 }); // clock=1
  const bin1 = c1.encodeUpdate([3]);
  c2.setLocalState({ v: 2 }); // clock=2
  c2.setLocalState(null); // clock=3, null
  const binNull3 = c2.encodeUpdate([3]);
  const probe = new PresenceStore(9);
  probe.applyUpdate(binNull3, "n"); // 先到达 null(clock=3)：client 未知且 null → 不添加不删除（currClock=0<3 但 state null & clientID!=本地 → states.delete 无效果；meta 记 clock=3）
  probe.applyUpdate(bin1, "n2"); // 旧 clock=1 非 null → 丢弃
  assert.ok(!probe.getStates().has(3), "旧 clock 非空消息不得创建状态");
});

test("特有3：远端 null 不能删除本地有效状态（反制 clock++）", () => {
  const me = new PresenceStore(7);
  me.setLocalState({ alive: true }); // clock=1
  const clockBefore = me.getMeta().get(7)!.clock;
  // 攻击者伪造 clientID=7、等 clock 的 null
  const attacker = new PresenceStore(7);
  attacker.setLocalState({ alive: true }); // clock=1
  attacker.setLocalState(null); // clock=2, state null
  const attackBin = attacker.encodeUpdate([7]);
  me.applyUpdate(attackBin, "attack");
  assert.deepEqual(me.getLocalState(), { alive: true }, "本地有效状态不得被远端 null 删除");
  assert.equal(me.getMeta().get(7)!.clock, clockBefore + 1, "应以 clock+1 反制（广播仍在线）");
});

test("特有4：内容不变时 update 触发而 change 不触发", () => {
  const a = new PresenceStore(1);
  const b = new PresenceStore(2);
  b.setLocalState({ v: 1 }); // clock=1
  a.applyUpdate(b.encodeUpdate([2]), "n");
  b.setLocalState({ v: 1 }); // clock=2 内容相同
  let updateFired = 0, changeFired = 0;
  a.on("update", () => updateFired++);
  a.on("change", () => changeFired++);
  a.applyUpdate(b.encodeUpdate([2]), "n2");
  assert.equal(updateFired, 1, "update 事件照常触发（updated 含 client）");
  assert.equal(changeFired, 0, "内容未变时 change 不触发");
});

test("特有5：心跳自续期与远端超时删除（OUTDATED_TIMEOUT=30s，半程 15s 自续期）", () => {
  let now = 1_000_000;
  const a = new PresenceStore(1, { now: () => now });
  a.setLocalState({ v: 1 });
  const b = new PresenceStore(2, { now: () => now });
  b.setLocalState({ v: 2 });
  a.applyUpdate(b.encodeUpdate([2]), "n");
  // 推进 16 秒：本地 lastUpdated 已过半程 → checkTimeout 自续期（clock+1、lastUpdated 刷新）
  now += 16_000;
  a.checkTimeout();
  assert.ok(a.getLocalState() != null, "本地状态经心跳续期仍在");
  assert.equal(a.getMeta().get(1)!.clock, 2, "自续期使 clock 递增");
  // 再推进 31 秒：远端（client 2）超 30s 未更新 → 删除，origin=timeout
  now += 31_000;
  let timeoutEvt: any = null;
  a.on("change", (e: any, origin: any) => { timeoutEvt = { e, origin }; });
  a.checkTimeout();
  assert.ok(!a.getStates().has(2), "远端超时应删除");
  assert.equal(timeoutEvt?.origin, "timeout");
  assert.ok(a.getLocalState() != null, "本地仍因持续续期而保留");
});
