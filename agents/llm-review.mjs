/**
 * llm-review.mjs —— LLM 语义 Reviewer（P1-4 Reviewer 第二层，独立进程）
 *
 * 与分析 Agent 相同的受控协议与内容级隔离。职责：逐条判断技术结论
 * 是否真的受源码支持（不只行号存在）——确定性 checker 拦「无中生有的能力」，
 * 本层审「细节是否准确、是否过度概括」。
 *
 * 输入 review-context.json：{repository, commit, whitelist, module: {id, source_files, claims: [...]}}
 * 输出 done：{module_id, verdicts: [{statement, verdict: supported|unsupported|unverifiable, reason}]}
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { makeLineReader } from "./lib/line-protocol.mjs";

const contextPath = process.argv[2];
if (!contextPath) {
  console.error("用法: node llm-review.mjs <review-context.json>");
  process.exit(2);
}

const ctx = JSON.parse(readFileSync(contextPath, "utf-8"));
const mod = ctx.modules[0];
const readLine = makeLineReader();

function request(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function readViaProtocol(path) {
  request({ op: "read_file", path });
  const line = await readLine();
  try { return JSON.parse(line); } catch { return { ok: false, error: "协议应答解析失败" }; }
}

const LLM_CMD = process.env.LLM_CMD || "opencode run";
const MAX_FILE_CHARS = 60_000;

function callLLM(prompt) {
  // P2-4-1：隔离 cwd（与 llm-analyze 同策略）
  const sandboxDir = mkdtempSync(path.join(tmpdir(), "ctt-rev-"));
  let out;
  try {
    out = execFileSync(LLM_CMD, {
      input: prompt, encoding: "utf-8", timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024, shell: true, stdio: ["pipe", "pipe", "pipe"],
      cwd: sandboxDir,
    });
  } catch (e) {
    if (e.stdout) return e.stdout;
    throw e;
  } finally {
    try { rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
  return out;
}

function extractJson(text) {
  const candidates = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* 下一个 */ }
  }
  throw new Error(`LLM 输出无可用 JSON（前 300 字符: ${text.slice(0, 300).replace(/\n/g, " ")}）`);
}

const PROMPT = `你是独立技术审查员（Reviewer）。下面给你模块源码与一组待审查的技术结论。逐条判断每条结论是否被源码支持。

判定标准：
- supported：源码可直接证实该结论（不只是文件存在——结论描述的行为/机制必须能在源码中找到对应实现）
- unsupported：源码与结论矛盾，或结论描述的能力/行为在源码中不存在（即使引用的文件路径真实存在）
- unverifiable：依据提供的源码无法判定（如需要未提供的文件）

特别注意：
- 引用真实文件 + 行号正确，但结论描述的机制不存在 -> unsupported
- 过度概括（如把个别行为说成普遍保证）-> unsupported，理由写明
- 只输出 JSON，格式：{"verdicts": [{"statement": "原句", "verdict": "...", "reason": "一句理由"}]}`;

async function main() {
  const fileContents = [];
  for (const f of mod.source_files.slice(0, 8)) {
    const resp = await readViaProtocol(f);
    if (resp && resp.ok) {
      const truncated = resp.content.length > MAX_FILE_CHARS;
      fileContents.push(`### ${f}${truncated ? "（截断）" : ""}\n` + (truncated ? resp.content.slice(0, MAX_FILE_CHARS) : resp.content));
    }
  }

  const prompt = `${PROMPT}

## 源码
${fileContents.join("\n\n")}

## 待审查结论（${mod.claims.length} 条）
${mod.claims.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## 输出（只输出 JSON，对每条结论给 verdict）`;

  console.error(`[llm-review] 审查模块 ${mod.id}（${mod.claims.length} 条结论，${fileContents.length} 文件）...`);
  const out = callLLM(prompt);
  const parsed = extractJson(out);
  request({ op: "done", output: JSON.stringify({ module_id: mod.id, verdicts: parsed.verdicts ?? [] }) });
  await new Promise((r) => setTimeout(r, 50));
  process.exit(0);
}

main().catch((e) => {
  console.error("LLM Reviewer 失败:", e);
  process.exit(1);
});
