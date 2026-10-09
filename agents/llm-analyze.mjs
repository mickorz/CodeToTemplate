/**
 * llm-analyze.mjs —— 真实 LLM 分析 Agent（P2-4 修复版：真两阶段 targeted）
 *
 * 模式（CTT_READ_MODE）：
 *   full     整文件（核心 60KB / 测试降权 8KB）入 prompt，一次 LLM 调用
 *   targeted 两阶段（评审 P0-1 修复）：符号清单 -> LLM 规划行段 -> 受控协议实读
 *            -> 二次 LLM 基于真实片段生成；evidence 行号约束在实际读取范围内
 *
 * 隔离（security-model.md）：源码经白名单协议读出后嵌入 prompt；LLM CLI 在
 * 一次性临时空目录运行；输出经防泄扫描。
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { makeLineReader } from "./lib/line-protocol.mjs";
import { normalizeAnalysis, PROMPT_VERSION } from "../src/generate/normalize.ts";

const contextPath = process.argv[2];
if (!contextPath) {
  console.error("用法: node llm-analyze.mjs <analysis-context.json>");
  process.exit(2);
}

const ctx = JSON.parse(readFileSync(contextPath, "utf-8"));
const readLine = makeLineReader();
const READ_MODE = process.env.CTT_READ_MODE || "full";

function request(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function readViaProtocol(p, from, to) {
  const payload = from !== undefined
    ? { op: "read_range", path: p, from, to }
    : { op: "read_file", path: p };
  request(payload);
  const line = await readLine();
  try { return JSON.parse(line); } catch { return { ok: false, error: "协议应答解析失败" }; }
}

const LLM_CMD = process.env.LLM_CMD || "opencode run";
const LLM_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CORE_CHARS = 60_000;
const MAX_TEST_CHARS = 8_000;

function isTestFile(p) {
  return /(^|\/)(test|tests|test-d|__tests__)(\/|$)/.test(p) || /\.test\.[cm]?[jt]s$|\.spec\.[cm]?[jt]s$/.test(p);
}

function callLLM(prompt) {
  // P2-4-1：LLM CLI 在隔离临时空目录运行（cwd 无仓库/宿主项目上下文）
  const sandboxDir = mkdtempSync(path.join(tmpdir(), "ctt-llm-"));
  let out;
  try {
    out = execFileSync(LLM_CMD, {
      input: prompt,
      encoding: "utf-8",
      timeout: LLM_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: sandboxDir,
    });
  } catch (e) {
    if (e.stdout) { console.error("[llm-analyze] LLM 退出码非零但输出已捕获，继续"); return e.stdout; }
    throw e;
  } finally {
    try { rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
  return out;
}

/** P2-4-1 输出侧防泄检测：LLM 输出含疑似宿主敏感内容时拒绝采纳（纵深防御第三层） */
const LEAK_PATTERNS = /\bBEGIN (RSA|OPENSSH|EC) PRIVATE KEY\b|\bssh-rsa AAAA|\bssh-ed25519 AAAA|\baws_access_key_id\b|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b|password\s*=\s*['"][^'"]{6,}/i;

function scanForLeaks(text, label) {
  const hit = LEAK_PATTERNS.exec(text);
  if (hit) {
    console.error(`[llm-analyze] ${label} 输出疑似泄露敏感内容（模式：${hit[0].slice(0, 12)}...），已拒绝采纳`);
    return true;
  }
  return false;
}

/** 从 LLM 输出提取 JSON（容忍杂讯/代码块/多对象，逐候选解析） */
function extractJson(text) {
  const candidates = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* 试下一个 */ }
  }
  throw new Error(`LLM 输出无可用 JSON（前 300 字符: ${text.slice(0, 300).replace(/\n/g, " ")}）`);
}

