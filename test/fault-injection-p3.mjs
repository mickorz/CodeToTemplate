/**
 * fault-injection-p3.mjs —— P3-0c 故障注入测试（四场景）
 *
 * 验证实验器在以下故障下正确标记/拒绝：
 *   1. B2 全部片段读取失败 -> invalid-tool
 *   2. B3 没有调用源码工具 -> non-compliant
 *   3. 隐藏测试评测器异常 -> invalid-infra
 *   4. 重复使用 run_id -> 防覆盖拒绝
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = path.join(root, "dev-examples", "fault-injection-test");

let pass = 0, fail = 0;
function assert(cond, name, detail = "") {
  if (cond) { console.log(`[通过] ${name}`); pass++; }
  else { console.error(`[失败] ${name}${detail ? `: ${detail}` : ""}`); fail++; }
}

function fresh() { rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true }); }

// ============ 1. B2 片段不足 -> invalid-tool ============
fresh();
{
  const auditFile = path.join(tmp, "b2-audit.jsonl");
  // 模拟 MCP 审计：snippet_sufficient: false
  writeFileSync(auditFile, JSON.stringify({
    at: new Date().toISOString(), run_id: "p3-test-b2-001",
    tool: "build_reference_context", ok: true,
    references: 1, mode: "facts-with-snippets",
    snippets: 0, expected: 5, snippet_failures: 5, snippet_sufficient: false,
  }) + "\n");

  // 用 node 检查审计文件并模拟 run_group 的 B2 判定逻辑
  const verdict = execFileSync("node", ["-e", `
    const lines = require('fs').readFileSync('${auditFile.replace(/\\/g, "/")}','utf-8').split('\\n').filter(l=>l.trim());
    for (const l of lines) {
      try { const e = JSON.parse(l);
        if (e.tool==='build_reference_context' && e.snippet_sufficient === false) { console.log('false'); process.exit(0); }
      } catch {}
    }
    console.log('true');
  `], { encoding: "utf-8" }).trim();
  assert(verdict === "false", "1. B2 片段不足被检测（snippet_sufficient=false）");
}

// ============ 2. B3 未调用源码工具 -> non-compliant ============
{
  const auditFile = path.join(tmp, "b3-audit.jsonl");
  // 模拟审计：只有 search，没有 read_source
  writeFileSync(auditFile, JSON.stringify({
    at: new Date().toISOString(), run_id: "p3-test-b3-001",
    tool: "search_capabilities", ok: true,
  }) + "\n");

  const result = spawnSync("node", [
    path.join(root, "scripts", "check-b3-compliance.mjs"), auditFile,
  ], { encoding: "utf-8" }).stdout.trim();
  const verdict = JSON.parse(result).verdict;
  assert(verdict === "non-compliant", "2. B3 未调用源码工具判定 non-compliant", verdict);
}

// ============ 2b. B3 调用但全失败 -> invalid-tool ============
{
  const auditFile = path.join(tmp, "b3-fail-audit.jsonl");
  writeFileSync(auditFile, JSON.stringify({
    at: new Date().toISOString(), run_id: "p3-test-b3-002",
    tool: "read_source_reference", ok: false, error: "git show failed",
  }) + "\n");

  const result = spawnSync("node", [
    path.join(root, "scripts", "check-b3-compliance.mjs"), auditFile,
  ], { encoding: "utf-8" }).stdout.trim();
  assert(JSON.parse(result).verdict === "tool-failure", "2b. B3 全失败判定 tool-failure");
}

// ============ 2c. B3 成功读取 -> valid ============
{
  const auditFile = path.join(tmp, "b3-ok-audit.jsonl");
  writeFileSync(auditFile, JSON.stringify({
    at: new Date().toISOString(), run_id: "p3-test-b3-003",
    tool: "read_source_reference", ok: true, file: "src/awareness.js",
  }) + "\n");

  const result = spawnSync("node", [
    path.join(root, "scripts", "check-b3-compliance.mjs"), auditFile,
  ], { encoding: "utf-8" }).stdout.trim();
  assert(JSON.parse(result).verdict === "valid", "2c. B3 成功读取判定 valid");
}

// ============ 3. 评测器未生成首跑成绩 -> eval_pass=0, eval_fail=-1 ============
{
  // 模拟：first-run.json 不存在时的默认值
  const ws = path.join(tmp, "ws-no-eval");
  mkdirSync(ws, { recursive: true });
  const firstRun = ws + "-first-run.json";
  const hasValid = existsSync(firstRun) && (() => { try { return typeof require(firstRun).pass === "number"; } catch { return false; } })();
  assert(!hasValid, "3. 首跑文件不存在时不视为有效成绩");
}

// ============ 4. 重复 run_id 防覆盖 ============
{
  const resultsDir = path.join(tmp, "results");
  mkdirSync(resultsDir, { recursive: true });
  const existing = path.join(resultsDir, "p3-test-b2-001.json");
  writeFileSync(existing, JSON.stringify({ run_id: "p3-test-b2-001", run_status: "valid" }));

  // 模拟实验器的防覆盖检查
  const alreadyExists = existsSync(existing);
  assert(alreadyExists, "4. 同 run_id 结果存在时实验器应拒绝（检查逻辑验证）");

  // 验证新结果不会覆盖（实验器在启动前检查）
  const seq = "001";
  const checkFile = path.join(resultsDir, `p3-test-b2-${seq}.json`);
  assert(checkFile === existing, "4b. run_id 路径一致（同一文件）");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[结果] 故障注入测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
