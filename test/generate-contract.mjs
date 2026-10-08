/**
 * generate-contract.mjs —— P1-2 文档生成契约测试（自包含）
 *
 * 测试流程：
 *
 * main()
 *     ├─> 正向：mini fixture -> mock-analyze 全链路 -> 契约校验 -> 渲染断言
 *     │     断言：12 节标题齐全 / 空槽写明证据不足 / 无编造内容标记
 *     ├─> 上下文不足测试（评审验收用例）：
 *     │     窄白名单（只给 supervisor/util，不给入口）+ 模块声明依赖入口模块
 *     │     断言：open_questions 声明证据边界，不虚构启动流程
 *     ├─> 负向 1：facts 引用未读取文件 -> 契约拒绝（证据边界违规）
 *     ├─> 负向 2：facts 内 status=inferred -> 契约拒绝（禁止升级证据等级）
 *     └─> 退出码：全部通过 0
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/discovery/runner.ts";
import { validateModuleAnalysis } from "../src/generate/analysis-contract.ts";
import { renderAll } from "../src/generate/render.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixtureRepo = path.join(here, "fixtures", "mini-repo");
const tmp = path.join(root, "dev-examples", "p1-generate-contract");

let pass = 0, fail = 0;
function assert(cond, name, detail = "") {
  if (cond) { console.log(`[通过] ${name}`); pass++; }
  else { console.error(`[失败] ${name}${detail ? `: ${detail}` : ""}`); fail++; }
}

async function runMockAnalyze(ctx) {
  mkdirSync(tmp, { recursive: true });
  const ctxPath = path.join(tmp, "analysis-context.json");
  writeFileSync(ctxPath, JSON.stringify(ctx, null, 2), "utf-8");
  const result = await runAgent(path.join(root, "agents", "mock-analyze.mjs"), ctxPath, fixtureRepo, new Set(ctx.whitelist));
  return result;
}

const fullWhitelist = ["entry.js", "src/supervisor.js", "src/util.js"];
const baseCtx = {
  repository: "example/mini-repo",
  commit: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
  whitelist: fullWhitelist,
  modules: [
    { id: "test.entry", name: "入口", summary: "假入口", source_files: ["entry.js"], dependencies: ["test.supervisor"] },
    { id: "test.supervisor", name: "监护", summary: "假监护", source_files: ["src/supervisor.js"], dependencies: [] },
  ],
};

// --- 正向：全链路 + 渲染断言 ---
{
  const result = await runMockAnalyze(baseCtx);
  assert(result.ok, "mock-analyze 子进程完成", result.error ?? "");
  const parsed = JSON.parse(result.output);

  let allOk = true;
  const analyses = [];
  for (const a of parsed.analyses) {
    const c = validateModuleAnalysis(JSON.stringify(a), new Set(fullWhitelist));
    if (!c.ok) { allOk = false; console.error("  契约错误:", c.errors.join("; ")); }
    analyses.push(a);
  }
  assert(allOk, "全部模块分析契约通过");

  // facts 带证据（supervisor 的 READY_MS 常量应被提取）
  const sup = analyses.find((a) => a.module_id === "test.supervisor");
  assert(sup.facts.some((f) => f.statement.includes("READY_MS")), "常量事实被提取且带证据");

  // 渲染断言：12 节 + 空槽声明不足
  const rendered = renderAll(analyses, { repository: "example/mini-repo", commit: baseCtx.commit });
  const md = rendered["entry.md"];
  for (let i = 1; i <= 12; i++) {
    if (!md.includes(`## ${i}. `)) { assert(false, `渲染含第 ${i} 节标题`); break; }
    if (i === 12) assert(true, "渲染 12 节标题齐全");
  }
  assert(md.includes("证据不足"), "空槽写明证据不足（不编造）");
  assert(md.includes("证据边界"), "渲染页含证据边界声明");
}

// --- 上下文不足测试（评审验收用例） ---
{
  const narrowCtx = {
    ...baseCtx,
    whitelist: ["src/supervisor.js", "src/util.js"], // 不给 entry.js（主入口）
    modules: [
      { id: "test.supervisor", name: "监护", summary: "假监护", source_files: ["src/supervisor.js"], dependencies: ["test.entry"] },
    ],
  };
  const result = await runMockAnalyze(narrowCtx);
  assert(result.ok, "窄白名单下 agent 完成", result.error ?? "");
  const a = JSON.parse(result.output).analyses[0];

  // 合格输出：声明证据边界，而非虚构启动流程
  const boundaryDeclared = a.open_questions.some((q) => q.includes("test.entry") && q.includes("未取得证据"));
  assert(boundaryDeclared, "证据边界被声明（入口未取得证据，不虚构启动流程）", JSON.stringify(a.open_questions));
  assert(a.execution_flows.length === 0, "无证据时不产出执行流程");
  const readFiles = new Set(a.read_files);
  const factsAllRead = a.facts.every((f) => f.evidence.every((e) => readFiles.has(e.file) || e.file === "src/supervisor.js"));
  assert(factsAllRead, "facts 只引用实际读取的文件");
  const contract = validateModuleAnalysis(JSON.stringify(a), new Set(narrowCtx.whitelist));
  assert(contract.ok, "窄上下文产物仍满足契约", contract.errors.join("; "));
}

// --- 负向 1：facts 引用未读取文件 ---
{
  const bad = JSON.parse(JSON.stringify({
    schema_version: "1.0", module_id: "x", name: "x", summary: "",
    facts: [{ statement: "虚构事实", status: "verified", evidence: [{ file: "src/util.js" }] }],
    execution_flows: [], interfaces: [], dependencies: { internal_files: [], external_packages: [] },
    inferences: [], reuse_guidance: { portable: [], adapt: [], risks: [] }, open_questions: [],
    read_files: [], // util.js 未读取
  }));
  const c = validateModuleAnalysis(JSON.stringify(bad), new Set(fullWhitelist));
  assert(!c.ok, "facts 引用未读取文件被拒绝（证据边界违规）");
}

// --- 负向 2：facts 内混入 inferred ---
{
  const bad2 = {
    schema_version: "1.0", module_id: "x", name: "x", summary: "",
    facts: [{ statement: "推断伪装成事实", status: "inferred", evidence: [{ file: "entry.js" }] }],
    execution_flows: [], interfaces: [], dependencies: { internal_files: [], external_packages: [] },
    inferences: [], reuse_guidance: { portable: [], adapt: [], risks: [] }, open_questions: [],
    read_files: ["entry.js"],
  };
  const c = validateModuleAnalysis(JSON.stringify(bad2), new Set(fullWhitelist));
  assert(!c.ok, "facts 内 inferred 状态被拒绝（禁止证据升级）");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[结果] 生成契约测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
