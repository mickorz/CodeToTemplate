/**
 * hang-cleanup.mjs —— 进程树超时清理验证（P0-2，正式测试，进 npm test）
 *
 * hang-agent 派生嵌套子进程（ping）后静默 -> runner 空闲超时 ->
 * 统一 killTree 路径 -> 验证整棵树无残留。
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.CTT_AGENT_IDLE_TIMEOUT_MS = "4000";
const { runAgent } = await import("../src/discovery/runner.ts");

const here = path.dirname(fileURLToPath(import.meta.url));

const countPing = () => {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq PING.EXE"], { encoding: "utf-8" });
    return (out.match(/PING\.EXE/g) || []).length;
  } catch { return 0; }
};

const before = countPing();
const r = await runAgent(
  path.join(here, "fixtures", "hang-agent.mjs"),
  path.join(here, "fixtures", "mini-assertions.json"),
  path.join(here, "fixtures", "mini-repo"),
  new Set(["entry.js"]),
);
await new Promise((res) => setTimeout(res, 2000));
const after = countPing();

const pass = !r.ok && /空闲超时/.test(r.error ?? "") && after <= before;
console.log(`[结果] 超时触发: ${!r.ok}，嵌套进程残留变化: ${after - before}`);
if (!pass) { console.error("[失败] 进程树清理验证未通过"); process.exit(1); }
console.log("[结果] 进程树超时清理验证通过（嵌套子进程零残留）");