const SCHEMA_PROMPT = `你是一名资深代码架构分析师。基于下面提供的模块源码（仅这些内容，禁止假设源码之外的任何信息），输出严格的 JSON（不要输出其他文字）。

要求的 JSON 结构（module-analysis 单模块）：
{
  "module_id": "<给定>",
  "name": "<给定>",
  "summary": "模块能力一句话（仅基于源码）",
  "facts": [{"statement": "实现事实", "status": "verified", "evidence": [{"file": "<文件路径>", "lines": [起始行, 结束行], "note": "证据说明"}]}],
  "execution_flows": [{"name": "流程名", "status": "verified|inferred", "steps": [{"action": "步骤", "evidence_file": "<文件>"}]}],
  "interfaces": [{"symbol": "符号名", "kind": "class|function|interface|type|method", "file": "<文件>", "line": 行号}],
  "dependencies": {"internal_files": [], "external_packages": []},
  "inferences": [{"statement": "设计意图推断", "basis": "依据"}],
  "reuse_guidance": {"portable": [], "adapt": [], "risks": []},
  "open_questions": [],
  "read_files": [<实际读到的文件路径数组>]
}

硬性规则：
0. 逐文件分析：对提供的每一个源文件/源码片段，提取其核心行为/协议语义/特殊处理（与模块主题相关的关键机制不得遗漏）
1. facts 只能陈述源码可直接证实的内容，evidence 的 file 必须来自实际提供的文件（路径原样引用，不加 ./ 前缀），lines 填真实行号范围
2. 推断（设计意图、作者动机）只能放 inferences，不得混入 facts
3. execution_flows 的每个步骤必须指向真实存在的代码位置；无法从源码确认的流程标 status 为 inferred 或不写
4. 答不出的问题放进 open_questions（如"完整调用链需要未提供的文件"），禁止编造
5. reuse_guidance 基于已见源码给出可移植部分/需适配部分/风险
（prompt_version: ${PROMPT_VERSION}）`;

/** 两阶段 targeted：阶段一让 LLM 从符号清单规划要读的行段 */
async function planReadRanges(mod, fileSummaries) {
  const planPrompt = `你是代码分析规划员。下面是模块内各文件的符号清单（符号+行号）。为分析该模块的核心机制，选择最值得读取的代码行段（每段至多 200 行，总计至多 12 段）。

只输出 JSON：{"requests": [{"path": "文件路径", "from": 起始行, "to": 结束行, "reason": "要看的机制"}]}

## 模块
${mod.id}: ${mod.summary || ""}

## 符号清单
${fileSummaries.join("\n\n")}`;
  const plan = extractJson(callLLM(planPrompt));
  return Array.isArray(plan.requests) ? plan.requests.slice(0, 12) : [];
}

async function analyzeModule(mod) {
  if (READ_MODE === "targeted" && ctx.symbols) {
    const fileSummaries = [];
    for (const f of mod.source_files) {
      if (!ctx.symbols[f]) continue;
      fileSummaries.push(`### 文件 ${f}（${ctx.symbols[f].length} 个符号）\n` +
        ctx.symbols[f].slice(0, 60).map((s) => `  L${s.line} ${s.kind} ${s.name}`).join("\n"));
    }
    if (fileSummaries.length) {
      // 两阶段（评审 P0-1 修复）：符号清单 -> LLM 规划 -> 受控协议实读 -> 二次 LLM 基于真实片段生成
      const requests = await planReadRanges(mod, fileSummaries);
      console.error(`[llm-analyze] ${mod.id} targeted 规划 ${requests.length} 个行段，协议实读...`);
      const fileContents = [];
      const readFiles = [];
      const readRanges = [];
      for (const req of requests) {
        const resp = await readViaProtocol(String(req.path), Number(req.from), Number(req.to));
        if (resp && resp.ok) {
          if (!readFiles.includes(resp.path)) readFiles.push(resp.path);
          readRanges.push({ file: resp.path, from: resp.from, to: resp.to });
          fileContents.push(`### 文件 ${resp.path} 行 ${resp.from}-${resp.to}（实际读取的源码）\n${resp.content}`);
        } else {
          console.error(`[llm-analyze] 行段读取失败 ${req.path}:${req.from}-${req.to}`);
        }
      }
      if (readRanges.length) {
        return finalizeAnalysis(mod, fileContents, readFiles, readRanges);
      }
      console.error(`[llm-analyze] ${mod.id} targeted 无可用行段，退化整读`);
    }
  }

  // full 模式 / targeted 退化：整文件读取
  const fileContents = [];
  const readFiles = [];
  for (const f of mod.source_files) {
    const resp = await readViaProtocol(f);
    if (resp && resp.ok) {
      readFiles.push(f);
      const budget = isTestFile(f) ? MAX_TEST_CHARS : MAX_CORE_CHARS;
      const isTest = isTestFile(f);
      const truncated = resp.content.length > budget;
      fileContents.push(
        `### 文件 ${f}${isTest ? "（测试文件，已降权截断：用于验证行为，非核心实现）" : ""}${truncated ? "（内容超预算已截断，截断处之后不可作为证据）" : ""}\n` +
        (truncated ? resp.content.slice(0, budget) + "\n...[已截断]" : resp.content)
      );
    }
  }
  return finalizeAnalysis(mod, fileContents, readFiles, []);
}

