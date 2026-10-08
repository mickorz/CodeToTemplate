/**
 * mock-analyze.mjs —— Mock 分析 Agent（P1-2，规则版）
 *
 * 复用 P1-1 受控读取协议。输入：analysis-context.json（模块定义 + 白名单）。
 *
 * 规则版分析流程（无 LLM，全部从实际读到的源码提取）：
 *
 * main()
 *     ├─> 对每个模块：受控读取全部 source_files
 *     ├─> facts：从注释/常量赋值/导出提取，逐条带 file+line 证据（只写读到的）
 *     ├─> interfaces：导出符号（module.exports 键 / 顶层 function）
 *     ├─> dependencies：require/import 解析（内部文件 + 外部包）
 *     ├─> execution_flows：仅当能从 require 链拼出顺序时给 verified，否则 inferred 或缺省
 *     ├─> open_questions：模块引用但未读取（白名单外）的关键路径 -> 声明证据边界
 *     └─> done 输出 module-analysis JSON（每模块一项）
 */

import { readFileSync } from "node:fs";
import { makeLineReader } from "./lib/line-protocol.mjs";

const contextPath = process.argv[2];
if (!contextPath) {
  console.error("用法: node mock-analyze.mjs <analysis-context.json>");
  process.exit(2);
}

const ctx = JSON.parse(readFileSync(contextPath, "utf-8"));
const readLine = makeLineReader();

function request(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function readViaProtocol(path) {
  request({ op: "read_file", path });
  const line = await readLine();
  try { return JSON.parse(line); } catch { return { ok: false, error: "协议应答解析失败" }; }
}

/** 行号定位：token 首次出现行 */
function lineOf(lines, token) {
  const idx = lines.findIndex((l) => l.includes(token));
  return idx === -1 ? undefined : idx + 1;
}

async function analyzeModule(mod) {
  const files = {};
  for (const f of mod.source_files) {
    const resp = await readViaProtocol(f);
    if (resp && resp.ok) files[f] = resp.content.split(/\r?\n/);
  }
  const readFiles = Object.keys(files);

  const facts = [];
  const interfaces = [];
  const internalDeps = new Set();
  const externalDeps = new Set();
  const openQuestions = [];

  for (const [file, lines] of Object.entries(files)) {
    // facts：含注释或常量的行（保守：取描述性注释与数值常量赋值）
    lines.forEach((l, i) => {
      const m = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]{3,})\s*=\s*(.+);?$/.exec(l.trim());
      if (m) {
        facts.push({
          statement: `常量 ${m[1]} = ${m[2].slice(0, 60)}`,
          status: "verified",
          evidence: [{ file, lines: [i + 1, i + 1], note: "常量赋值行" }],
        });
      }
    });
    // 注释块开头（前 5 行内的中文/英文说明）作为模块级事实
    const headComment = lines.slice(0, 8).filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l)).slice(0, 2);
    for (const c of headComment) {
      const text = c.replace(/^\s*(\/\/|\*|\/\*)\s?/, "").trim();
      if (text.length > 10 && !text.startsWith("SPDX") && !text.startsWith("@")) {
        facts.push({
          statement: `源码注释：${text.slice(0, 80)}`,
          status: "verified",
          evidence: [{ file, note: "文件头注释" }],
        });
      }
    }

    // interfaces：module.exports 与顶层 function
    lines.forEach((l, i) => {
      const fn = /^(?:async\s+)?function\s+(\w+)/.exec(l);
      if (fn) interfaces.push({ symbol: fn[1], kind: "function", file, line: i + 1 });
      const cls = /^class\s+(\w+)/.exec(l);
      if (cls) interfaces.push({ symbol: cls[1], kind: "class", file, line: i + 1 });
      const exp = /^module\.exports\s*=\s*\{([^}]*)\}/.exec(l);
      if (exp) {
        for (const name of exp[1].split(",").map((s) => s.trim()).filter(Boolean)) {
          interfaces.push({ symbol: name, kind: "export", file, line: i + 1 });
        }
      }
    });

    // dependencies
    for (const l of lines) {
      const req = /require\(["']([^"']+)["']\)/.exec(l);
      const imp = /import\s+.*from\s+["']([^"']+)["']/.exec(l);
      const spec = req ? req[1] : imp ? imp[1] : null;
      if (!spec) continue;
      if (spec.startsWith(".")) {
        // 解析相对路径到白名单文件（简化：按前缀匹配）
        const base = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
        const joined = base ? `${base}/${spec}`.replace(/\/\.\//g, "/") : spec;
        const hit = ctx.whitelist.find((p) => p === joined || p === `${joined}.js` || p === `${joined}/index.js`);
        if (hit) internalDeps.add(hit);
      } else {
        externalDeps.add(spec.split("/")[0].replace(/^node:/, ""));
      }
    }
  }

  // 证据边界：模块声明依赖了不在本次白名单/未读范围内的文件
  for (const dep of mod.dependencies ?? []) {
    if (!readFiles.some((f) => f.includes(dep.split(".").pop() ?? ""))) {
      openQuestions.push(`模块声明依赖 ${dep}，但该模块源文件未在本次分析范围内，其实现细节未取得证据`);
    }
  }
  if (Object.keys(files).length === 0) {
    openQuestions.push("未能读取任何源文件，本模块分析为空（证据不足，不编造内容）");
  }

  return {
    schema_version: "1.0",
    module_id: mod.id,
    name: mod.name,
    summary: mod.summary ?? "",
    facts,
    execution_flows: [], // 规则版不做跨文件流程推断：留空由渲染器声明证据不足（不虚构）
    interfaces,
    dependencies: { internal_files: [...internalDeps], external_packages: [...externalDeps].sort() },
    inferences: [],
    reuse_guidance: { portable: [], adapt: [], risks: [] },
    open_questions: openQuestions,
    read_files: readFiles,
  };
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
      generated_by: "mock-analyze (rule-based, evidence-bounded)",
      analyses,
    }, null, 2),
  });
  await new Promise((r) => setTimeout(r, 50));
  process.exit(0);
}

main().catch((e) => {
  console.error("Mock 分析 Agent 失败:", e);
  process.exit(1);
});
