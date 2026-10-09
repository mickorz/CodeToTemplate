// 层 1：公开契约组合测试（从需求文档可推导的行为）
import test from "node:test";
import assert from "node:assert/strict";
import { PresenceStore } from "../src/presence.ts";

test("本地状态 set/get 与字段级合并", () => {
  const p = new PresenceStore(1);
  p.setLocalState({ name: "a" });
  assert.deepEqual(p.getLocalState(), { name: "a" });
  p.setLocalStateField("cursor", 5);
  assert.deepEqual(p.getLocalState(), { name: "a", cursor: 5 });
});

test("本地 null 离线：状态删除并触发 removed 事件", () => {
  const p = new PresenceStore(2);
  p.setLocalState({ x: 1 });
  let evt: any = null;
  p.on("change", (e: any) => { evt = e; });
  p.setLocalState(null);
  assert.equal(p.getLocalState(), null);
  assert.ok(evt && evt.removed.includes(2));
});

test("编码往返：跨实例同步远端状态并触发 added", () => {
  const a = new PresenceStore(10);
  const b = new PresenceStore(20);
  a.setLocalState({ role: "editor" });
  const bin = a.encodeUpdate([10]);
  let added: any = null;
  b.on("update", (e: any) => { added = e; });
  b.applyUpdate(bin, "relay");
  assert.deepEqual(b.getStates().get(10), { role: "editor" });
  assert.ok(added && added.added.includes(10));
});

test("removeStates 删除远端并触发事件", () => {
  const p = new PresenceStore(1);
  p.applyUpdate(p.encodeUpdate([1]), "local"); // 确保本地在
  const other = new PresenceStore(2);
  other.setLocalState({ s: 1 });
  p.applyUpdate(other.encodeUpdate([2]), "net");
  assert.ok(p.getStates().has(2));
  let removed: any = null;
  p.on("change", (e: any) => { removed = e; });
  p.removeStates([2], "manual");
  assert.ok(!p.getStates().has(2));
  assert.ok(removed && removed.removed.includes(2));
});