async function finalizeAnalysis(mod, fileContents, readFiles, readRanges) {
  const rangeNote = readRanges.length
    ? `

## 证据边界（targeted 两阶段）
你只实际读取了以下行段：${readRanges.map((r) => `${r.file}:${r.from}-${r.to}`).join("、")}。facts 的 evidence 行号必须落在此范围内；范围外的行为只能进 open_questions，不得臆测。`
    : "";

  const prompt = `${SCHEMA_PROMPT}

## 模块定义
id: ${mod.id}
name: ${mod.name}
summary_seed: ${mod.summary || "(无)"}
声明的依赖模块: ${(mod.dependencies || []).join(", ") || "(无)"}

## 模块源码（${fileContents.length} 个文件，行号从 1 开始）
${fileContents.join("\n\n")}${rangeNote}

## 输出
只输出上述结构的 JSON。`;

  console.error(`[llm-analyze] 分析模块 ${mod.id}（${readFiles.length} 文件，prompt ${Math.round(prompt.length / 1024)}KB${readRanges.length ? `，targeted ${readRanges.length} 行段` : ""}）...`);
  let raw = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const outText = callLLM(prompt);
      if (scanForLeaks(outText, mod.id)) {
        console.error(`[llm-analyze] 模块 ${mod.id} 第 ${attempt} 次输出被防泄检测拦截`);
        if (attempt === 2) { raw = null; break; }
        continue;
      }
      raw = extractJson(outText);
      break;
    } catch (e) {
      console.error(`[llm-analyze] 第 ${attempt} 次尝试失败: ${e.message}`);
      if (attempt === 2) {
        console.error(`[llm-analyze] 模块 ${mod.id} 降级为空分析（诚实记录失败）`);
        raw = null;
        break;
      }
    }
  }
  if (raw === null) {
    return {
      schema_version: "1.0", module_id: mod.id, name: mod.name,
      summary: mod.summary || "",
      facts: [], execution_flows: [], interfaces: [],
      dependencies: { internal_files: [], external_packages: [] },
      inferences: [], reuse_guidance: { portable: [], adapt: [], risks: [] },
      open_questions: ["LLM 输出不可解析，本模块分析失败（诚实降级，非编造）"],
      read_files: readFiles, read_ranges: readRanges,
    };
  }
  const normalized = normalizeAnalysis(raw, mod, new Set(ctx.whitelist), readFiles);
  normalized.read_ranges = readRanges; // 证据边界审计：实际读取的行段随产物落盘
  return normalized;
}

async function main() {
  const analyses = [];
  for (const mod of ctx.modules) {
    analyses.push(await analyzeModule(mod));
  }
  request({
    op: "done",
    output: JSON.stringify({
      schema_version: "1.0",
      repository: ctx.repository,
      commit: ctx.commit,
      generated_by: `llm-analyze (${READ_MODE} mode, content-isolated)`,
      analyses,
    }, null, 2),
  });
  await new Promise((r) => setTimeout(r, 50));
  process.exit(0);
}

main().catch((e) => {
  console.error("LLM 分析 Agent 失败:", e);
  process.exit(1);
});
