/**
 * builder.ts —— Reference Context Builder（P2-1，评审第一核心交付）
 *
 * 目标链路（评审定义）：
 *   需求输入 -> Capability Search -> Trusted Knowledge 筛选
 *            -> Reference Context（最小源码参考包）-> Coding Agent -> Check & Verify
 *
 * 构建流程：
 *
 * buildReferenceContext(query, knowledgeRoot, {trustedOnly})
 *     ├─> searchCapabilities 命中能力（trustedOnly 默认 true：只取已审查且有实证的模块）
 *     ├─> 逐模块加载 module-analysis + repository-manifest
 *     └─> 每模块输出最小参考包：
 *           facts（全部已验证事实）/ interfaces / dependencies
 *           source_files（供 Agent 按需读取）/ test_files / license / reuse_guidance
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Catalog } from "../catalog/builder.ts";
import { searchCapabilities } from "../catalog/search.ts";
import type { ModuleAnalysis } from "../generate/analysis-contract.ts";
import { buildClaimsForReview, claimsHash, verdictMapFromReview } from "../review/claims.ts";

export interface ReferenceModule {
  repo: string;
  commit: string;
  module_id: string;
  doc_path: string;
  license: string | null;
  license_note: string | null;
  review_status: string;
  capability: string;
  summary: string;
  facts: ModuleAnalysis["facts"];
  interfaces: ModuleAnalysis["interfaces"];
  dependencies: ModuleAnalysis["dependencies"];
  source_files: string[];
  test_files: string[];
  reuse_guidance: ModuleAnalysis["reuse_guidance"];
  open_questions: string[];
}

export interface ReferenceContext {
  schema_version: "1.0";
  requirement: string;
  generated_note: string;
  capabilities_hit: Array<{ capability: string; matched_query_terms: string[] }>;
  references: ReferenceModule[];
}

function isTestFile(p: string): boolean {
  return /(^|\/)(test|tests|test-d|__tests__)(\/|$)/.test(p) || /\.(test|spec)\.[cm]?[jt]s$/.test(p);
}

/** 从知识库提取与需求匹配的最小参考上下文 */
export function buildReferenceContext(
  query: string,
  catalog: Catalog,
  knowledgeRoot: string,
  opts: { trustedOnly?: boolean; maxModules?: number } = {},
): ReferenceContext {
  const trustedOnly = opts.trustedOnly ?? true;
  const maxModules = opts.maxModules ?? 3;

  const hits = searchCapabilities(catalog, query, { trustedOnly });
  const capabilitiesHit = hits.slice(0, 5).map((h) => ({
    capability: h.capability,
    matched_query_terms: h.matched_query_terms,
  }));

  // 依得分取模块（去重：同一模块命中多能力只保留一次，记最高分能力）
  const seen = new Map<string, { repo: string; topic: string; module_id: string; capability: string }>();
  for (const h of hits) {
    for (const m of h.modules) {
      const key = `${m.repo}/${m.module_id}`;
      if (!seen.has(key)) {
        seen.set(key, { repo: m.repo, topic: m.topic, module_id: m.module_id, capability: h.capability });
      }
    }
  }

  const references: ReferenceModule[] = [];
  for (const { repo, topic, module_id, capability } of [...seen.values()].slice(0, maxModules)) {
    const topicDir = path.join(knowledgeRoot, repo, topic);
    const maPath = path.join(topicDir, "module-analysis.json");
    const manifestPath = path.join(topicDir, "repository-manifest.json");
    if (!existsSync(maPath)) continue;
    const ma = JSON.parse(readFileSync(maPath, "utf-8"));
    const a = (ma.analyses ?? []).find((x: any) => x.module_id === module_id);
    if (!a) continue;

    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : null;
    const reviewPath = path.join(topicDir, "review-report.json");
    let reviewStatus = "unreviewed";
    let verdictMap = new Map<string, string>();
    if (existsSync(reviewPath)) {
      try {
        const rr = JSON.parse(readFileSync(reviewPath, "utf-8"));
        const entry = (rr.llm ?? []).find((r: any) => r.module_id === module_id);
        // 时效校验：commit 一致 + 送审内容 hash 一致，旧报告不误用
        const commitOk = !rr.commit || rr.commit === ma.commit;
        const hashOk = !entry?.claims_hash || entry.claims_hash === claimsHash(buildClaimsForReview(a));
        if (entry && commitOk && hashOk && (entry.review_status === "reviewed" || entry.verdicts?.length)) {
          reviewStatus = "reviewed";
          verdictMap = verdictMapFromReview(entry);
        }
      } catch { /* 保持 unreviewed */ }
    }

    // claim 级可信（评审表格）：supported 允许；unsupported 禁止；unverifiable 保留标注；未送审默认过滤（trusted 模式）
    const annotateFacts = (facts: any[]) =>
      facts
        .filter((f) => verdictMap.get(f.statement) !== "unsupported")
        .map((f) => ({ ...f, claim_status: verdictMap.get(f.statement) ?? "unreviewed-claim" }));

    const allFiles = [...new Set([...(a.read_files ?? []), ...(a.source_files ?? [])])];
    references.push({
      repo,
      commit: ma.commit,
      module_id,
      doc_path: `knowledge/${repo}/${topic}/generated/modules/${module_id.replace(/^[\w]+\./, "").replace(/[^\w-]/g, "-")}.md`,
      license: manifest?.license?.spdx ?? null,
      license_note: manifest?.license?.spdx?.includes("Noncommercial")
        ? "非商用许可证：设计模式可参考，代码不可直接用于商用项目"
        : null,
      review_status: reviewStatus,
      capability,
      summary: a.summary ?? "",
      facts: trustedOnly
        ? annotateFacts(a.facts ?? []).filter((f: any) => f.claim_status !== "unreviewed-claim")
        : annotateFacts(a.facts ?? []),
      interfaces: a.interfaces ?? [],
      dependencies: a.dependencies ?? { internal_files: [], external_packages: [] },
      source_files: allFiles.filter((f) => !isTestFile(f)),
      test_files: allFiles.filter(isTestFile),
      reuse_guidance: a.reuse_guidance ?? { portable: [], adapt: [], risks: [] },
      open_questions: a.open_questions ?? [],
    });
  }

  return {
    schema_version: "1.0",
    requirement: query,
    generated_note: trustedOnly
      ? "仅包含已通过语义审查且有源码实证的模块；未审查内容已被过滤"
      : "包含未审查内容（--no-trusted 模式），使用前请自行核验",
    capabilities_hit: capabilitiesHit,
    references,
  };
}

