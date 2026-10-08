/**
 * builder.ts —— Capability Registry 构建（P1-5a）
 *
 * 目标（评审定义）：跨仓库统一能力分类——用户提需求时不需要先知道仓库名。
 * 「我要实现支持并发限制、任务优先级和暂停恢复的调度器」→ 命中 p-queue 模块。
 *
 * 构建流程：
 *
 * buildCatalog(knowledgeRoot)
 *     ├─> 扫描 knowledge/<repo>/<topic>/module-analysis.json
 *     ├─> 每模块：facts/summary/flows 文本 × 能力词典 → 命中能力类
 *     ├─> 每能力条目：{id, keywords, modules: [{repo, module_id, commit, doc, evidence}]}
 *     └─> 输出 catalog.json（确定性：模块按字典序，证据按行号序）
 *
 * 检索层为确定性关键词匹配（评审建议：先最小索引+确定性检索，不引入向量库）。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ModuleAnalysis } from "../generate/analysis-contract.ts";

/** 能力词典：能力 ID -> 识别关键词（中英） */
export const CAPABILITY_DICT: Record<string, string[]> = {
  "concurrency-limit": ["并发", "concurren", "同时执行"],
  "priority-scheduling": ["优先", "priority"],
  "timeout-handling": ["超时", "timeout", "pTimeout"],
  "pause-resume": ["暂停", "pause", "恢复", "resume"],
  "rate-limiting": ["速率", "rate limit", "rateLimit", "interval"],
  "process-isolation": ["进程隔离", "独立服务进程", "utilityProcess", "utility process", "子进程托管"],
  "crash-recovery": ["崩溃", "退避", "backoff", "重启", "supervisor", "监护"],
  "ipc-bridge": ["桥接", "bridge", "IPC", "消息协议", "call.*ret"],
  "native-window": ["窗口", "BrowserWindow", "托盘", "tray", "快捷键"],
  "packaging": ["打包", "asar", "安装包", "electron-builder", "签名"],
  "event-system": ["事件", "EventEmitter", "emit", "监听器"],
  "abort-cancellation": ["中止", "abort", "AbortSignal", "取消"],
};

export interface CapabilityEntry {
  id: string;
  keywords: string[];
  modules: Array<{
    repo: string;
    topic: string;
    module_id: string;
    commit: string;
    doc: string;
    matched_keywords: string[];
    evidence: Array<{ statement: string; file: string; line?: number }>;
  }>;
}

export interface Catalog {
  schema_version: "1.0";
  capabilities: CapabilityEntry[];
}

function evidenceLines(a: ModuleAnalysis, keywordRe: RegExp): CapabilityEntry["modules"][0]["evidence"] {
  const hits: CapabilityEntry["modules"][0]["evidence"] = [];
  for (const f of a.facts ?? []) {
    if (keywordRe.test(f.statement) && f.evidence?.[0]) {
      hits.push({ statement: f.statement.slice(0, 100), file: f.evidence[0].file, line: f.evidence[0].lines?.[0] });
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

/** 从单个模块分析提取命中能力 */
export function extractCapabilities(a: ModuleAnalysis, meta: { repo: string; topic: string; doc: string }): Array<{ id: string; matched: string[]; evidence: CapabilityEntry["modules"][0]["evidence"] }> {
  const text = [
    a.summary ?? "",
    ...(a.facts ?? []).map((f) => f.statement),
    ...(a.execution_flows ?? []).map((f) => f.name),
    ...(a.inferences ?? []).map((i) => i.statement),
  ].join("\n");

  const out = [];
  for (const [id, kws] of Object.entries(CAPABILITY_DICT)) {
    const matched = kws.filter((k) => text.includes(k) || new RegExp(k, "i").test(text));
    if (!matched.length) continue;
    const kwRe = new RegExp(kws.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
    out.push({ id, matched, evidence: evidenceLines(a, kwRe) });
  }
  return out;
}

/** 扫描 knowledge 目录构建能力索引 */
export function buildCatalog(knowledgeRoot: string): Catalog {
  const byCap = new Map<string, CapabilityEntry>();

  for (const repo of readdirSync(knowledgeRoot)) {
    const repoDir = path.join(knowledgeRoot, repo);
    if (!existsSync(path.join(repoDir, ".git")) && !readdirSync(repoDir).every(() => true)) { /* 继续 */ }
    for (const topic of readdirSync(repoDir)) {
      const maPath = path.join(repoDir, topic, "module-analysis.json");
      if (!existsSync(maPath)) continue;
      const ma = JSON.parse(readFileSync(maPath, "utf-8"));
      for (const a of ma.analyses ?? []) {
        const caps = extractCapabilities(a, { repo, topic, doc: `${repo}/${topic}` });
        for (const c of caps) {
          if (!byCap.has(c.id)) {
            byCap.set(c.id, { id: c.id, keywords: CAPABILITY_DICT[c.id], modules: [] });
          }
          byCap.get(c.id)!.modules.push({
            repo,
            topic,
            module_id: a.module_id,
            commit: ma.commit,
            doc: `knowledge/${repo}/${topic}/generated/modules/${a.module_id.replace(/^[\w]+\./, "").replace(/[^\w-]/g, "-")}.md`,
            matched_keywords: c.matched,
            evidence: c.evidence,
          });
        }
      }
    }
  }

  const capabilities = [...byCap.values()]
    .sort((x, y) => (x.id < y.id ? -1 : 1))
    .map((c) => ({ ...c, modules: c.modules.sort((m, n) => m.repo.localeCompare(n.repo) || m.module_id.localeCompare(n.module_id)) }));

  return { schema_version: "1.0", capabilities };
}

export function writeCatalog(knowledgeRoot: string, catalog: Catalog): string {
  const p = path.join(knowledgeRoot, "catalog.json");
  writeFileSync(p, JSON.stringify(catalog, null, 2), "utf-8");
  return p;
}
