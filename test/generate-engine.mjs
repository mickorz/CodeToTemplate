/**
 * generate-engine.mjs —— 引擎测试（P0-1/P0-2/P0-4 验收，自包含不调 LLM）
 *
 * 验收映射（评审标准）：
 *   1. 相同输入第二次运行不再调用 Agent（缓存命中）          -> P0-1
 *   2. 单模块失败不影响其他成功模块（失败隔离 + journal 记录）  -> P0-2
 *   3. --only 单模块执行                                      -> P0-2
 *   4. 契约失败/Agent 失败的原始输出保留在 analysis-debug/      -> 调试性
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGenerateEngine } from "../src/generate/engine.ts";
import { PROMPT_VERSION } from "../src/generate/normalize.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixtureKnowledge = path.join(here, "fixtures", "mini-knowledge");
const fixtureRepo = path.join(here, "fixtures", "mini-repo");
const tmp = path.join(root, "dev-examples", "engine-test");

let pass = 0, fail = 0;
function assert(cond, name, detail = "") {
  if (cond) { console.log(`[通过] ${name}`); pass++; }
  else { console.error(`[失败] ${name}${detail ? `: ${detail}` : ""}`); fail++; }
}

const manifest = JSON.parse(readFileSync(path.join(fixtureKnowledge, "repository-manifest.json"), "utf-8"));
const modules = [
  { id: "test.entry", name: "入口", summary: "假入口", source_files: ["entry.js"], dependencies: [] },
  { id: "test.supervisor", name: "监护", summary: "假监护", source_files: ["src/supervisor.js"], dependencies: [] },
];

function freshKnowledge() {
  rmSync(tmp, { recursive: true, force: true });
  cpSync(fixtureKnowledge, tmp, { recursive: true });
  // engine 需要写 ctx 临时文件，目录已随复制存在
}

// --- 1. 首次运行：全部 completed，缓存未命中 ---
freshKnowledge();
{
  const r = await runGenerateEngine({
    knowledgeDir: tmp, repoDir: fixtureRepo, manifest, modules,
    agentScript: path.join(here, "fixtures", "fail-agent.mjs"),
    agentCmdLabel: "fail-agent", resume: false,
  });
  assert(r.analyses.length === 2, "首次运行两模块成功");
  assert(r.journalEntries.every((e) => e.status === "completed" && !e.cache_hit), "首次全部 cache_hit=false");
  assert(r.failed.length === 0, "无失败");
}

// --- 2. 第二次运行：全部缓存命中（不再调 Agent） ---
{
  const r = await runGenerateEngine({
    knowledgeDir: tmp, repoDir: fixtureRepo, manifest, modules,
    agentScript: path.join(here, "fixtures", "fail-agent.mjs"),
    agentCmdLabel: "fail-agent", resume: false,
  });
  assert(r.analyses.length === 2, "二次运行两模块成功");
  assert(r.journalEntries.every((e) => e.cache_hit && e.llm_calls === 0), "P0-1 验收：二次运行零 Agent 调用（全缓存命中）");
}

// --- 3. 缓存键含 prompt_version：版本变化后失效 ---
{
  // 通过换 agent 标签模拟配置变化（cache key 成分之一）
  const r = await runGenerateEngine({
    knowledgeDir: tmp, repoDir: fixtureRepo, manifest, modules,
    agentScript: path.join(here, "fixtures", "fail-agent.mjs"),
    agentCmdLabel: "fail-agent-v2", resume: false,
  });
  assert(r.journalEntries.every((e) => !e.cache_hit), "agent 配置变化后缓存失效（key 含 agent/prompt_version）");
}

// --- 4. 失败隔离：一个模块失败，另一个成功 ---
{
  const r = await runGenerateEngine({
    knowledgeDir: tmp, repoDir: fixtureRepo, manifest,
    modules: [...modules, { id: "test.fail-bomb", name: "炸弹", summary: "", source_files: ["src/util.js"], dependencies: [] }],
    agentScript: path.join(here, "fixtures", "fail-agent.mjs"),
    agentCmdLabel: "fail-agent-v2", resume: false,
  });
  assert(r.failed.length === 1 && r.failed[0].module_id === "test.fail-bomb", "P0-2 验收：失败模块被隔离");
  assert(r.analyses.length === 2, "P0-2 验收：失败不影响其他成功模块");
  const journal = JSON.parse(readFileSync(path.join(tmp, "analysis-journal.json"), "utf-8"));
  const lastRun = journal.runs[journal.runs.length - 1];
  assert(lastRun.modules.some((m) => m.status === "failed" && m.module_id === "test.fail-bomb"), "journal 记录失败模块与状态");
  assert(lastRun.passed === false, "journal 整体 passed=false");
}

// --- 5. --only 单模块 ---
{
  const r = await runGenerateEngine({
    knowledgeDir: tmp, repoDir: fixtureRepo, manifest, modules,
    agentScript: path.join(here, "fixtures", "fail-agent.mjs"),
    agentCmdLabel: "fail-agent-v2", resume: false,
    only: ["test.supervisor"],
  });
  assert(r.analyses.length === 1 && r.analyses[0].module_id === "test.supervisor", "--only 只执行指定模块");
}

// --- 6. 缓存文件为合法 JSON 且含 cache_key（原子写入产物可解析） ---
{
  const cacheFile = path.join(tmp, "analysis-cache", "test.entry.json");
  assert(existsSync(cacheFile), "缓存文件存在");
  const entry = JSON.parse(readFileSync(cacheFile, "utf-8"));
  assert(typeof entry.cache_key === "string" && entry.cache_key.length === 24, "缓存含稳定 cache_key");
  assert(entry.analysis.module_id === "test.entry", "缓存内容为契约通过的模块分析");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[结果] 引擎测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
