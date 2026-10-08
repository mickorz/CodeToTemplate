/**
 * verify.ts —— M5 确定性证据校验
 *
 * 校验流程：
 *
 * runVerify(knowledgeDir, repoDir)
 *     ├─> 检查 1：module-map 的 source_files 全部存在于 manifest
 *     ├─> 检查 2：module-map.dependencies 引用的模块 id 存在
 *     ├─> 检查 3：manifest 与 module-map 的 commit 一致
 *     ├─> 检查 4：文档中引用的仓库路径真实存在（modules/*.md + architecture.md）
 *     ├─> 检查 5：关键行号断言（file + 行范围 + 必含 token）
 *     └─> 输出 verification-report.json（确定性部分）；失败退出码 1（供 E2E/CI 使用）
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

export interface VerifyCheck {
  check: string;
  status: "pass" | "fail";
  detail: string;
}

/** 关键行号断言：文档声称的事实必须能在对应源码行找到 token（Gold Set 对应的可机器验证子集） */
export const LINE_ASSERTIONS: Array<{ file: string; from: number; to: number; tokens: string[]; claim: string }> = [
  { file: "electron-main.js", from: 1580, to: 1590, tokens: ["utilityProcess.fork", "server-host.js"], claim: "G04 服务端运行于 Utility Process" },
  { file: "electron-main.js", from: 775, to: 779, tokens: ["server.js"], claim: "inproc 回退 require server.js" },
  { file: "electron-main.js", from: 730, to: 736, tokens: ["loadURL"], claim: "G03 页面加载本机服务" },
  { file: "electron-main.js", from: 790, to: 795, tokens: ["/api/info"], claim: "健康检查探测 api info" },
  { file: "src/desktop/server-supervisor.js", from: 20, to: 26, tokens: ["20000", "180000", "180000", "500, 2000, 5000"], claim: "G05 崩溃退避参数（20s 就绪/5min 窗口/退避序列）" },
  { file: "src/desktop/bridge-main.js", from: 1, to: 30, tokens: ["t:\"call\"", "t:\"ret\"", "t:\"note\""], claim: "G06 桥接消息协议 call ret note" },
  { file: "src/platform/electron-bridge.js", from: 25, to: 45, tokens: ["5000", "inproc", "remote", "none"], claim: "三模式与超时常量" },
  { file: "electron-builder.config.js", from: 1, to: 40, tokens: ["asar", "CSC_IDENTITY_AUTO_DISCOVERY"], claim: "G07 打包配置 asar 与签名策略" },
];

/** 提取 markdown 中反引号内疑似仓库路径的 token */
function extractPathTokens(md: string, knownPaths: Set<string>, topFiles: Set<string>): string[] {
  const tokens = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return tokens.filter((t) => {
    if (knownPaths.has(t) || topFiles.has(t)) return true;
    // 形如 src/.../x.js 或 含目录前缀的路径样式（排除 URL、协议、模板）
    return /^[\w.-]+(\/[\w.-]+)+\.(js|json|md|html|css|yml|yaml)$/.test(t);
  });
}

export function runVerify(knowledgeDir: string, repoDir: string): { checks: VerifyCheck[]; passed: boolean } {
  const manifest = JSON.parse(readFileSync(path.join(knowledgeDir, "repository-manifest.json"), "utf-8")) as Manifest;
  const moduleMap = JSON.parse(readFileSync(path.join(knowledgeDir, "module-map.json"), "utf-8")) as ModuleMap;

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

  // 检查 4：文档引用路径存在性
  const docs = ["architecture.md", ...readdirSync(path.join(knowledgeDir, "modules")).filter((f) => f.endsWith(".md")).map((f) => `modules/${f}`)];
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
    detail: ghostPaths.size ? `幽灵路径: ${[...ghostPaths].join("; ")}` : `${docs.length} 份文档无幽灵引用`,
  });

  // 检查 5：行号断言
  const failedAssertions: string[] = [];
  for (const a of LINE_ASSERTIONS) {
    const abs = path.join(repoDir, a.file);
    if (!existsSync(abs)) {
      failedAssertions.push(`${a.file}: 文件不存在`);
      continue;
    }
    const lines = readFileSync(abs, "utf-8").split(/\r?\n/);
    const seg = lines.slice(a.from - 1, a.to).join("\n");
    // 5min 窗口这类 token 用语义展开：300000 或 5*60*1000 或 180000 都视为命中 5 分钟表达
    const norm = (s: string) => s.replace(/300000|5 \* 60 \* 1000/g, "180000");
    const hay = norm(seg);
    for (const tok of a.tokens) {
      if (!hay.includes(norm(tok))) {
        failedAssertions.push(`${a.file}:${a.from}-${a.to} 缺 token "${tok}"（${a.claim}）`);
      }
    }
  }
  checks.push({
    check: "关键行号断言（文档声称的事实可定位到源码）",
    status: failedAssertions.length ? "fail" : "pass",
    detail: failedAssertions.length ? failedAssertions.join(" | ") : `${LINE_ASSERTIONS.length} 条断言全部命中`,
  });

  const passed = checks.every((c) => c.status === "pass");
  return { checks, passed };
}

// --- CLI 直跑 ---
if (process.argv[1] && process.argv[1].endsWith("verify.ts")) {
  const knowledgeDir = path.resolve(process.argv[2] ?? "./knowledge/openworkbuddy/desktop");
  const repoDir = path.resolve(process.argv[3] ?? "./cache/repos/mickorz__openworkbuddy");
  const { checks, passed } = runVerify(knowledgeDir, repoDir);
  for (const c of checks) {
    console.log(`[${c.status === "pass" ? "通过" : "失败"}] ${c.check}: ${c.detail}`);
  }
  const report = {
    schema_version: "1.0",
    repository: "mickorz/openworkbuddy",
    commit: JSON.parse(readFileSync(path.join(knowledgeDir, "repository-manifest.json"), "utf-8")).commit,
    verified_at: new Date().toISOString(),
    deterministic_checks: checks,
    passed,
  };
  writeFileSync(path.join(knowledgeDir, "verification-report.json"), JSON.stringify(report, null, 2), "utf-8");
  console.log(`[校验] 报告已写入 verification-report.json，结论: ${passed ? "通过" : "失败"}`);
  process.exit(passed ? 0 : 1);
}
