/**
 * context.ts —— 受限发现上下文生成器（P1-1）
 *
 * 设计原则（评审要求的环境级隔离）：
 * Agent 子进程只能拿到本模块产出的 discovery-context.json 与受控读取协议，
 * 拿不到仓库路径、knowledge/、test/gold-set/——隔离靠输入面而非提示词。
 *
 * 生成流程：
 *
 * buildDiscoveryContext(manifest, sourceMap, topic)
 *     ├─> 仓库概览：文件数 / 语言分布 / 一二级目录树
 *     ├─> 入口候选：package.json 声明的 main bin scripts
 *     ├─> 依赖摘要：每文件出边与入边连接度（top N 排序）
 *     └─> 符号摘要：每文件符号数与代表性符号名
 */

import type { Manifest } from "../collector/manifest.ts";
import type { SourceMap } from "../analyzer/dependencies.ts";

export interface DiscoveryContext {
  schema_version: "1.0";
  repository: string;
  commit: string;
  topic: string;
  repo_overview: {
    file_count: number;
    ext_distribution: Record<string, number>;
    dirs: Array<{ path: string; file_count: number }>;
  };
  entry_candidates: {
    package_json: Record<string, unknown> | null;
    /** 无入边（不被任何文件导入）的 JS 文件（潜在入口） */
    roots: string[];
  };
  /** 依赖摘要：连接度 top（入边优先，入口与枢纽文件） */
  dependency_summary: Array<{
    path: string;
    out_edges: number;
    in_edges: number;
    symbols: number;
    top_symbols: string[];
  }>;
  /** Agent 可经受控协议请求读取的文件白名单（即 manifest 全部路径） */
  readable_files: string[];
}

const TOP_N = 40;

export function buildDiscoveryContext(
  manifest: Manifest,
  sourceMap: SourceMap,
  topic: string,
  pkgJson: Record<string, unknown> | null,
): DiscoveryContext {
  // 语言分布
  const exts: Record<string, number> = {};
  for (const f of manifest.files) {
    const e = f.path.includes(".") ? f.path.split(".").pop()! : "(none)";
    exts[e] = (exts[e] ?? 0) + 1;
  }

  // 一二级目录统计
  const dirCount = new Map<string, number>();
  for (const f of manifest.files) {
    const segs = f.path.split("/");
    if (segs.length === 1) continue;
    const dir = segs.length <= 2 ? segs[0] : `${segs[0]}/${segs[1]}`;
    dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);
  }

  // 依赖摘要与根节点（无入边的 JS 文件）
  const summary: DiscoveryContext["dependency_summary"] = [];
  const roots: string[] = [];
  for (const [path, entry] of Object.entries(sourceMap.files)) {
    const inEdges = entry.imported_by.length;
    if (inEdges === 0) roots.push(path);
    summary.push({
      path,
      out_edges: entry.imports.filter((i) => i.kind === "file").length,
      in_edges: inEdges,
      symbols: entry.symbols.length,
      top_symbols: entry.symbols.slice(0, 6).map((s) => s.name),
    });
  }
  // 连接度排序：入边高优先（被依赖多的枢纽），其次出边
  summary.sort((a, b) => b.in_edges - a.in_edges || b.out_edges - a.out_edges);

  return {
    schema_version: "1.0",
    repository: manifest.repository,
    commit: manifest.commit,
    topic,
    repo_overview: {
      file_count: manifest.file_count,
      ext_distribution: exts,
      dirs: [...dirCount.entries()]
        .map(([path, file_count]) => ({ path, file_count }))
        .sort((a, b) => b.file_count - a.file_count),
    },
    entry_candidates: {
      package_json: pkgJson,
      roots,
    },
    dependency_summary: summary.slice(0, TOP_N),
    readable_files: manifest.files.map((f) => f.path),
  };
}
