/**
 * dependencies.ts —— 依赖图构建与相对导入解析（M2）
 *
 * 构建流程：
 *
 * buildSourceMap(repoDir, manifest)
 *     ├─> 逐文件 parseFile()                    符号 + 导入
 *     ├─> 相对导入解析：./x -> x / x.js / x/index.js（命中 manifest 路径集合）
 *     │     └─ 未命中 -> unknown（含动态引用）
 *     ├─> 反向索引 imported_by
 *     └─> 输出 source-map.json（确定性：文件按 path 排序）
 *
 * 图查询：bfs(from, to) 判断文件间静态可达性（M2 DoD 用）。
 */

import path from "node:path";
import { parseFile } from "./symbols.ts";
import type { Manifest } from "../collector/manifest.ts";

export interface SourceMapFile {
  symbols: ReturnType<typeof parseFile>["symbols"];
  imports: ReturnType<typeof parseFile>["imports"];
  imported_by: string[];
}

export interface SourceMap {
  schema_version: "1.0";
  repository: string;
  commit: string;
  stats: {
    files_total: number;
    files_analyzed: number;
    imports_file: number;
    imports_external: number;
    imports_unknown: number;
  };
  files: Record<string, SourceMapFile>;
}

/** 解析相对导入到清单内文件路径；失败返回 null */
function resolveRelative(
  spec: string,
  fromFile: string,
  trackedPaths: Set<string>,
): string | null {
  const base = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(base, spec));
  const candidates = [
    joined,
    `${joined}.js`,
    `${joined}.mjs`,
    `${joined}.cjs`,
    `${joined}.ts`,
    `${joined}.json`,
    `${joined}/index.js`,
    `${joined}/index.mjs`,
  ];
  for (const c of candidates) {
    if (trackedPaths.has(c)) return c;
  }
  return null;
}

/** 基于清单构建全仓符号与依赖索引 */
export function buildSourceMap(repoDir: string, manifest: Manifest): SourceMap {
  const trackedPaths = new Set(manifest.files.map((f) => f.path));
  const files: Record<string, SourceMapFile> = {};

  let importsFile = 0;
  let importsExternal = 0;
  let importsUnknown = 0;
  let analyzed = 0;

  for (const f of manifest.files) {
    if (!/\.(js|mjs|cjs)$/.test(f.path)) continue; // M2 只解析 JS（仓库无 TS 源码）
    const parsed = parseFile(path.join(repoDir, f.path));
    analyzed++;

    const imports = parsed.imports.map((imp) => {
      if (imp.kind === "file") {
        const resolved = resolveRelative(imp.spec, f.path, trackedPaths);
        if (resolved) {
          importsFile++;
          return { ...imp, resolved };
        }
        importsUnknown++;
        return { ...imp, kind: "unknown" as const };
      }
      if (imp.kind === "external") importsExternal++;
      else importsUnknown++;
      return imp;
    });

    files[f.path] = { symbols: parsed.symbols, imports, imported_by: [] };
  }

  // 反向索引
  for (const [fp, entry] of Object.entries(files)) {
    for (const imp of entry.imports) {
      if (imp.kind === "file" && imp.resolved && files[imp.resolved]) {
        files[imp.resolved].imported_by.push(fp);
      }
    }
  }
  for (const entry of Object.values(files)) {
    entry.imported_by.sort();
  }

  return {
    schema_version: "1.0",
    repository: manifest.repository,
    commit: manifest.commit,
    stats: {
      files_total: manifest.file_count,
      files_analyzed: analyzed,
      imports_file: importsFile,
      imports_external: importsExternal,
      imports_unknown: importsUnknown,
    },
    files,
  };
}

/** BFS 判断 from 是否静态可达 to（沿文件导入边）；返回路径或 null */
export function bfsPath(sm: SourceMap, from: string, to: string): string[] | null {
  const queue: Array<{ node: string; path: string[] }> = [{ node: from, path: [from] }];
  const seen = new Set([from]);
  while (queue.length) {
    const { node, path: p } = queue.shift()!;
    for (const imp of sm.files[node]?.imports ?? []) {
      if (imp.kind === "file" && imp.resolved) {
        if (imp.resolved === to) return [...p, to];
        if (!seen.has(imp.resolved) && sm.files[imp.resolved]) {
          seen.add(imp.resolved);
          queue.push({ node: imp.resolved, path: [...p, imp.resolved] });
        }
      }
    }
  }
  return null;
}
