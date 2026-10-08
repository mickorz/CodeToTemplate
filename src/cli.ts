/**
 * cli.ts —— 命令行入口
 *
 * 子命令：
 *
 * npm run collect -- --repo <url> --ref <ref> --output <dir>   M1 采集 + 清单
 * npm run analyze -- --manifest <repository-manifest.json> --output <dir>   M2 符号/依赖索引
 * node src/cli.ts trace --sourcemap <source-map.json> --from <file> --to <file>   M2 DoD 依赖追踪
 *
 * 流程：
 *
 * main(argv)
 *     ├─> 子命令分派
 *     ├─> collect: resolveRepository -> buildManifest -> repository-manifest.json
 *     ├─> analyze: buildSourceMap（基于 manifest + 本地缓存仓库）-> source-map.json
 *     └─> trace:   bfsPath 可达性断言（退出码 0/1，供测试用）
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveRepository } from "./collector/git.ts";
import { buildManifest, type Manifest } from "./collector/manifest.ts";
import { buildSourceMap, bfsPath, type SourceMap } from "./analyzer/dependencies.ts";
import { buildDiscoveryContext } from "./discovery/context.ts";
import { validateModuleMap } from "./discovery/contract.ts";
import { runAgent } from "./discovery/runner.ts";
import { validateModuleAnalysis, type ModuleAnalysis } from "./generate/analysis-contract.ts";
import { renderAll } from "./generate/render.ts";
import { publish } from "./generate/publisher.ts";
import { runVerify } from "./knowledge/validator.ts";
import { runGenerateEngine } from "./generate/engine.ts";
import { normalizeAnalysis } from "./generate/normalize.ts";
import { checkClaims } from "./review/claim-checker.ts";
import { computeCacheKey, readCache, writeCache } from "./generate/cache.ts";
import { createHash } from "node:crypto";
import { buildCatalog, writeCatalog, type Catalog } from "./catalog/builder.ts";
import { buildReferenceContext, writeReferenceContext } from "./reference/builder.ts";
import { searchCapabilities, formatHits } from "./catalog/search.ts";

const CACHE_ROOT = path.resolve("cache");
const [cmd, ...rest] = process.argv.slice(2);

function fatal(msg: string): never {
  console.error(`[错误] ${msg}`);
  process.exit(1);
}

function loadJson<T>(p: string): T {
  if (!existsSync(p)) fatal(`文件不存在: ${p}`);
  return JSON.parse(readFileSync(p, "utf-8")) as T;
}

/** M1：采集 + 清单 */
function cmdCollect() {
  const args = parseArgs({
    options: {
      repo: { type: "string" },
      ref: { type: "string", default: "main" },
      output: { type: "string", default: "./knowledge" },
    },
    strict: true,
    args: rest,
  });
  if (!args.values.repo) fatal("缺少必填参数 --repo");

  const handle = resolveRepository(args.values.repo, args.values.ref, CACHE_ROOT);
  const manifest = buildManifest(handle, args.values.ref);

  const outDir = path.resolve(args.values.output);
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "repository-manifest.json");
  writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf-8");

  console.log(`[清单] 已输出: ${outPath}`);
  console.log(`[清单] 仓库 ${manifest.repository} @ ${manifest.commit.slice(0, 10)}`);
  console.log(`[清单] 文件 ${manifest.file_count} 个，共 ${(manifest.total_bytes / 1024).toFixed(1)} KB`);
  console.log(`[清单] 许可证: ${manifest.license.spdx ?? "未识别"}（文件: ${manifest.license.license_file ?? "无"}）`);
  console.log(`[清单] 排除: 二进制 ${manifest.filters.excluded_binary} 个，超大 ${manifest.filters.excluded_oversized} 个，目录 [${manifest.filters.ignored_dirs.join(", ")}]`);
}

