/**
 * engine.ts —— 模块分析执行引擎（P0-1/P0-2/P0-4）
 *
 * 逐模块调度（评审改造）：每模块独立 Agent 子进程运行，天然支持
 * 缓存命中跳过、--only 单模块、失败隔离（一个模块失败不影响其他）与 2 并发。
 *
 * 执行流程：
 *
 * runGenerateEngine(opts)
 *     ├─> 过滤模块（only）与缓存检查（cacheKey 含 blob+prompt_version）
 *     ├─> 并发池（上限 2，CLAUDE.md 约定）逐模块：
 *     │     ├─> 命中缓存 -> 直接用（journal: cache_hit）
 *     │     ├─> 未命中 -> 单模块 ctx -> runner Agent -> 规范化 -> 契约校验
 *     │     │     ├─> 通过 -> 原子写缓存
 *     │     │     └─> 失败 -> journal 记 failed + 保留原始输出到 debug 目录，继续其他模块
 *     │     └─> SIGINT -> 杀整棵子进程树 + journal 记 interrupted
 *     └─> 汇总 analyses + journal（含耗时/调用数/缓存命中）
 */

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Manifest } from "../collector/manifest.ts";
import { runAgent, type AgentRunResult } from "../discovery/runner.ts";
import { ProcessSupervisor } from "../discovery/kill.ts";
import { validateModuleAnalysis } from "./analysis-contract.ts";
import { normalizeAnalysis } from "./normalize.ts";
import { computeCacheKey, readCache, writeCache, appendJournal, type JournalEntry } from "./cache.ts";

export interface EngineModule {
  id: string;
  name: string;
  summary?: string;
  source_files: string[];
  dependencies?: string[];
}

export interface EngineOptions {
  knowledgeDir: string;
  repoDir: string;
  manifest: Manifest;
  modules: EngineModule[];
  agentScript: string;
  agentCmdLabel: string;
  only?: string[];
  refreshModules?: string[];
  resume: boolean;
  concurrency?: number; // 默认 2（CLAUDE.md：opencode run 并发上限）
  contextExtra?: Record<string, unknown>; // 附加到 Agent 上下文（如符号表，targeted 模式用）
}

export interface EngineResult {
  analyses: any[];
  failed: Array<{ module_id: string; error: string }>;
  journalEntries: JournalEntry[];
  interrupted: boolean;
}

/** P0-2：进程树清理已移至 discovery/kill.ts（统一路径），此处不再重复定义 */

