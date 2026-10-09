/**
 * cache.ts —— 模块级缓存与执行日志（P0-1，评审：Cache/Journal/Artifact 三分离）
 *
 * - Cache：只保存通过契约验证的 module-analysis（单模块文件，原子写入）
 * - Journal：模块执行状态与性能指标（pending/running/completed/failed/interrupted + 耗时/调用数/缓存命中）
 *
 * Cache Key = sha256(repository + commit + module_id + source blob_sha 列表
 *                + agent 命令 + prompt_version + schema_version)
 * 评审要求：不能只以 Git Commit 为键——prompt 或 schema 更新也要触发重分析。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { PROMPT_VERSION, ANALYSIS_PROTOCOL } from "./normalize.ts";
import type { Manifest } from "../collector/manifest.ts";

export interface JournalEntry {
  module_id: string;
  status: "completed" | "failed" | "interrupted";
  cache_hit: boolean;
  llm_calls: number;
  duration_ms: number;
  input_bytes: number | null;
  input_tokens: number | null; // opencode 未提供则 null，不以字节数冒充
  output_tokens: number | null;
  retry_count: number;
  error?: string;
}

export function computeCacheKey(
  manifest: Manifest,
  mod: { id: string; source_files: string[] },
  agentCmd: string,
): string {
  const blobByPath = new Map(manifest.files.map((f) => [f.path, f.blob_sha]));
  const blobs = mod.source_files.map((f) => `${f}:${blobByPath.get(f) ?? "?"}`).sort();
  return createHash("sha256")
    .update(JSON.stringify({
      repository: manifest.repository,
      commit: manifest.commit,
      module_id: mod.id,
      source_blobs: blobs,
      agent: agentCmd,
      prompt_version: PROMPT_VERSION,
      analysis_protocol: ANALYSIS_PROTOCOL, // P2 第六轮 P0：分析方式变更自动失效旧缓存
      read_mode: process.env.CTT_READ_MODE || "full",
      schema_version: "1.0",
    }))
    .digest("hex")
    .slice(0, 24);
}

export function cacheDir(knowledgeDir: string): string {
  return path.join(knowledgeDir, "analysis-cache");
}

/** 读缓存：命中返回模块分析 JSON 字符串；key 不匹配（prompt/源码变化）视为未命中 */
export function readCache(knowledgeDir: string, modId: string, key: string): string | null {
  const p = path.join(cacheDir(knowledgeDir), `${modId.replace(/[^\w.-]/g, "_")}.json`);
  if (!existsSync(p)) return null;
  try {
    const entry = JSON.parse(readFileSync(p, "utf-8"));
    if (entry.cache_key === key) return JSON.stringify(entry.analysis);
    return null; // 键失效（源码或 prompt 变化）
  } catch {
    return null; // 损坏的缓存文件视为未命中（原子写入前的历史残留）
  }
}

/** 原子写缓存：临时文件 + rename，避免 Ctrl+C 留下半损坏 JSON（评审要求） */
export function writeCache(knowledgeDir: string, modId: string, key: string, analysisJson: string): void {
  const dir = cacheDir(knowledgeDir);
  mkdirSync(dir, { recursive: true });
  const final = path.join(dir, `${modId.replace(/[^\w.-]/g, "_")}.json`);
  const tmp = `${final}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ cache_key: key, analysis: JSON.parse(analysisJson) }, null, 2), "utf-8");
  renameSync(tmp, final);
}

/** 追加式执行日志：每次运行一条 run 记录（含每模块条目） */
export function appendJournal(knowledgeDir: string, entries: JournalEntry[], overall: { passed: boolean; note?: string }): void {
  const p = path.join(knowledgeDir, "analysis-journal.json");
  let journal: any = { runs: [] };
  if (existsSync(p)) {
    try { journal = JSON.parse(readFileSync(p, "utf-8")); } catch { /* 损坏则重建 */ }
  }
  journal.runs.push({
    run_at: new Date().toISOString(),
    passed: overall.passed,
    note: overall.note,
    modules: entries,
  });
  writeFileSync(p, JSON.stringify(journal, null, 2), "utf-8");
}