/** M2：符号与依赖索引 */
function cmdAnalyze() {
  const args = parseArgs({
    options: {
      manifest: { type: "string", default: "./knowledge/openworkbuddy/desktop/repository-manifest.json" },
      output: { type: "string" },
    },
    strict: true,
    args: rest,
  });

  const manifestPath = path.resolve(args.values.manifest);
  const manifest = loadJson<Manifest>(manifestPath);
  const repoDir = path.join(CACHE_ROOT, "repos", manifest.repository.replace("/", "__"));
  if (!existsSync(repoDir)) fatal(`本地缓存仓库不存在: ${repoDir}，请先执行 collect`);

  const sm = buildSourceMap(repoDir, manifest);

  const outDir = path.resolve(args.values.output ?? path.dirname(manifestPath));
  const outPath = path.join(outDir, "source-map.json");
  writeFileSync(outPath, JSON.stringify(sm, null, 2), "utf-8");

  console.log(`[索引] 已输出: ${outPath}`);
  console.log(`[索引] 解析 ${sm.stats.files_analyzed} 个 JS 文件`);
  console.log(`[索引] 导入: 文件内 ${sm.stats.imports_file} / 外部 ${sm.stats.imports_external} / 无法解析 ${sm.stats.imports_unknown}`);
}

/** M2 DoD：静态可达性追踪 */
function cmdTrace() {
  const args = parseArgs({
    options: {
      sourcemap: { type: "string", default: "./knowledge/openworkbuddy/desktop/source-map.json" },
      from: { type: "string", required: true },
      to: { type: "string" },
    },
    strict: true,
    args: rest,
  });

  const sm = loadJson<SourceMap>(path.resolve(args.values.sourcemap));
  const toArg = args.values.to;
  const targets = toArg
    ? [toArg]
    : Object.keys(sm.files).filter((f) => /(server-host|bridge-main|server-supervisor|electron-bridge)/.test(f));

  let allOk = true;
  const from = args.values.from;
  if (!from) fatal("缺少必填参数 --from");
  if (!sm.files[from]) fatal(`起始文件不在索引中: ${from}`);
  for (const to of targets) {
    const p = bfsPath(sm, from, to);
    if (p) {
      console.log(`[追踪] ${from} -> ${to} 可达（${p.length - 1} 跳）: ${p.join(" -> ")}`);
    } else {
      console.error(`[追踪] ${from} -> ${to} 不可达`);
      allOk = false;
    }
  }
  process.exit(allOk ? 0 : 1);
}

