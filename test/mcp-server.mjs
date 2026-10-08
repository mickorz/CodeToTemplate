/**
 * mcp-server.mjs —— MCP Server 测试（P2-2，自包含：临时 git 仓库 + 临时知识库）
 *
 * 验收（评审四工具 + 固定 Commit 语义）：
 *   1. search_capabilities：需求命中能力（trusted 过滤生效）
 *   2. build_reference_context：返回可信参考（facts/claim_status）
 *   3. get_module_analysis：模块结构与审查状态
 *   4. read_source_reference：固定 commit 读取成功（git show）
 *   5. 安全：错误 commit 拒绝；白名单外文件拒绝
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { buildCatalog } from "../src/catalog/builder.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = path.join(root, "dev-examples", "mcp-test");

let pass = 0, fail = 0;
function assert(cond, name, detail = "") {
  if (cond) { console.log(`[通过] ${name}`); pass++; }
  else { console.error(`[失败] ${name}${detail ? `: ${detail}` : ""}`); fail++; }
}

// --- 测试环境：临时 git 仓库 + 知识库 ---
rmSync(tmp, { recursive: true, force: true });
const gitRepo = path.join(tmp, "repos", "testrepo");
mkdirSync(path.join(gitRepo, "source"), { recursive: true });
writeFileSync(path.join(gitRepo, "source", "index.ts"),
  "export class Scheduler {\n  concurrency = 4;\n  start() { return 1; }\n}\n");
execFileSync("git", ["-C", gitRepo, "init", "-q"]);
execFileSync("git", ["-C", gitRepo, "add", "."]);
execFileSync("git", ["-C", gitRepo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
const SHA = execFileSync("git", ["-C", gitRepo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

const knowledge = path.join(tmp, "knowledge");
const topicDir = path.join(knowledge, "testrepo", "scheduling");
mkdirSync(topicDir, { recursive: true });
writeFileSync(path.join(topicDir, "repository-manifest.json"), JSON.stringify({
  schema_version: "1.0", repository: "testrepo", commit: SHA,
  files: [{ path: "source/index.ts", bytes: 80, blob_sha: "x" }],
  license: { spdx: "MIT" },
}));
writeFileSync(path.join(topicDir, "module-analysis.json"), JSON.stringify({
  schema_version: "1.0", repository: "testrepo", commit: SHA,
  analyses: [{
    schema_version: "1.0", module_id: "scheduling.core", name: "core",
    summary: "并发限制调度器",
    facts: [{ statement: "通过 concurrency 控制并发上限", status: "verified", evidence: [{ file: "source/index.ts", lines: [2, 2] }] }],
    execution_flows: [], interfaces: [{ symbol: "Scheduler", kind: "class", file: "source/index.ts", line: 1 }],
    dependencies: { internal_files: [], external_packages: [] },
    inferences: [], reuse_guidance: { portable: [], adapt: [], risks: [] },
    open_questions: [], read_files: ["source/index.ts"],
  }],
}));
writeFileSync(path.join(topicDir, "review-report.json"), JSON.stringify({
  passed: true, commit: SHA,
  llm: [{ module_id: "scheduling.core", review_status: "reviewed",
    verdicts: [{ statement: "通过 concurrency 控制并发上限", verdict: "supported", reason: "源码第 2 行" }] }],
}));
// 生成 catalog（复用 builder，写盘供 server 读取）
const catalog = buildCatalog(knowledge);
writeFileSync(path.join(knowledge, "catalog.json"), JSON.stringify(catalog));

// --- 连接 server（InMemory）---
const server = createMcpServer({ knowledgeRoot: knowledge, reposRoot: path.join(tmp, "repos") });
const client = new Client({ name: "test", version: "1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

// 1. search_capabilities
{
  const r = await client.callTool({ name: "search_capabilities", arguments: { query: "并发限制的调度器" } });
  const text = r.content[0].text;
  assert(text.includes("concurrency-limit"), "search_capabilities 命中并发能力", text.slice(0, 120));
  assert(text.includes("已审查"), "结果带审查状态标注");
}

// 2. build_reference_context
{
  const r = await client.callTool({ name: "build_reference_context", arguments: { query: "并发限制调度器" } });
  const text = r.content[0].text;
  assert(text.includes("testrepo/scheduling.core"), "reference_context 含可信模块");
  assert(text.includes("[supported]"), "facts 带 claim_status（claim 级可信）", text.slice(0, 200));
}

// 3. get_module_analysis
{
  const r = await client.callTool({ name: "get_module_analysis", arguments: { repo: "testrepo", module_id: "scheduling.core" } });
  const data = JSON.parse(r.content[0].text);
  assert(data.review_status === "reviewed", "get_module_analysis 返回审查状态");
  assert(data.interfaces.length === 1 && data.interfaces[0].symbol === "Scheduler", "返回接口结构");
}

// 4. read_source_reference：固定 commit 成功
{
  const r = await client.callTool({ name: "read_source_reference", arguments: { repo: "testrepo", commit: SHA, file: "source/index.ts" } });
  const text = r.content[0].text;
  assert(text.includes("concurrency = 4"), "固定 Commit 源码读取成功（git show）");
  assert(text.includes(SHA.slice(0, 10)), "响应注明锁定 Commit");
}

// 5. 安全：错误 commit 拒绝 + 白名单外拒绝
{
  const bad = await client.callTool({ name: "read_source_reference", arguments: { repo: "testrepo", commit: "f".repeat(40), file: "source/index.ts" } }).catch((e) => e);
  assert(String(bad.message ?? bad).includes("commit 不匹配") || String(bad).includes("commit 不匹配") || (bad.content && String(bad.content[0]?.text).includes("不匹配")), "错误 commit 被拒绝", JSON.stringify(String(bad.message ?? bad)).slice(0, 120));
  const ghost = await client.callTool({ name: "read_source_reference", arguments: { repo: "testrepo", commit: SHA, file: "etc/passwd" } }).catch((e) => e);
  assert(String(ghost.message ?? ghost).includes("白名单") || (ghost.content && String(ghost.content[0]?.text).includes("白名单")), "白名单外文件被拒绝");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[结果] MCP Server 测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
