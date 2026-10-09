/**
 * server.ts —— CodeToTemplate MCP Server（P3-0a/b：全工具审计 + run_id + 三种消费模式）
 *
 * 只读知识访问层，四个工具：
 *   search_capabilities / build_reference_context / get_module_analysis / read_source_reference
 *
 * P3-0a 新增：
 *   - audit() 覆盖全部四工具（含延迟、返回数据量、Commit、源码范围）
 *   - run_id 环境变量支持（CTT_RUN_ID），区分不同实验组
 *   - 预检命令（CTT_PRECHECK=1）验证固定 Commit 可读性
 *
 * P3-0b 新增：
 *   - CTT_CONSUMPTION_MODE 控制三种消费模式：
 *     facts-only（默认）/ facts-with-snippets（附关键源码行段原文）/ evidence-required（要求 Agent 必须核对证据）
 *
 * 启动：node src/mcp/server.ts [knowledgeRoot]
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { searchCapabilities } from "../catalog/search.ts";
import type { Catalog } from "../catalog/builder.ts";
import { buildReferenceContext } from "../reference/builder.ts";

function readdirSafe(p: string): string[] {
  try { return readdirSync(p); } catch { return []; } }

const RUN_ID = process.env.CTT_RUN_ID ?? "";
const AUDIT_PATH = process.env.CTT_AUDIT_PATH ?? "mcp-audit.jsonl";

function audit(tool: string, ok: boolean, detail: Record<string, unknown>, startedAt: number): void {
  try {
    const dir = path.dirname(path.resolve(AUDIT_PATH));
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.resolve(AUDIT_PATH), JSON.stringify({
      at: new Date().toISOString(),
      run_id: RUN_ID || null,
      tool, ok,
      duration_ms: Date.now() - startedAt,
      ...detail,
    }) + "\n", "utf-8");
  } catch { /* 审计不阻断 */ }
}

export interface McpOptions {
  knowledgeRoot?: string;
  reposRoot?: string;
  consumptionMode?: "facts-only" | "facts-with-snippets" | "evidence-required";
}

function loadCatalogAt(kr: string): Catalog {
  const p = path.join(kr, "catalog.json");
  if (!existsSync(p)) throw new Error("能力索引不存在: " + p);
  return JSON.parse(readFileSync(p, "utf-8")) as Catalog;
}