/** P1-1：受限发现上下文 + Agent Runner + 输出契约校验 */
async function cmdDiscover() {
  const args = parseArgs({
    options: {
      knowledge: { type: "string", default: "./knowledge/openworkbuddy/desktop" },
      agent: { type: "string", default: "./agents/mock-discover.mjs" },
      topic: { type: "string", default: "desktop" },
    },
    strict: true,
    args: rest,
  });

  const knowledgeDir = path.resolve(args.values.knowledge);
  const manifest = loadJson<Manifest>(path.join(knowledgeDir, "repository-manifest.json"));
  const sourceMap = loadJson<SourceMap>(path.join(knowledgeDir, "source-map.json"));
  const repoDir = path.join(CACHE_ROOT, "repos", manifest.repository.replace("/", "__"));
  if (!existsSync(repoDir)) fatal(`本地缓存仓库不存在: ${repoDir}，请先执行 collect`);

  // package.json 内容仅进上下文（入口候选），不含 gold-set / knowledge 其他文件
  let pkgJson: Record<string, unknown> | null = null;
  if (existsSync(path.join(repoDir, "package.json"))) {
    try { pkgJson = JSON.parse(readFileSync(path.join(repoDir, "package.json"), "utf-8")); } catch { /* 非法 json 置空 */ }
  }

  // 1. 生成受限发现上下文（Agent 唯一输入）
  const context = buildDiscoveryContext(manifest, sourceMap, args.values.topic, pkgJson);
  const contextPath = path.join(knowledgeDir, "discovery-context.json");
  writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf-8");
  console.log(`[发现] 上下文已生成: ${contextPath}（白名单 ${context.readable_files.length} 文件）`);

  // 2. 运行 Agent 子进程（受控读取协议，白名单制）
  console.log(`[发现] 运行 Agent: ${args.values.agent}`);
  const result = await runAgent(args.values.agent, contextPath, repoDir, new Set(context.readable_files));
  if (!result.ok || !result.output) fatal(`Agent 失败: ${result.error}`);
  console.log(`[发现] Agent 完成，经协议读取 ${result.readLog.length} 个文件: ${result.readLog.slice(0, 5).join(", ")}${result.readLog.length > 5 ? "..." : ""}`);

  // 3. 输出契约校验
  const manifestPaths = new Set(manifest.files.map((f) => f.path));
  const contract = validateModuleMap(result.output, context, manifestPaths);
  if (!contract.ok) {
    console.error("[发现] 契约校验失败:");
    for (const e of contract.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  // 4. 落盘：Agent 产物独立命名，不覆盖人工/Publisher 晋升的主 module-map.json
  const outPath = path.join(knowledgeDir, "module-map.discovery.json");
  writeFileSync(outPath, result.output, "utf-8");
  const mm = JSON.parse(result.output);
  console.log(`[发现] 契约校验通过，module-map 已写出: ${outPath}（${mm.modules.length} 模块）`);
  for (const m of mm.modules) {
    console.log(`  - ${m.id} [${m.confidence}] ${m.source_files.length} 文件 | ${String(m.summary).slice(0, 60)}`);
  }
}

/** P1-2/P1-4：模块分析引擎（缓存/Journal/单模块/失败隔离/2 并发）-> 渲染 -> 校验 -> 发布 */
async function cmdGenerate() {
  const args = parseArgs({
    options: {
      knowledge: { type: "string", default: "./knowledge/openworkbuddy/desktop" },
      agent: { type: "string", default: "./agents/mock-analyze.mjs" },
      "module-map": { type: "string" },
      assertions: { type: "string", default: "./test/gold-set/openworkbuddy-assertions.json" },
      only: { type: "string" },            // 逗号分隔：只分析这些模块
      "refresh-module": { type: "string" }, // 逗号分隔：强制重分析（忽略缓存）
      resume: { type: "boolean", default: false },
    },
    strict: true,
    args: rest,
  });

  const knowledgeDir = path.resolve(args.values.knowledge);
  const manifest = loadJson<Manifest>(path.join(knowledgeDir, "repository-manifest.json"));
  const repoDir = path.join(CACHE_ROOT, "repos", manifest.repository.replace("/", "__"));
  if (!existsSync(repoDir)) fatal(`本地缓存仓库不存在: ${repoDir}，请先执行 collect`);

  const moduleMapPath = path.resolve(args.values["module-map"] ?? path.join(knowledgeDir, "module-map.json"));
  const moduleMap = loadJson<{ modules: any[] }>(moduleMapPath);
  const manifestPaths = new Set(manifest.files.map((f) => f.path));
  const modules = moduleMap.modules.map((m: any) => ({
    id: m.id, name: m.name, summary: m.summary,
    source_files: (m.source_files as string[]).filter((f) => manifestPaths.has(f)),
    dependencies: m.dependencies ?? [],
  }));

  console.log(`[生成] 模块 ${modules.length} 个，agent=${args.values.agent}${args.values.only ? `，only=${args.values.only}` : ""}`);

  // 1. 逐模块引擎（缓存/失败隔离/2 并发）
  const engine = await runGenerateEngine({
    knowledgeDir, repoDir, manifest, modules,
    agentScript: args.values.agent,
    agentCmdLabel: args.values.agent,
    only: args.values.only?.split(",").map((s) => s.trim()).filter(Boolean),
    refreshModules: args.values["refresh-module"]?.split(",").map((s) => s.trim()).filter(Boolean),
    resume: args.values.resume === true,
  });

  if (engine.interrupted) {
    console.error("[生成] 已中断（journal 已记录，缓存中的成功模块已保留）");
    process.exit(130);
  }
  if (!engine.analyses.length) fatal(`没有任何模块分析成功（失败: ${engine.failed.map((f) => f.module_id).join(", ")}）`);
  for (const f of engine.failed) console.error(`[生成] 模块失败（已隔离）: ${f.module_id} - ${f.error.slice(0, 120)}`);

  // 2. 合并产物 + 渲染（generated/，不覆盖手写产物）
  const analyses = engine.analyses as ModuleAnalysis[];
  writeFileSync(
    path.join(knowledgeDir, "module-analysis.json"),
    JSON.stringify({
      schema_version: "1.0", repository: manifest.repository, commit: manifest.commit,
      generated_by: `engine (${args.values.agent})`, analyses,
    }, null, 2),
    "utf-8",
  );
  console.log(`[生成] module-analysis.json 已写出（成功 ${analyses.length}/${modules.length} 模块）`);

  const rendered = renderAll(analyses, { repository: manifest.repository, commit: manifest.commit });
  const genDir = path.join(knowledgeDir, "generated", "modules");
  mkdirSync(genDir, { recursive: true });
  for (const [name, md] of Object.entries(rendered)) {
    writeFileSync(path.join(genDir, name), md, "utf-8");
  }
  console.log(`[生成] 已渲染 ${Object.keys(rendered).length} 份文档到 generated/modules/`);

  // 3. 确定性校验（写 deterministic-report.json）+ Publisher 汇总
  const assertionsPath = path.resolve(args.values.assertions);
  const assertions = existsSync(assertionsPath) ? JSON.parse(readFileSync(assertionsPath, "utf-8")) : [];
  const moduleMapFile = path.relative(knowledgeDir, moduleMapPath).replace(/\\/g, "/");
  const verify = runVerify(knowledgeDir, repoDir, assertions, moduleMapFile);
  writeFileSync(
    path.join(knowledgeDir, "deterministic-report.json"),
    JSON.stringify({ repository: manifest.repository, commit: manifest.commit, deterministic_checks: verify.checks, passed: verify.passed }, null, 2),
    "utf-8",
  );
  const pub = publish(knowledgeDir, { required: ["deterministic-report"], mode: "partial" });
  console.log(`[生成] Publisher 中间汇总（partial，正式发布需 review 通过）: overall=${pub.overall_passed ? "通过" : "失败"}（deterministic=${verify.passed ? "通过" : "失败"}${pub.sections["review-report"]?.present ? ", review 已存在" : ", review 未跑"}）`);
  if (!verify.passed || engine.failed.length) process.exit(1);
}

/** P0-3：离线契约调试（不调 LLM：验证已有 LLM 输出能否过规范化+契约） */
function cmdValidateAnalysis() {
  const args = parseArgs({
    options: {
      file: { type: "string", required: true },
      knowledge: { type: "string", default: "./knowledge/p-queue/scheduling" },
    },
    strict: true,
    args: rest,
  });

  const knowledgeDir = path.resolve(args.values.knowledge);
  const manifest = loadJson<Manifest>(path.join(knowledgeDir, "repository-manifest.json"));
  const whitelist = new Set(manifest.files.map((f) => f.path));

  const raw = JSON.parse(readFileSync(path.resolve(args.values.file ?? fatal("缺少 --file")), "utf-8"));
  const list: Array<[any, any]> = Array.isArray(raw.analyses)
    ? raw.analyses.map((a: any) => [a, { id: a.module_id, name: a.name, summary: a.summary, source_files: a.read_files ?? [] }])
    : [[raw, { id: raw.module_id, name: raw.name, summary: raw.summary, source_files: raw.read_files ?? [] }]];

  let allOk = true;
  for (const [item, mod] of list) {
    const normalized = normalizeAnalysis(item, mod, whitelist, item.read_files ?? mod.source_files);
    const c = validateModuleAnalysis(JSON.stringify(normalized), whitelist);
    if (c.ok) console.log(`[离线验证] ${mod.id}: 契约通过`);
    else {
      allOk = false;
      console.error(`[离线验证] ${mod.id}: 契约失败`);
      for (const e of c.errors) console.error(`  - ${e}`);
    }
  }
  process.exit(allOk ? 0 : 1);
}

/** P1-4 Reviewer：确定性主张核查 + LLM 语义审查 + 质量量化（性能与质量指标分开） */
async function cmdReview() {
  const args = parseArgs({
    options: {
      knowledge: { type: "string", default: "./knowledge/p-queue/scheduling" },
      agent: { type: "string", default: "./agents/llm-review.mjs" },
      refresh: { type: "boolean", default: false }, // 忽略审查缓存重审
    },
    strict: true,
    args: rest,
  });

  const knowledgeDir = path.resolve(args.values.knowledge);
  const manifest = loadJson<Manifest>(path.join(knowledgeDir, "repository-manifest.json"));
  const repoDir = path.join(CACHE_ROOT, "repos", manifest.repository.replace("/", "__"));
  if (!existsSync(repoDir)) fatal(`本地缓存仓库不存在: ${repoDir}`);
  const ma = loadJson<{ analyses: any[] }>(path.join(knowledgeDir, "module-analysis.json"));
  const whitelist = new Set(manifest.files.map((f) => f.path));

  // ---- 第一层：确定性主张核查（全部模块全部条目） ----
  const allViolations = [];
  for (const a of ma.analyses) {
    const contents = new Map<string, string>();
    for (const f of a.read_files ?? []) {
      if (whitelist.has(f)) {
        try { contents.set(f, readFileSync(path.join(repoDir, f), "utf-8")); } catch { /* 跳过 */ }
      }
    }
    allViolations.push(...checkClaims(a, contents));
  }
  console.log(`[审查] 确定性主张核查：${ma.analyses.length} 模块，拦截 ${allViolations.length} 条违规`);
  for (const v of allViolations) console.error(`  - [${v.module_id}] ${v.statement.slice(0, 60)} (${v.reason})`);

  // ---- 第二层：LLM 语义审查（抽样：全部 inferences + 机制关键词 facts，上限 15 条/模块，缓存按模块） ----
  const { buildClaimsForReview, claimsHash } = await import("./review/claims.ts");
  const llmResults = [];
  for (const a of ma.analyses) {
    const claims = buildClaimsForReview(a);
    const curClaimsHash = claimsHash(claims);
    if (!claims.length) { llmResults.push({ module_id: a.module_id, verdicts: [], review_status: "unreviewed", note: "无待审条目（基础契约已过，未经语义审查）" }); continue; }

    const cacheId = `review__${a.module_id}`;
    // 审查缓存键必须含送审内容 hash：分析刷新后旧审查结论不得继续命中
    const key = computeCacheKey(manifest, { id: cacheId, source_files: a.read_files ?? [] }, `llm-review:${args.values.agent}`)
      + "-" + createHash("sha256").update(JSON.stringify(claims)).digest("hex").slice(0, 12);
    const cached = args.values.refresh ? null : readCache(knowledgeDir, cacheId, key);
    if (cached) {
      const entry = JSON.parse(cached);
      entry.review_status = "reviewed";
      entry.claims_hash = curClaimsHash;
      llmResults.push(entry);
      console.log(`[审查] ${a.module_id} 审查缓存命中`);
      continue;
    }

    const ctx = {
      repository: manifest.repository, commit: manifest.commit,
      whitelist: [...whitelist],
      modules: [{ id: a.module_id, source_files: a.read_files ?? [], claims }],
    };
    const ctxPath = path.join(knowledgeDir, "review-context.tmp.json");
    writeFileSync(ctxPath, JSON.stringify(ctx), "utf-8");
    const run = await runAgent(args.values.agent, ctxPath, repoDir, whitelist);
    if (!run.ok || !run.output) {
      console.error(`[审查] ${a.module_id} LLM 审查失败: ${run.error}（该模块标 unreviewed）`);
      llmResults.push({ module_id: a.module_id, verdicts: [], review_status: "unreviewed", note: `LLM 审查失败: ${run.error}` });
      continue;
    }
    const result = JSON.parse(run.output);
    result.review_status = "reviewed";
    result.claims_hash = curClaimsHash; // P2 修复 2：送审内容指纹（catalog 校验时效用）
    llmResults.push(result);
    writeCache(knowledgeDir, cacheId, key, JSON.stringify(result));
    const counts = { s: 0, u: 0, n: 0 };
    for (const v of result.verdicts) {
      if (v.verdict === "supported") counts.s++;
      else if (v.verdict === "unsupported") counts.u++;
      else counts.n++;
    }
    console.log(`[审查] ${a.module_id} LLM 审查完成：supported ${counts.s} / unsupported ${counts.u} / unverifiable ${counts.n}`);
  }

  const unsupported = llmResults.flatMap((r: any) =>
    (r.verdicts ?? []).filter((v: any) => v.verdict === "unsupported").map((v: any) => ({ module_id: r.module_id, ...v })));
  const passed = allViolations.length === 0 && unsupported.length === 0;

  writeFileSync(
    path.join(knowledgeDir, "review-report.json"),
    JSON.stringify({
      schema_version: "1.0", repository: manifest.repository, commit: manifest.commit,
      deterministic: { violations: allViolations, count: allViolations.length },
      llm: llmResults,
      unsupported_count: unsupported.length,
      passed,
    }, null, 2),
    "utf-8",
  );
  console.log(`[审查] review-report.json 已写出：passed=${passed}（确定性违规 ${allViolations.length}，unsupported ${unsupported.length}）`);

  // ---- 质量量化（评审要求：性能与质量指标分开记录） ----
  const verdicts = llmResults.flatMap((r: any) => r.verdicts ?? []);
  const judged = verdicts.filter((v: any) => v.verdict !== "unverifiable");
  const supported = judged.filter((v: any) => v.verdict === "supported");
  const text = JSON.stringify(ma.analyses);
  const mechanisms = {
    concurrency: /并发|concurren/i.test(text),
    priority: /优先|priority/i.test(text),
    timeout: /超时|timeout/i.test(text),
    pause_resume: /暂停|pause|resume/i.test(text),
    rate_limit: /速率|rate.?limit/i.test(text),
  };
  // 空槽率：渲染产物统计
  let totalSlots = 0, emptySlots = 0;
  const genDir = path.join(knowledgeDir, "generated", "modules");
  if (existsSync(genDir)) {
    for (const f of readdirSync(genDir)) {
      if (!f.endsWith(".md")) continue;
      const md = readFileSync(path.join(genDir, f), "utf-8");
      for (const s of md.split(/^## /m).slice(1)) {
        totalSlots++;
        if (/待 LLM|证据不足|待补充|（无/.test(s.slice(s.indexOf("\n")))) emptySlots++;
      }
    }
  }
  writeFileSync(
    path.join(knowledgeDir, "quality-report.json"),
    JSON.stringify({
      schema_version: "1.0", repository: manifest.repository, commit: manifest.commit,
      evidence_accuracy: judged.length ? Number((supported.length / judged.length).toFixed(4)) : null,
      verdicts_total: verdicts.length,
      unsupported_count: unsupported.length,
      mechanism_coverage: mechanisms,
      mechanism_coverage_ratio: Object.values(mechanisms).filter(Boolean).length / Object.keys(mechanisms).length,
      doc_slots: { total: totalSlots, empty: emptySlots, empty_ratio: totalSlots ? Number((emptySlots / totalSlots).toFixed(4)) : null },
    }, null, 2),
    "utf-8",
  );
  console.log(`[质量] quality-report.json：准确率 ${judged.length ? ((supported.length / judged.length) * 100).toFixed(1) + "%" : "无抽样"}，机制覆盖 ${Object.values(mechanisms).filter(Boolean).length}/${Object.keys(mechanisms).length}，空槽率 ${totalSlots ? ((emptySlots / totalSlots) * 100).toFixed(0) + "%" : "-"}`);

  if (!passed) process.exit(1);
}

/** P1-5a：构建跨仓库能力索引 */
function cmdCatalog() {
  const args = parseArgs({
    options: { knowledge: { type: "string", default: "./knowledge" } },
    strict: true,
    args: rest,
  });
  const root = path.resolve(args.values.knowledge);
  const catalog = buildCatalog(root);
  const out = writeCatalog(root, catalog);
  const totalModules = catalog.capabilities.reduce((s, c) => s + c.modules.length, 0);
  console.log(`[索引] 能力 ${catalog.capabilities.length} 类，模块引用 ${totalModules} 条 -> ${out}`);
  for (const c of catalog.capabilities) {
    console.log(`  - ${c.id}: ${[...new Set(c.modules.map((m) => m.repo))].join(" / ")}（${c.modules.length} 模块）`);
  }
}

/** P1-5b：能力检索（确定性关键词匹配，无需知道仓库名） */
function cmdSearch() {
  const args = parseArgs({
    options: {
      query: { type: "string", required: true },
      knowledge: { type: "string", default: "./knowledge" },
      limit: { type: "string", default: "5" },
      "trusted-only": { type: "boolean", default: false }, // P2-0b：只返回已审查且有实证的能力引用
    },
    strict: true,
    args: rest,
  });
  const catalogPath = path.join(path.resolve(args.values.knowledge), "catalog.json");
  if (!existsSync(catalogPath)) fatal(`能力索引不存在: ${catalogPath}，请先执行 npm run catalog`);
  const catalog = loadJson<Catalog>(catalogPath);
  const hits = searchCapabilities(catalog, args.values.query ?? "", { trustedOnly: args.values["trusted-only"] === true });
  console.log(`[检索] 查询: ${args.values.query}${args.values["trusted-only"] ? "（仅可信条目）" : ""}`);
  console.log(formatHits(hits, Number(args.values.limit)));
  if (!hits.length) process.exit(1);
}

/** P2-1：参考实现上下文构建（需求 -> 可信模块 -> 最小参考包，供 Coding Agent 消费） */
async function cmdContext() {
  const args = parseArgs({
    options: {
      query: { type: "string", required: true },
      knowledge: { type: "string", default: "./knowledge" },
      out: { type: "string", default: "./knowledge/reference" },
      "no-trusted": { type: "boolean", default: false }, // 默认仅可信模块
      limit: { type: "string", default: "3" },
    },
    strict: true,
    args: rest,
  });
  const root = path.resolve(args.values.knowledge);
  const catalogPath = path.join(root, "catalog.json");
  if (!existsSync(catalogPath)) fatal(`能力索引不存在: ${catalogPath}，请先执行 npm run catalog`);
  const catalog = loadJson<Catalog>(catalogPath);

  const query = args.values.query ?? "";
  const ctx = buildReferenceContext(query, catalog, root, {
    trustedOnly: args.values["no-trusted"] !== true,
    maxModules: Number(args.values.limit),
  });
  if (!ctx.references.length) {
    console.error(`[参考] 无可信模块命中需求：${query}（可先 review 提升可信度，或用 --no-trusted 放开）`);
    process.exit(1);
  }
  const { json, md } = writeReferenceContext(path.resolve(args.values.out), ctx);
  console.log(`[参考] 需求：${query}`);
  console.log(`[参考] 命中能力：${ctx.capabilities_hit.map((c) => c.capability).join("、")}`);
  for (const r of ctx.references) {
    console.log(`  - ${r.repo}/${r.module_id} [${r.review_status}] ${r.facts.length} facts，许可证 ${r.license}`);
  }
  console.log(`[参考] 参考包已写出：${json} 与 ${md}`);
}

switch (cmd) {
  case "collect": cmdCollect(); break;
  case "analyze": cmdAnalyze(); break;
  case "trace": cmdTrace(); break;
  case "discover": await cmdDiscover(); break;
  case "generate": await cmdGenerate(); break;
  case "review": await cmdReview(); break;
  case "catalog": cmdCatalog(); break;
  case "search": cmdSearch(); break;
  case "context": await cmdContext(); break;
  case "validate-analysis": cmdValidateAnalysis(); break;
  default:
    fatal(`未知子命令: ${cmd ?? "(空)"}。可用：collect / analyze / trace / discover / generate / review / catalog / search / context / validate-analysis`);
}
