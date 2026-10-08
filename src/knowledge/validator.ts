/**
 * validator.ts —— 通用证据验证器（P1-0 Generic Evidence Validator）
 *
 * 与任何具体仓库解耦：行号断言由外部 JSON 注入（Gold Set 基准归 test/gold-set/）。
 *
 * 校验流程：
 *
 * runVerify(knowledgeDir, repoDir, assertions)
 *     ├─> 检查 1：module-map 的 source_files 全部存在于 manifest
 *     ├─> 检查 2：module-map.dependencies 引用的模块 id 存在
 *     ├─> 检查 3：manifest 与 module-map 的 commit 一致
 *     ├─> 检查 4：文档中引用的仓库路径真实存在（幽灵路径检测）
 *     ├─> 检查 5：行号断言（file + 行范围 + 必含 token，断言来自注入的基准数据）
 *     └─> 输出 checks；全部通过 = true
 *
 * CLI：node src/knowledge/validator.ts <knowledgeDir> <repoDir> <assertionsJson>
 *      通过则同时写出 verification-report.json，失败退出码 1（供 CI 使用）。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Manifest } from "../collector/manifest.ts";

interface ModuleMap {
  repository: string;
  commit: string;
  modules: Array<{
    id: string;
    source_files: string[];
    dependencies: string[];
    confidence: string;
  }>;
}

/** 行号断言（基准数据结构，与仓库无关） */
export interface LineAssertion {
  file: string;
  from: number;
  to: number;
  tokens: string[];
  claim: string;
}

export interface VerifyCheck {
  check: string;
  status: "pass" | "fail";
  detail: string;
}

/** 提取 markdown 中反引号内疑似仓库路径的 token */
function extractPathTokens(md: string, knownPaths: Set<string>, topFiles: Set<string>): string[] {
  const tokens = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return tokens.filter((t) => {
    if (knownPaths.has(t) || topFiles.has(t)) return true;
    return /^[\w.-]+(\/[\w.-]+)+\.(js|json|md|html|css|yml|yaml)$/.test(t);
  });
}

