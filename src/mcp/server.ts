/**
 * server.ts —— CodeToTemplate MCP Server（P2-2，只读知识访问层）
 *
 * 评审定位：MCP 不重新实现发现/分析/审查/索引，只暴露四个只读工具：
 *
 *   search_capabilities     自然语言需求 -> 技术能力命中
 *   build_reference_context 需求 -> Coding Agent 最小参考包（默认可信过滤）
 *   get_module_analysis     模块结构、审查状态与关键结论
 *   read_source_reference   固定 Commit 校验的源码片段（git show，不读工作树/最新分支）
 *
 * 启动：node src/mcp/server.ts [knowledgeRoot]（默认 ./knowledge，repos 缓存在 ./cache/repos）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { searchCapabilities } from "../catalog/search.ts";
import type { Catalog } from "../catalog/builder.ts";
import { buildReferenceContext } from "../reference/builder.ts";

function readdirSafe(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

const knowledgeRoot = path.resolve(process.argv[2] ?? "./knowledge");
const reposRoot = path.resolve("./cache/repos");

function loadCatalogAt(knowledgeRoot: string): Catalog {
  const p = path.join(knowledgeRoot, "catalog.json");
  if (!existsSync(p)) throw new Error(`能力索引不存在: ${p}（先执行 npm run catalog）`);
  return JSON.parse(readFileSync(p, "utf-8")) as Catalog;
}

/** 固定 Commit 源码读取：git show <sha>:<path>，白名单 + 行数上限校验 */
function readSourceReference(knowledgeRoot: string, reposRoot: string, repo: string, commit: string, file: string, fromLine?: number, toLine?: number): { content: string; total_lines: number; note?: string } {
  // 1. 仓库定位：knowledge 下找该 repo 的 topic 目录与 manifest
  const repoDirInKnowledge = path.join(knowledgeRoot, repo);
  if (!existsSync(repoDirInKnowledge)) throw new Error(`未知仓库: ${repo}`);
  let manifest: any = null;
  let topicDir: string | null = null;
  for (const topic of existsSync(repoDirInKnowledge) ? readdirSafe(repoDirInKnowledge) : []) {
    const mp = path.join(repoDirInKnowledge, topic, "repository-manifest.json");
    if (existsSync(mp)) {
      const m = JSON.parse(readFileSync(mp, "utf-8"));
      if (m.commit === commit) { manifest = m; topicDir = path.join(repoDirInKnowledge, topic); break; }
      manifest ??= m; topicDir ??= path.join(repoDirInKnowledge, topic); // 记住首个（用于报错信息）
    }
  }
  if (!manifest) throw new Error(`仓库 ${repo} 无 manifest`);
  if (manifest.commit !== commit) {
    throw new Error(`commit 不匹配：知识库锁定 ${manifest.commit.slice(0, 10)}，请求 ${commit.slice(0, 10)}（拒绝读取未锁定版本）`);
  }
  // 2. 文件白名单
  if (!manifest.files.some((f: any) => f.path === file)) {
    throw new Error(`文件不在 manifest 白名单: ${file}`);
  }
  // 3. 行数上限（防止整仓拉取）
  const MAX_LINES = 400;
  const from = Math.max(1, fromLine ?? 1);
  const to = Math.min(from + MAX_LINES - 1, toLine ?? from + MAX_LINES - 1);

  const gitDir = path.join(reposRoot, repo.replace("/", "__"));
  let content: string;
  try {
    content = execFileSync("git", ["-C", gitDir, "show", `${commit}:${file}`], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`git show 读取失败（本地缓存可能无该 commit，先 collect 该仓库）: ${(e as Error).message.slice(0, 120)}`);
  }
  const lines = content.split(/\r?\n/);
  const seg = lines.slice(from - 1, to);
  return {
    content: seg.map((l, i) => `${from + i}\t${l}`).join("\n"),
    total_lines: lines.length,
    note: `固定 Commit ${commit.slice(0, 10)}，行 ${from}-${Math.min(to, lines.length)}（上限 ${MAX_LINES} 行/次）`,
  };
}

function readdirSafeUnused(): void { /* 占位防未用告警 */ }

export interface McpOptions { knowledgeRoot?: string; reposRoot?: string }