function readSourceReference(kr: string, rr: string, repo: string, commit: string, file: string, fromLine?: number, toLine?: number) {
  if (!/^[\w./-]+$/.test(repo) || repo.includes("..")) throw new Error("非法仓库路径: " + repo);
  const repoDir = path.join(kr, repo);
  if (!existsSync(repoDir)) throw new Error("未知仓库: " + repo);
  let manifest: any = null;
  for (const topic of readdirSafe(repoDir)) {
    const mp = path.join(repoDir, topic, "repository-manifest.json");
    if (existsSync(mp)) {
      const m = JSON.parse(readFileSync(mp, "utf-8"));
      if (m.commit === commit) { manifest = m; break; }
      manifest ??= m;
    }
  }
  if (!manifest) throw new Error("仓库 " + repo + " 无 manifest");
  if (manifest.commit !== commit) throw new Error("commit 不匹配: 库锁 " + manifest.commit.slice(0,10) + " 请求 " + commit.slice(0,10));
  if (!manifest.files.some((f: any) => f.path === file)) throw new Error("文件不在白名单: " + file);
  const MAX_LINES = 400;
  const from = Math.max(1, fromLine ?? 1);
  const to = Math.min(from + MAX_LINES - 1, toLine ?? from + MAX_LINES - 1);
  const gitDir = path.join(rr, (manifest.repository ?? repo).replace("/", "__"));
  let content: string;
  try {
    content = execFileSync("git", ["-C", gitDir, "show", commit + ":" + file], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    throw new Error("git show 读取失败: " + String((e as Error).message).slice(0, 120));
  }
  const lines = content.split(/\r?\n/);
  const seg = lines.slice(from - 1, to);
  return {
    content: seg.map((l, i) => (from + i) + "\t" + l).join("\n"),
    total_lines: lines.length,
    note: "固定 Commit " + commit.slice(0, 10) + "，行 " + from + "-" + Math.min(to, lines.length),
  };
}

function collectSnippets(kr: string, rr: string, ctx: any): string[] {
  const snippets: string[] = [];
  for (const ref of ctx.references) {
    for (const fact of ref.facts ?? []) {
      const ev = fact.evidence?.[0];
      if (!ev?.file || !ev?.lines) continue;
      const from = Math.max(1, ev.lines[0] - 5);
      const to = Math.min((ev.lines[1] ?? ev.lines[0]) + 5, from + 40);
      try {
        const r = readSourceReference(kr, rr, ref.repo, ref.commit, ev.file, from, to);
        snippets.push("### " + ref.repo + "/" + ev.file + ":" + from + "-" + to + "\n" + r.content);
      } catch { /* skip */ }
      if (snippets.length >= 10) return snippets;
    }
  }
  return snippets;
}

export function createMcpServer(options: McpOptions = {}): McpServer {
  const kr = path.resolve(options.knowledgeRoot ?? process.argv[2] ?? "./knowledge");
  const rr = path.resolve(options.reposRoot ?? "./cache/repos");
  const mode = options.consumptionMode ?? process.env.CTT_CONSUMPTION_MODE ?? "facts-only";
  const server = new McpServer({ name: "codetotemplate", version: "0.3.0" });

  server.registerTool("search_capabilities", {
    description: "根据自然语言技术需求查找跨仓库技术能力。",
    inputSchema: { query: z.string(), trusted_only: z.boolean().optional() },
  }, async ({ query, trusted_only }) => {
    const t0 = Date.now();
    try {
      const hits = searchCapabilities(loadCatalogAt(kr), query, { trustedOnly: trusted_only ?? true });
      const text = hits.length
        ? hits.map((h) => "## " + h.capability + "\n" + h.modules.map((m) =>
            "- [" + (m.review_status === "reviewed" ? "已审查" : "未审查") + "] " + m.repo + "/" + m.module_id + " @ " + m.commit.slice(0,10) + "\n  文档: " + m.doc).join("\n")).join("\n\n")
        : "无命中";
      audit("search_capabilities", true, { query, hits: hits.length, bytes: text.length }, t0);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      audit("search_capabilities", false, { query, error: String((e as Error).message).slice(0, 120) }, t0);
      throw e;
    }
  });

  server.registerTool("build_reference_context", {
    description: "生成 Coding Agent 可用的最小参考实现上下文。消费模式: facts-only / facts-with-snippets / evidence-required。",
    inputSchema: { query: z.string(), no_trusted: z.boolean().optional() },
  }, async ({ query, no_trusted }) => {
    const t0 = Date.now();
    try {
      const ctx = buildReferenceContext(query, loadCatalogAt(kr), kr, { trustedOnly: !(no_trusted ?? false) });
      const refs = ctx.references.length;
      if (!refs) {
        audit("build_reference_context", true, { query, references: 0, mode }, t0);
        return { content: [{ type: "text", text: "无可信模块命中: " + query }] };
      }
      const snippets = mode === "facts-with-snippets" ? collectSnippets(kr, rr, ctx) : [];
      const evidencePrompt = mode === "evidence-required"
        ? "\n\n## 证据核对要求（evidence-required 模式）\n以上 facts 为结构化摘要。实现关键行为前，必须使用 read_source_reference 工具读取对应源码行段（按 facts 中标注的 file:line），确认语义与摘要一致后再实现。禁止仅凭摘要实现协议边界行为。"
        : "";
      const snippetBlock = snippets.length
        ? "\n\n## 关键源码行段（固定 Commit，直接提供）\n" + snippets.join("\n\n")
        : "";
      const text = ctx.references.map((r) =>
        "## " + r.repo + "/" + r.module_id + " @ " + r.commit.slice(0,10) + " [" + r.review_status + "]\n" +
        "能力: " + r.capability + " | 许可证: " + r.license + "\n" +
        "摘要: " + r.summary + "\n" +
        r.facts.map((f: any) => {
          const ev = (f as any).evidence?.[0];
          return "- [" + ((f as any).claim_status ?? "-") + "] " + f.statement + "（" + (ev?.file ?? "") + (ev?.lines?.[0] ? ":" + ev.lines[0] : "") + "）";
        }).join("\n") +
        "\n依赖: 内部 " + (r.dependencies.internal_files.join("、") || "无") + "；外部 " + (r.dependencies.external_packages.join("、") || "无") +
        "\n源码清单: " + r.source_files.join("、") +
        (r.test_files.length ? "\n测试: " + r.test_files.join("、") : "")
      ).join("\n\n");
      audit("build_reference_context", true, { query, references: refs, mode, snippets: snippets.length, bytes: text.length + snippetBlock.length }, t0);
      return { content: [{ type: "text", text: "需求: " + query + "\n" + ctx.generated_note + "\n\n" + text + snippetBlock + evidencePrompt }] };
    } catch (e) {
      audit("build_reference_context", false, { query, mode, error: String((e as Error).message).slice(0, 120) }, t0);
      throw e;
    }
  });

  server.registerTool("get_module_analysis", {
    description: "查询指定模块的结构化分析：审查状态、已验证事实（逐条附 Reviewer verdict）、接口、依赖与未确认事项。",
    inputSchema: {
      repo: z.string().regex(/^[\w.-]+(\/|[\w.-])*$/),
      module_id: z.string().regex(/^[\w.-]+$/),
      topic: z.string().regex(/^[\w.-]+$/).optional(),
    },
  }, async ({ repo, module_id, topic }) => {
    const t0 = Date.now();
    const safeRepo = path.basename(repo);
    const base = path.resolve(kr, safeRepo);
    if (!base.startsWith(path.resolve(kr) + path.sep)) throw new Error("非法仓库路径: " + repo);
    for (const t of topic ? [path.basename(topic)] : readdirSafe(base)) {
      const maPath = path.join(base, t, "module-analysis.json");
      if (!existsSync(maPath)) continue;
      const ma = JSON.parse(readFileSync(maPath, "utf-8"));
      const a = (ma.analyses ?? []).find((x: any) => x.module_id === module_id);
      if (!a) continue;
      const rp = path.join(base, t, "review-report.json");
      const rr2 = existsSync(rp) ? JSON.parse(readFileSync(rp, "utf-8")) : null;
      const entry = rr2?.llm?.find((r: any) => r.module_id === module_id);
      const verdictOf = (s: string) => entry?.verdicts?.find((v: any) => v.statement === s)?.verdict;
      const factsAnnotated = (a.facts ?? []).map((f: any) => ({ ...f, reviewer_verdict: verdictOf(f.statement) ?? "not-reviewed" }));
      const result = JSON.stringify({
        module_id, repo, commit: ma.commit, topic: t,
        review_status: entry?.review_status ?? "unreviewed",
        review_passed: rr2?.passed ?? null,
        summary: a.summary, facts: factsAnnotated, interfaces: a.interfaces,
        dependencies: a.dependencies, open_questions: a.open_questions,
      }, null, 2);
      audit("get_module_analysis", true, { repo, module_id, facts: factsAnnotated.length, bytes: result.length }, t0);
      return { content: [{ type: "text", text: result }] };
    }
    audit("get_module_analysis", false, { repo, module_id, error: "模块不存在" }, t0);
    throw new Error("模块不存在: " + repo + "/" + module_id);
  });

  server.registerTool("read_source_reference", {
    description: "按固定 Commit 读取源码片段。文件必须在 manifest 白名单内，单次上限 400 行。",
    inputSchema: {
      repo: z.string(),
      commit: z.string(),
      file: z.string(),
      from_line: z.number().optional(),
      to_line: z.number().optional(),
    },
  }, async ({ repo, commit, file, from_line, to_line }) => {
    const t0 = Date.now();
    try {
      const r = readSourceReference(kr, rr, repo, commit, file, from_line, to_line);
      audit("read_source_reference", true, {
        repo, commit: commit.slice(0,10), file,
        range: [from_line ?? 1, to_line ?? (from_line ?? 1) + 399],
        total_lines: r.total_lines, bytes: r.content.length,
      }, t0);
      return { content: [{ type: "text", text: r.note + "\n\n" + r.content }] };
    } catch (e) {
      audit("read_source_reference", false, { repo, commit: commit.slice(0,10), file, error: String((e as Error).message).slice(0,120) }, t0);
      throw e;
    }
  });

  return server;
}

// --- 预检模式（CTT_PRECHECK=1）---
const isMain = process.argv[1]?.endsWith("server.ts");
if (isMain && process.env.CTT_PRECHECK === "1") {
  const kr = path.resolve(process.argv[2] ?? "./knowledge");
  const rr2 = path.resolve("./cache/repos");
  console.log("[预检] 知识库根: " + kr);
  let pass = 0, fail = 0;
  for (const repo of readdirSafe(kr)) {
    for (const topic of readdirSafe(path.join(kr, repo))) {
      const mp = path.join(kr, repo, topic, "repository-manifest.json");
      if (!existsSync(mp)) continue;
      const manifest = JSON.parse(readFileSync(mp, "utf-8"));
      const gitDir = path.join(rr2, (manifest.repository ?? repo).replace("/", "__"));
      for (const f of manifest.files.slice(0, 10)) {
        try {
          execFileSync("git", ["-C", gitDir, "show", manifest.commit + ":" + f.path], { encoding: "utf-8", maxBuffer: 1024*1024, stdio: "pipe" });
          pass++;
        } catch {
          console.error("[预检失败] " + repo + "/" + f.path + " @ " + manifest.commit.slice(0,10) + " 不可读");
          fail++;
        }
      }
    }
  }
  console.log("[预检] 可读 " + pass + "，不可读 " + fail);
  process.exit(fail > 0 ? 1 : 0);
}

// --- 直跑（stdio server）---
if (isMain) {
  process.env.CTT_KNOWLEDGE_ROOT = process.env.CTT_KNOWLEDGE_ROOT ?? process.argv[2] ?? "./knowledge";
  const server = createMcpServer({
    knowledgeRoot: process.env.CTT_KNOWLEDGE_ROOT,
    reposRoot: process.env.CTT_REPOS_ROOT ?? "./cache/repos",
  });
  await server.connect(new StdioServerTransport());
  console.error("[mcp] MCP Server v0.3.0（run_id: " + (RUN_ID || "none") + "，mode: " + (process.env.CTT_CONSUMPTION_MODE ?? "facts-only") + "）");
}
