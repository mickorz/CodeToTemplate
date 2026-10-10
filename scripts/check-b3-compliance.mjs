/**
 * check-b3-compliance.mjs —— B3 evidence-required 合规判定（P3-0 修复）
 *
 * 从 MCP 审计日志判定 Agent 是否遵守了证据核对要求：
 *   valid            成功读取了关键源码（read_source_reference ok=true 至少 1 次）
 *   tool-failure     调用了源码工具但全部失败
 *   non-compliant    完全没有调用源码工具（仅消费了 facts 摘要）
 *
 * 用法：node scripts/check-b3-compliance.mjs <mcp-audit.jsonl>
 */

import { readFileSync, existsSync } from "node:fs";

const auditPath = process.argv[2];
if (!auditPath || !existsSync(auditPath)) {
  console.error("用法: node scripts/check-b3-compliance.mjs <mcp-audit.jsonl>");
  process.exit(2);
}

const lines = readFileSync(auditPath, "utf-8").split("\n").filter((l) => l.trim());
const readCalls = [];
for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    if (entry.tool === "read_source_reference") {
      readCalls.push(entry);
    }
  } catch { /* skip */ }
}

const succeeded = readCalls.filter((c) => c.ok).length;
const failed = readCalls.filter((c) => !c.ok).length;

let verdict;
if (succeeded > 0) {
  verdict = "valid";
} else if (readCalls.length > 0) {
  verdict = "tool-failure";
} else {
  verdict = "non-compliant";
}

console.log(JSON.stringify({
  verdict,
  total_calls: readCalls.length,
  succeeded,
  failed,
  details: readCalls.map((c) => ({
    ok: c.ok,
    file: c.file,
    range: c.range,
    error: c.error ?? null,
  })),
}, null, 2));

process.exit(verdict === "valid" ? 0 : 1);