export function createMcpServer(options: McpOptions = {}): McpServer {
  const knowledgeRoot = path.resolve(options.knowledgeRoot ?? process.argv[2] ?? "./knowledge");
  const reposRoot = path.resolve(options.reposRoot ?? "./cache/repos");
  const server = new McpServer({ name: "codetotemplate", version: "0.2.0" });

  server.registerTool("search_capabilities", {
    description: "根据自然语言技术需求查找跨仓库技术能力（如：并发限制、崩溃恢复）。返回能力、匹配关键词与模块引用及审查状态。",
    inputSchema: { query: z.string().describe("技术需求描述，如：支持优先级和暂停恢复的任务调度"), trusted_only: z.boolean().optional().describe("默认 true：仅已审查且有实证条目") },
  }, async ({ query, trusted_only }) => {
    const hits = searchCapabilities(loadCatalogAt(knowledgeRoot), query, { trustedOnly: trusted_only ?? true });
    const text = hits.length
      ? hits.map((h) => `## ${h.capability}（匹配：${h.matched_query_terms.join("、")}）\n` + h.modules.map((m) =>
          `- [${m.review_status === "reviewed" ? "已审查" : "未审查"}] ${m.repo}/${m.module_id} @ ${m.commit.slice(0, 10)}\n  文档: ${m.doc}`).join("\n")).join("\n\n")
      : "无命中（可尝试 --no-trusted 或先 review 提升可信度）";
    return { content: [{ type: "text", text }] };
  });

  server.registerTool("build_reference_context", {
    description: "生成 Coding Agent 可用的最小参考实现上下文：可信模块的已验证事实（含源码行号）、接口、依赖、源码清单、测试与许可证。",
    inputSchema: { query: z.string().describe("要实现的功能需求"), no_trusted: z.boolean().optional().describe("默认 false：仅含已审查模块") },
  }, async ({ query, no_trusted }) => {
    const ctx = buildReferenceContext(query, loadCatalogAt(knowledgeRoot), knowledgeRoot, { trustedOnly: !(no_trusted ?? false) });
    if (!ctx.references.length) return { content: [{ type: "text", text: `无可信模块命中：${query}` }] };
    const text = ctx.references.map((r) =>
      `## ${r.repo}/${r.module_id} @ ${r.commit.slice(0, 10)} [${r.review_status}]\n` +
      `能力: ${r.capability} | 许可证: ${r.license}${r.license_note ? `（${r.license_note}）` : ""}\n` +
      `摘要: ${r.summary}\n` +
      r.facts.map((f: any) => {
        const ev = (f as any).evidence?.[0];
        return `- [${(f as any).claim_status ?? "-"}] ${f.statement}（${ev?.file}${ev?.lines?.[0] ? `:${ev.lines[0]}` : ""}）`;
      }).join("\n") +
      `\n依赖: 内部 ${r.dependencies.internal_files.join("、") || "无"}；外部 ${r.dependencies.external_packages.join("、") || "无"}` +
      `\n源码清单: ${r.source_files.join("、")}` +
      (r.test_files.length ? `\n测试: ${r.test_files.join("、")}` : "")
    ).join("\n\n");
    return { content: [{ type: "text", text: `需求：${query}\n${ctx.generated_note}\n\n${text}` }] };
  });

  server.registerTool("get_module_analysis", {
    description: "查询指定模块的结构化分析：审查状态、已验证事实、接口、依赖与未确认事项。",
    inputSchema: { repo: z.string(), module_id: z.string(), topic: z.string().optional() },
  }, async ({ repo, module_id, topic }) => {
    const base = path.join(knowledgeRoot, repo);
    for (const t of topic ? [topic] : readdirSafe(base)) {
      const maPath = path.join(base, t, "module-analysis.json");
      if (!existsSync(maPath)) continue;
      const ma = JSON.parse(readFileSync(maPath, "utf-8"));
      const a = (ma.analyses ?? []).find((x: any) => x.module_id === module_id);
      if (!a) continue;
      const rp = path.join(base, t, "review-report.json");
      const rr = existsSync(rp) ? JSON.parse(readFileSync(rp, "utf-8")) : null;
      const entry = rr?.llm?.find((r: any) => r.module_id === module_id);
      return { content: [{ type: "text", text: JSON.stringify({
        module_id, repo, commit: ma.commit, topic: t,
        review_status: entry?.review_status ?? "unreviewed",
        summary: a.summary, facts: a.facts, interfaces: a.interfaces,
        dependencies: a.dependencies, open_questions: a.open_questions,
      }, null, 2) }] };
    }
    throw new Error(`模块不存在: ${repo}/${module_id}`);
  });

  server.registerTool("read_source_reference", {
    description: "按固定 Commit 读取源码片段（与知识库锁定的版本一致，不读最新分支）。文件必须在 manifest 白名单内，单次上限 400 行。",
    inputSchema: {
      repo: z.string().describe("仓库名，如 p-queue"),
      commit: z.string().describe("知识库锁定的完整 Commit SHA"),
      file: z.string().describe("仓库内相对路径（须在 manifest 白名单）"),
      from_line: z.number().optional(),
      to_line: z.number().optional(),
    },
  }, async ({ repo, commit, file, from_line, to_line }) => {
    const r = readSourceReference(knowledgeRoot, reposRoot, repo, commit, file, from_line, to_line);
    return { content: [{ type: "text", text: `${r.note}\n\n${r.content}` }] };
  });

  return server;
}

// --- 直跑（stdio server）---
const isMain = process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error(`[mcp] CodeToTemplate MCP Server 已启动（knowledge: ${knowledgeRoot}）`);
}
