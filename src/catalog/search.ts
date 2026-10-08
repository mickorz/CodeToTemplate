/**
 * search.ts —— Capability 检索（P1-5b，确定性关键词匹配）
 *
 * 检索策略（评审：先确定性检索，不引入向量库）：
 *
 * searchCapabilities(catalog, query)
 *     ├─> query 与能力词典关键词匹配 -> 命中能力集合
 *     ├─> 每命中能力内：模块按 matched_keywords 数与证据量排序
 *     └─> 输出：能力 -> 模块引用（repo/module_id/文档路径/源码证据）
 */

import type { Catalog, CapabilityEntry } from "./builder.ts";
import { CAPABILITY_DICT } from "./builder.ts";

export interface SearchHit {
  capability: string;
  score: number;
  matched_query_terms: string[];
  modules: CapabilityEntry["modules"];
}

export function searchCapabilities(catalog: Catalog, query: string): SearchHit[] {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const cap of catalog.capabilities) {
    // 查询词与能力关键词的双向命中：query 含关键词 或 关键词出现在 query
    const matched = cap.keywords.filter((k) => {
      const kw = k.toLowerCase();
      return q.includes(kw) || new RegExp(kw, "i").test(query);
    });
    // 能力 ID 本身作为词（如查询含 concurrency）
    const idParts = cap.id.split("-").filter((p) => p.length > 3 && q.includes(p));
    if (!matched.length && !idParts.length) continue;

    // 模块排序：证据量优先
    const modules = [...cap.modules].sort((a, b) => b.evidence.length - a.evidence.length);
    hits.push({
      capability: cap.id,
      score: matched.length + idParts.length * 0.5,
      matched_query_terms: [...matched, ...idParts],
      modules,
    });
  }

  return hits.sort((a, b) => b.score - a.score || b.modules.length - a.modules.length);
}

/** 格式化为人类可读检索结果 */
export function formatHits(hits: SearchHit[], limit = 5): string {
  const lines: string[] = [];
  for (const h of hits.slice(0, limit)) {
    lines.push(`## ${h.capability}（匹配: ${h.matched_query_terms.join("、")}）`);
    for (const m of h.modules.slice(0, 3)) {
      lines.push(`- ${m.repo}/${m.module_id} @ ${m.commit.slice(0, 10)}`);
      lines.push(`  文档: ${m.doc}`);
      for (const e of m.evidence.slice(0, 2)) {
        lines.push(`  证据: ${e.statement}（${e.file}${e.line ? `:${e.line}` : ""}）`);
      }
    }
    lines.push("");
  }
  return lines.join("\n") || "（无命中能力）";
}
