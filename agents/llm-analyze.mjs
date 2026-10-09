/**
 * llm-analyze.mjs —— 真实 LLM 分析 Agent（P1-4，引擎改造版）
 *
 * 引擎（engine.ts）逐模块调用本 Agent（单模块 ctx），缓存/失败隔离由引擎负责。
 * 隔离设计（内容级）：源码经受控读取协议读出后嵌入 prompt，LLM CLI 只收到文本。
 * 规范化与结构补齐使用共享 normalize.ts（与离线验证 --validate-analysis 同一路径）。
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

function request(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function readViaProtocol(path, from, to) {
  const payload = from !== undefined
    ? { op: "read_range", path, from, to }
    : { op: "read_file", path };
  request(payload);
  const line = await readLine();
  try { return JSON.parse(line); } catch { return { ok: false, error: "协议应答解析失败" }; }
}

/** LLM 命令：默认 opencode run，可用环境变量替换；prompt 经 stdin 传递 */
const LLM_CMD = process.env.LLM_CMD || "opencode run";
const LLM_TIMEOUT_MS = 10 * 60 * 1000;
/** 源码文件进入 prompt 的预算：核心实现 60KB；测试文件降权 8KB（P1：评审建议，测试用于验证行为而非深读） */
const MAX_CORE_CHARS = 60_000;
const MAX_TEST_CHARS = 8_000;

function isTestFile(p) {
  return /(^|\/)(test|tests|test-d|__tests__)(\/|$)/.test(p) || /\.test\.[cm]?ts$|\.spec\.[cm]?ts$/.test(p);
}

function callLLM(prompt) {
  const sandboxDir = mkdtempSync(path.join(tmpdir(), "ctt-llm-"));
  let out;
  try {
    out = execFileSync(LLM_CMD, {
      input: prompt,
      encoding: "utf-8",
      timeout: LLM_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      shell: true, // Windows 下 opencode 为 .cmd shim；命令串固定，prompt 走 stdin
      stdio: ["pipe", "pipe", "pipe"],
      cwd: sandboxDir,
    });
  } catch (e) {
    // opencode（Bun）退出时尾部异步 flush 可能 EPIPE 致非零退出码，但 stdout 已完整捕获
    if (e.stdout) { console.error("[llm-analyze] LLM 退出码非零但输出已捕获，继续"); return e.stdout; }
    throw e;
  } finally {
    try { rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* 清理尽力 */ }
  }
  return out;
}

/** P2-4-1 输出侧防泄检测：LLM 输出含疑似宿主敏感内容时拒绝采纳（纵深防御第三层） */
const LEAK_PATTERNS = /BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ssh-rsa AAAA|ssh-ed25519 AAAA|aws_access_key_id|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|password\s*=\s*['"][^'"]{6,}/i;

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
0. 逐文件分析：对提供的每一个源文件，提取其核心行为/协议语义/特殊处理（一个文件至少 2 条 facts；与模块主题相关的关键机制不得遗漏）
1. facts 只能陈述源码可直接证实的内容，evidence 的 file 必须来自实际提供的文件（路径原样引用，不加 ./ 前缀），lines 填真实行号范围
2. 推断（设计意图、作者动机）只能放 inferences，不得混入 facts
3. execution_flows 的每个步骤必须指向真实存在的代码位置；无法从源码确认的流程标 status 为 inferred 或不写
4. 答不出的问题放进 open_questions（如"完整调用链需要未提供的文件"），禁止编造
5. reuse_guidance 基于已见源码给出可移植部分/需适配部分/风险
（prompt_version: ${PROMPT_VERSION}）`;

const READ_MODE = process.env.CTT_READ_MODE || "full"; // full：整文件入 prompt；targeted：符号清单 + read_range 按需深读（P2-4-3）

async function analyzeModule(mod) {
  const fileContents = [];
  const readFiles = [];

  if (READ_MODE === "targeted" && ctx.symbols) {
    // 两阶段：第一阶段只给符号清单（文件+符号+行号），Agent 判断后按需 read_range
    for (const f of mod.source_files) {
      if (!ctx.symbols[f]) continue; // 无符号表的文件退化为整读
      const budget = isTestFile(f) ? MAX_TEST_CHARS : MAX_CORE_CHARS;
      readFiles.push(f);
      const sym = ctx.symbols[f];
      fileContents.push(
        `### 文件 ${f}（符号清单，共 ${sym.length} 个符号；可用 read_range 协议按需读取具体行段）\n` +
        sym.slice(0, 60).map((s) => `  L${s.line} ${s.kind} ${s.name}`).join("\n")
      );
    }
  } else {
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
  }

  const prompt = `${SCHEMA_PROMPT}

## 模块定义
id: ${mod.id}
name: ${mod.name}
summary_seed: ${mod.summary || "(无)"}
声明的依赖模块: ${(mod.dependencies || []).join(", ") || "(无)"}

## 模块源码（共 ${fileContents.length} 个文件，行号从 1 开始）
${fileContents.join("\n\n")}${READ_MODE === "targeted" && ctx.symbols ? `

## 按需深读
上述为符号清单。你必须先确定与模块能力相关的关键符号，再通过 read_range 协议读取其行段（每次至多 200 行）获取源码细节；evidence 行号必须来自实际读到的行段。关键机制的 facts 不得凭符号名臆测。` : ""}

## 输出
只输出上述结构的 JSON。`;

  console.error(`[llm-analyze] 分析模块 ${mod.id}（${readFiles.length} 文件，prompt ${Math.round(prompt.length / 1024)}KB）...`);
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
      read_files: readFiles,
    };
  }
  // 规范化与结构补齐走共享模块（与离线验证同一路径）
  return normalizeAnalysis(raw, mod, new Set(ctx.whitelist), readFiles);
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
      generated_by: "llm-analyze (opencode, content-isolated)",
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
