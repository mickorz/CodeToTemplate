/**
 * range-violation-agent.mjs —— 测试用 Agent：读取文件但产出越界证据行号
 *
 * 走协议 read_file src/core.js（合法），但 fact 引用 999 行（超出实际 read_ranges 1-2）。
 * 引擎应在 contractOk 联合判断中拒绝（不写入缓存）。
 */

import { readFileSync } from "node:fs";

const ctx = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const NL = String.fromCharCode(10);

// 先请求读取（合法操作，readLog 会记录）
process.stdout.write(JSON.stringify({ op: "read_file", path: "src/core.js" }) + NL);

// 等 stdin 响应后输出（略等，实际 Agent 应等待 readLine）
await new Promise((r) => setTimeout(r, 200));

// 产出越界 fact（引用 999 行，但 read_ranges 只有 1-2）
const analysis = {
  schema_version: "1.0",
  analyses: [{
    schema_version: "1.0", module_id: "m.core", name: "core", summary: "s",
    facts: [{ statement: "HELLO constant", status: "verified", evidence: [{ file: "src/core.js", lines: [999, 999] }] }],
    execution_flows: [], interfaces: [],
    dependencies: { internal_files: [], external_packages: [] },
    inferences: [], reuse_guidance: { portable: [], adapt: [], risks: [] },
    open_questions: [],
    read_files: ["src/core.js"],
    read_ranges: [{ file: "src/core.js", from: 1, to: 2 }],
  }],
};
process.stdout.write(JSON.stringify({ op: "done", output: JSON.stringify(analysis) }) + NL);
await new Promise((r) => setTimeout(r, 100));
process.exit(0);
