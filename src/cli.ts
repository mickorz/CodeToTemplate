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
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { resolveRepository } from "./collector/git.ts";
import { buildManifest, type Manifest } from "./collector/manifest.ts";
import { buildSourceMap, bfsPath, type SourceMap } from "./analyzer/dependencies.ts";

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

switch (cmd) {
  case "collect": cmdCollect(); break;
  case "analyze": cmdAnalyze(); break;
  case "trace": cmdTrace(); break;
  default:
    fatal(`未知子命令: ${cmd ?? "(空)"}。可用：collect / analyze / trace`);
}