export async function runGenerateEngine(opts: EngineOptions): Promise<EngineResult> {
  const { knowledgeDir, repoDir, manifest } = opts;
  const whitelist = new Set(manifest.files.map((f) => f.path));
  const concurrency = opts.concurrency ?? 2;

  // 模块过滤（--only）
  let modules = opts.modules;
  if (opts.only?.length) {
    modules = modules.filter((m) => opts.only!.includes(m.id));
  }

  const results = new Map<string, { analysis?: any; entry: JournalEntry }>();
  let interrupted = false;
  const supervisor = new ProcessSupervisor(); // P0-2：并发安全的全部活动子进程追踪

  const onInterrupt = () => {
    interrupted = true;
    const killed = supervisor.killAll();
    console.error(`[引擎] SIGINT：已清理 ${killed.length} 棵活动进程树`);
  };
  process.once("SIGINT", onInterrupt);

  // 并发池（简单 worker 池）
  const queue = [...modules];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length && !interrupted) {
      const mod = queue.shift()!;
      const started = Date.now();

      // 缓存检查
      const key = computeCacheKey(manifest, mod, opts.agentCmdLabel);
      const forceRefresh = opts.refreshModules?.includes(mod.id);
      const cached = forceRefresh ? null : readCache(knowledgeDir, mod.id, key);
      if (cached) {
        results.set(mod.id, {
          analysis: JSON.parse(cached),
          entry: {
            module_id: mod.id, status: "completed", cache_hit: true,
            llm_calls: 0, duration_ms: Date.now() - started,
            input_bytes: null, input_tokens: null, output_tokens: null, retry_count: 0,
          },
        });
        console.log(`[引擎] ${mod.id} 缓存命中（跳过 LLM）`);
        continue;
      }

      // 单模块上下文 + Agent 运行
      const ctx = {
        repository: manifest.repository,
        commit: manifest.commit,
        whitelist: [...whitelist],
        ...(opts.contextExtra ?? {}),
        modules: [{ ...mod, source_files: mod.source_files.filter((f) => whitelist.has(f)) }],
      };
      const moduleCtxPath = path.join(knowledgeDir, `analysis-context-${mod.id.replace(/[^\w.-]/g, "_")}.tmp.json`); // P0-2：每模块独立 ctx（并发交叉污染修复）
      writeFileSync(moduleCtxPath, JSON.stringify(ctx), "utf-8");
      let run: AgentRunResult | null = null;
      try {
        console.log(`[引擎] 分析模块 ${mod.id}（${mod.source_files.length} 文件）...`);
        run = await runAgent(opts.agentScript, moduleCtxPath, repoDir, whitelist, (pid) => { supervisor.register(pid); });
      } finally {
        // 子进程已随 runAgent 返回而退出；已死 pid 对 killAll 无害，无需精确摘除
      }

      if (interrupted) {
        results.set(mod.id, {
          entry: {
            module_id: mod.id, status: "interrupted", cache_hit: false,
            llm_calls: 1, duration_ms: Date.now() - started,
            input_bytes: null, input_tokens: null, output_tokens: null, retry_count: 0,
            error: "SIGINT 中断",
          },
        });
        return;
      }

      if (!run.ok || !run.output) {
        // 失败：保留原始输出供调试，不作为可信知识；继续其他模块（失败隔离）
        if (run.output) {
          const dbgDir = path.join(knowledgeDir, "analysis-debug");
          mkdirSync(dbgDir, { recursive: true });
          writeFileSync(path.join(dbgDir, `${mod.id.replace(/[^\w.-]/g, "_")}.raw.json`), run.output, "utf-8");
        }
        results.set(mod.id, {
          entry: {
            module_id: mod.id, status: "failed", cache_hit: false,
            llm_calls: 1, duration_ms: Date.now() - started,
            input_bytes: null, input_tokens: null, output_tokens: null, retry_count: 0,
            error: run.error ?? "Agent 无输出",
          },
        });
        console.error(`[引擎] 模块 ${mod.id} 失败: ${run.error}（其余模块继续）`);
        continue;
      }

      // 解析 -> 规范化 -> 契约
      try {
        const parsed = JSON.parse(run.output);
        const rawAnalysis = Array.isArray(parsed.analyses) ? parsed.analyses[0] : parsed;
        const readFiles = rawAnalysis.read_files ?? mod.source_files;
        const normalized = normalizeAnalysis(rawAnalysis, mod, whitelist, readFiles);
        const contract = validateModuleAnalysis(JSON.stringify(normalized), whitelist);
        // 降级检测：Agent 声明 LLM 输出不可解析的空分析，视为失败不入缓存（避免缓存掩塑失败）
        const degraded = (normalized.open_questions ?? []).some((q: string) => String(q).includes("LLM 输出不可解析"));
        if (degraded) {
          const dbgDir = path.join(knowledgeDir, "analysis-debug");
          mkdirSync(dbgDir, { recursive: true });
          writeFileSync(path.join(dbgDir, `${mod.id.replace(/[^\w.-]/g, "_")}.raw.json`), run.output, "utf-8");
          results.set(mod.id, {
            entry: {
              module_id: mod.id, status: "failed", cache_hit: false,
              llm_calls: 1, duration_ms: Date.now() - started,
              input_bytes: null, input_tokens: null, output_tokens: null, retry_count: 0,
              error: "LLM 输出不可解析（降级产物不入缓存，原始输出在 analysis-debug/）",
            },
          });
          console.error(`[引擎] 模块 ${mod.id} LLM 输出不可解析（记 failed 不入缓存，其余模块继续）`);
          continue;
        }
        if (!contract.ok) {
          const dbgDir = path.join(knowledgeDir, "analysis-debug");
          mkdirSync(dbgDir, { recursive: true });
          writeFileSync(path.join(dbgDir, `${mod.id.replace(/[^\w.-]/g, "_")}.raw.json`), run.output, "utf-8");
          results.set(mod.id, {
            entry: {
              module_id: mod.id, status: "failed", cache_hit: false,
              llm_calls: 1, duration_ms: Date.now() - started,
              input_bytes: null, input_tokens: null, output_tokens: null, retry_count: 0,
              error: `契约失败: ${contract.errors.join("; ").slice(0, 200)}`,
            },
          });
          console.error(`[引擎] 模块 ${mod.id} 契约失败（原始输出已存 analysis-debug/，其余模块继续）`);
          continue;
        }
        // 通过：原子写缓存
        const analysisJson = JSON.stringify(normalized);
        writeCache(knowledgeDir, mod.id, key, analysisJson);
        results.set(mod.id, {
          analysis: normalized,
          entry: {
            module_id: mod.id, status: "completed", cache_hit: false,
            llm_calls: 1, duration_ms: Date.now() - started,
            input_bytes: run.output.length, input_tokens: null, output_tokens: null, retry_count: 0,
          },
        });
        console.log(`[引擎] 模块 ${mod.id} 完成（${((Date.now() - started) / 1000).toFixed(0)}s，已入缓存）`);
      } catch (e) {
        results.set(mod.id, {
          entry: {
            module_id: mod.id, status: "failed", cache_hit: false,
            llm_calls: 1, duration_ms: Date.now() - started,
            input_bytes: null, input_tokens: null, output_tokens: null, retry_count: 0,
            error: `解析失败: ${(e as Error).message}`,
          },
        });
        console.error(`[引擎] 模块 ${mod.id} 解析失败: ${(e as Error).message}`);
      }
    }
  });

  await Promise.all(workers);
  process.removeListener("SIGINT", onInterrupt);

  const journalEntries = modules
    .filter((m) => results.has(m.id))
    .map((m) => results.get(m.id)!.entry);
  const failed = journalEntries
    .filter((e) => e.status === "failed")
    .map((e) => ({ module_id: e.module_id, error: e.error ?? "" }));

  // resume 语义：跳过缓存已有的失败重试由缓存/refresh 决定；本次仅汇总
  appendJournal(knowledgeDir, journalEntries, {
    passed: failed.length === 0 && !interrupted,
    note: interrupted ? "SIGINT 中断" : failed.length ? `${failed.length} 个模块失败（失败隔离，其余完成）` : undefined,
  });

  return {
    analyses: modules.filter((m) => results.get(m.id)?.analysis).map((m) => results.get(m.id)!.analysis),
    failed,
    journalEntries,
    interrupted,
  };
}
