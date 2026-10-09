/**
 * eval-isolated.mjs —— 隐藏测试隔离评测器（P0-3）
 *
 * 修复评审发现：Agent 运行期间隐藏测试在 workspace 内可见（曾用失败反馈返修）。
 *
 * 用法：node scripts/eval-isolated.mjs <workspace> <hiddenTestsDir> [--check-only]
 *
 * 流程：
 *   --check-only：校验 workspace 内不存在隐藏测试文件（Agent 运行前/后均应通过）
 *   评测：隐藏测试拷入 workspace -> 立即运行 node --test（首跑）->
 *         结果独立落盘 <workspace>/../<ws>-first-run.json -> 立即移出隐藏测试
 *
 * 首跑结果不可覆盖：再次运行会拒绝（防止按失败返修后重跑刷分）。
 */

import { cpSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [wsArg, hiddenDirArg, mode] = process.argv.slice(2);
if (!wsArg || !hiddenDirArg) {
  console.error("用法: node scripts/eval-isolated.mjs <workspace> <hiddenTestsDir> [--check-only]");
  process.exit(2);
}
const ws = path.resolve(wsArg);
const hiddenDir = path.resolve(hiddenDirArg);
const firstRunPath = path.resolve(ws, "..", `${path.basename(ws)}-first-run.json`);

function findInWorkspace(names) {
  const hits = [];
  for (const name of names) {
    if (existsSync(path.join(ws, "test", name))) hits.push(name);
  }
  return hits;
}
const hiddenNames = existsSync(hiddenDir) ? readdirSync(hiddenDir).filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.mjs")) : [];

if (mode === "--check-only") {
  const leaked = findInWorkspace(hiddenNames);
  if (leaked.length) {
    console.error(`[校验失败] workspace 内存在隐藏测试: ${leaked.join(", ")}`);
    process.exit(1);
  }
  console.log(`[校验通过] workspace 无隐藏测试（${hiddenNames.length} 个受保护文件均不在）`);
  process.exit(0);
}

if (existsSync(firstRunPath)) {
  console.error(`[拒绝] 首跑结果已存在: ${firstRunPath}（不可覆盖；新实验请使用新 workspace）`);
  process.exit(1);
}

// 拷入 -> 首跑 -> 移出
mkdirSync(path.join(ws, "test"), { recursive: true });
for (const name of hiddenNames) cpSync(path.join(hiddenDir, name), path.join(ws, "test", name));
let result;
try {
  const files = hiddenNames.map((n) => path.join("test", n));
  const out = execFileSync("node", ["--test", ...files], { cwd: ws, encoding: "utf-8", timeout: 120_000 });
  const pass = (out.match(/^ℹ pass (\d+)/m) || [])[1];
  const fail = (out.match(/^ℹ fail (\d+)/m) || [])[1];
  result = { workspace: ws, at: new Date().toISOString(), pass: Number(pass ?? 0), fail: Number(fail ?? 0), raw_tail: out.slice(-500) };
} catch (e) {
  const out = String(e.stdout ?? "");
  const pass = (out.match(/^ℹ pass (\d+)/m) || [])[1];
  const fail = (out.match(/^ℹ fail (\d+)/m) || [])[1];
  result = { workspace: ws, at: new Date().toISOString(), pass: Number(pass ?? 0), fail: Number(fail ?? 1), error: String(e.message).slice(0, 200), raw_tail: out.slice(-500) };
} finally {
  for (const name of hiddenNames) rmSync(path.join(ws, "test", name), { force: true });
}

writeFileSync(firstRunPath, JSON.stringify(result, null, 2), "utf-8");
console.log(`[首跑] pass=${result.pass} fail=${result.fail} -> ${firstRunPath}`);
console.log(`[首跑] 隐藏测试已移出 workspace（下次评测前可用 --check-only 复核）`);
process.exit(result.fail > 0 ? 1 : 0);