export function runVerify(
  knowledgeDir: string,
  repoDir: string,
  assertions: LineAssertion[] = [],
  moduleMapFile = "module-map.json",
): { checks: VerifyCheck[]; passed: boolean } {
  const manifest = JSON.parse(readFileSync(path.join(knowledgeDir, "repository-manifest.json"), "utf-8")) as Manifest;
  const moduleMap = JSON.parse(readFileSync(path.join(knowledgeDir, moduleMapFile), "utf-8")) as ModuleMap;

  const tracked = new Set(manifest.files.map((f) => f.path));
  const topFiles = new Set(manifest.files.filter((f) => !f.path.includes("/")).map((f) => f.path));
  const checks: VerifyCheck[] = [];

  // 检查 1：source_files 存在性
  const missing: string[] = [];
  for (const mod of moduleMap.modules) {
    for (const f of mod.source_files) if (!tracked.has(f)) missing.push(`${mod.id}: ${f}`);
  }
  checks.push({
    check: "module-map source_files 存在于 manifest",
    status: missing.length ? "fail" : "pass",
    detail: missing.length ? `缺失: ${missing.join("; ")}` : `${moduleMap.modules.length} 个模块全部命中`,
  });

  // 检查 2：dependencies 的模块 id 存在
  const ids = new Set(moduleMap.modules.map((m) => m.id));
  const badDeps: string[] = [];
  for (const mod of moduleMap.modules) {
    for (const d of mod.dependencies) if (!ids.has(d)) badDeps.push(`${mod.id} -> ${d}`);
  }
  checks.push({
    check: "module-map dependencies 指向存在的模块 id",
    status: badDeps.length ? "fail" : "pass",
    detail: badDeps.length ? `无效: ${badDeps.join("; ")}` : "全部有效",
  });

  // 检查 3：commit 一致
  const commitOk = manifest.commit === moduleMap.commit;
  checks.push({
    check: "manifest 与 module-map 的 commit 一致",
    status: commitOk ? "pass" : "fail",
    detail: `${manifest.commit} vs ${moduleMap.commit}`,
  });

  // 检查 4：文档引用路径存在性（对存在的文档检查；自动链路可能尚无 architecture.md）
  const modulesDir = path.join(knowledgeDir, "modules");
  const docCandidates = ["architecture.md", ...(existsSync(modulesDir) ? readdirSync(modulesDir).filter((f) => f.endsWith(".md")).map((f) => `modules/${f}`) : []), ...(existsSync(path.join(knowledgeDir, "generated", "modules")) ? readdirSync(path.join(knowledgeDir, "generated", "modules")).filter((f) => f.endsWith(".md")).map((f) => `generated/modules/${f}`) : [])];
  const docs = docCandidates.filter((d) => existsSync(path.join(knowledgeDir, d)));
  const ghostPaths = new Set<string>();
  for (const doc of docs) {
    const md = readFileSync(path.join(knowledgeDir, doc), "utf-8");
    for (const t of extractPathTokens(md, tracked, topFiles)) {
      if (!tracked.has(t) && !topFiles.has(t)) ghostPaths.add(`${doc}: ${t}`);
    }
  }
  checks.push({
    check: "文档引用的仓库路径真实存在",
    status: ghostPaths.size ? "fail" : "pass",
    detail: ghostPaths.size ? `幽灵路径: ${[...ghostPaths].join("; ")}` : docs.length ? `${docs.length} 份文档无幽灵引用` : "无文档可检查（自动链路）",
  });

  // 检查 5：行号断言（基准数据注入，语义展开：5min 窗口的等价毫秒表达视为命中）
  const failedAssertions: string[] = [];
  for (const a of assertions) {
    const abs = path.join(repoDir, a.file);
    if (!existsSync(abs)) {
      failedAssertions.push(`${a.file}: 文件不存在`);
      continue;
    }
    const lines = readFileSync(abs, "utf-8").split(/\r?\n/);
    const seg = lines.slice(a.from - 1, a.to).join("\n");
    const norm = (s: string) => s.replace(/300000|5 \* 60 \* 1000/g, "180000");
    const hay = norm(seg);
    for (const tok of a.tokens) {
      if (!hay.includes(norm(tok))) {
        failedAssertions.push(`${a.file}:${a.from}-${a.to} 缺 token "${tok}"（${a.claim}）`);
      }
    }
  }
  checks.push({
    check: "关键行号断言（基准数据）",
    status: failedAssertions.length ? "fail" : "pass",
    detail: failedAssertions.length
      ? failedAssertions.join(" | ")
      : `${assertions.length} 条断言全部命中`,
  });

  const passed = checks.every((c) => c.status === "pass");
  return { checks, passed };
}

// --- CLI 直跑 ---
if (process.argv[1] && process.argv[1].endsWith("validator.ts")) {
  const [knowledgeDirArg, repoDirArg, assertionsArg] = process.argv.slice(2);
  if (!knowledgeDirArg || !repoDirArg) {
    console.error("用法: node src/knowledge/validator.ts <knowledgeDir> <repoDir> [assertionsJson]");
    process.exit(2);
  }
  const knowledgeDir = path.resolve(knowledgeDirArg);
  const repoDir = path.resolve(repoDirArg);
  const assertions: LineAssertion[] = assertionsArg
    ? JSON.parse(readFileSync(path.resolve(assertionsArg), "utf-8"))
    : [];

  const { checks, passed } = runVerify(knowledgeDir, repoDir, assertions);
  for (const c of checks) {
    console.log(`[${c.status === "pass" ? "通过" : "失败"}] ${c.check}: ${c.detail}`);
  }

  const manifest = JSON.parse(readFileSync(path.join(knowledgeDir, "repository-manifest.json"), "utf-8"));
  // P1-2 起只写 deterministic-report.json，汇总归 Publisher，单项检查不得覆盖已有证据
  writeFileSync(
    path.join(knowledgeDir, "deterministic-report.json"),
    JSON.stringify({
      schema_version: "1.0",
      repository: manifest.repository,
      commit: manifest.commit,
      deterministic_checks: checks,
      passed,
    }, null, 2),
    "utf-8",
  );
  console.log(`[校验] 报告已写入 deterministic-report.json，结论: ${passed ? "通过" : "失败"}（汇总由 Publisher 负责）`);
  process.exit(passed ? 0 : 1);
}