/** 渲染人类可读的参考上下文摘要（供 Coding Agent 或开发者直接阅读） */
export function renderReferenceMarkdown(ctx: ReferenceContext): string {
  const lines: string[] = [];
  lines.push(`# 参考实现上下文：${ctx.requirement}`);
  lines.push("");
  lines.push(`> ${ctx.generated_note}`);
  lines.push("");
  lines.push(`命中能力：${ctx.capabilities_hit.map((c) => `${c.capability}（${c.matched_query_terms.join("、")}）`).join("、") || "无"}`);
  lines.push("");
  for (const r of ctx.references) {
    lines.push(`## ${r.repo}/${r.module_id} @ ${r.commit.slice(0, 10)} [${r.review_status}]`);
    lines.push(`- 能力：${r.capability} | 许可证：${r.license ?? "未知"}${r.license_note ? `（${r.license_note}）` : ""}`);
    lines.push(`- 文档：${r.doc_path}`);
    lines.push(`- 摘要：${r.summary}`);
    if (r.facts.length) {
      lines.push("- 已验证事实：");
      for (const f of r.facts.slice(0, 8)) {
        const ev = f.evidence?.[0];
        lines.push(`  - ${f.statement}（${ev?.file}${ev?.lines?.[0] ? `:${ev.lines[0]}` : ""}）`);
      }
    }
    if (r.interfaces.length) {
      lines.push(`- 接口：${r.interfaces.slice(0, 6).map((i) => `${i.symbol}(${i.kind})`).join("、")}`);
    }
    lines.push(`- 依赖：内部 ${r.dependencies.internal_files.length} 文件；外部 ${r.dependencies.external_packages.join("、") || "无"}`);
    lines.push(`- 源码清单（供按需读取）：${r.source_files.slice(0, 6).join("、")}${r.source_files.length > 6 ? "..." : ""}`);
    if (r.test_files.length) lines.push(`- 测试：${r.test_files.slice(0, 4).join("、")}`);
    if (r.reuse_guidance.portable.length || r.reuse_guidance.risks.length) {
      lines.push(`- 复用提示：可移植 ${r.reuse_guidance.portable.length} 项 / 风险 ${r.reuse_guidance.risks.length} 项（详见模块文档第 10 节）`);
    }
    if (r.open_questions.length) lines.push(`- 未确认事项：${r.open_questions.slice(0, 2).join("；")}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function writeReferenceContext(outDir: string, ctx: ReferenceContext): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const json = path.join(outDir, "reference-context.json");
  const md = path.join(outDir, "reference-context.md");
  writeFileSync(json, JSON.stringify(ctx, null, 2), "utf-8");
  writeFileSync(md, renderReferenceMarkdown(ctx), "utf-8");
  return { json, md };
}
