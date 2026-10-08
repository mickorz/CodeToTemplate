/**
 * cli.ts —— 命令行入口（M1 阶段：collect 子命令）
 *
 * 使用方式：
 *
 * npm run collect -- --repo https://github.com/mickorz/openworkbuddy --ref main --output ./knowledge/openworkbuddy/desktop
 *
 * 流程：
 *
 * main(argv)
 *     ├─> 解析参数（--repo --ref --output）
 *     ├─> resolveRepository()     采集并锁定 Commit
 *     ├─> buildManifest()         生成源码文件清单
 *     └─> 写出 repository-manifest.json
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRepository } from "./collector/git.ts";
import { buildManifest } from "./collector/manifest.ts";

const args = parseArgs({
  options: {
    repo: { type: "string" },
    ref: { type: "string", default: "main" },
    output: { type: "string", default: "./knowledge" },
  },
  strict: true,
});

if (!args.values.repo) {
  console.error("缺少必填参数 --repo，例如：npm run collect -- --repo https://github.com/mickorz/openworkbuddy --ref main");
  process.exit(1);
}

const repo = args.values.repo;
const ref = args.values.ref;
const cacheRoot = path.resolve("cache");

const handle = resolveRepository(repo, ref, cacheRoot);
const manifest = buildManifest(handle, ref);

const outDir = path.resolve(args.values.output);
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "repository-manifest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf-8");

console.log(`[清单] 已输出: ${outPath}`);
console.log(`[清单] 仓库 ${manifest.repository} @ ${manifest.commit.slice(0, 10)}`);
console.log(`[清单] 文件 ${manifest.file_count} 个，共 ${(manifest.total_bytes / 1024).toFixed(1)} KB`);
console.log(`[清单] 许可证: ${manifest.license.spdx ?? "未识别"}（文件: ${manifest.license.license_file ?? "无"}）`);
console.log(`[清单] 排除: 二进制 ${manifest.filters.excluded_binary} 个，超大 ${manifest.filters.excluded_oversized} 个，目录 [${manifest.filters.ignored_dirs.join(", ")}]`);
