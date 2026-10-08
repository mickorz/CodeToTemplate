/**
 * fail-agent.mjs —— 测试用可控失败 Agent（失败隔离测试）
 *
 * 约定：模块 id 含 "fail" 时 exit 1（模拟 Agent 崩溃），否则产出最小合法分析。
 */

import { readFileSync } from "node:fs";

const ctx = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const mod = ctx.modules[0];

if (mod.id.includes("fail")) {
  console.error("[fail-agent] 按约定失败");
  process.exit(1);
}

// 最小合法分析（带一条真实证据）
const facts = [];
if (mod.source_files.length) {
  facts.push({ statement: `包含 ${mod.source_files.length} 个源文件`, status: "verified", evidence: [{ file: mod.source_files[0], note: "模块定义" }] });
}
process.stdout.write(JSON.stringify({
  op: "done",
  output: JSON.stringify({
    schema_version: "1.0", module_id: mod.id, name: mod.name, summary: mod.summary ?? "",
    facts, execution_flows: [], interfaces: [],
    dependencies: { internal_files: [], external_packages: [] },
    inferences: [], reuse_guidance: { portable: [], adapt: [], risks: [] },
    open_questions: [], read_files: mod.source_files,
  }),
}) + "\n");
setTimeout(() => process.exit(0), 50);
