/**
 * manifest.ts —— 生成 repository-manifest.json（源码文件清单）
 *
 * 生成流程：
 *
 * buildManifest(handle)
 *     ├─> git ls-files -s              取全部被跟踪文件及 blob SHA
 *     ├─> 过滤：忽略目录 / 二进制 / 超大文件
 *     ├─> 检测许可证（LICENSE 文件 + package.json）
 *     └─> 输出确定性清单（文件按 path 排序，不含时间戳）
 *
 * 确定性保证：同一 Commit 两次执行输出逐字节一致（DoD）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { RepositoryHandle } from "./git.ts";

export interface ManifestFile {
  path: string;
  bytes: number;
  blob_sha: string;
}

export interface Manifest {
  schema_version: "1.0";
  repository: string;
  remote: string;
  ref: string;
  commit: string;
  license: {
    spdx: string | null;
    package_json_field: string | null;
    license_file: string | null;
  };
  filters: {
    max_file_bytes: number;
    max_text_source_bytes: number;
    ignored_dirs: string[];
    excluded_binary: number;
    excluded_oversized: number;
  };
  file_count: number;
  total_bytes: number;
  files: ManifestFile[];
}

/** 默认忽略目录（构建产物、依赖、IDE 缓存等，不含源码） */
const IGNORED_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage",
  ".git", ".github-workflow-tmp", ".idea", ".vscode", ".cache",
]);

/** 常见二进制扩展名（命中即排除，不再读内容检测） */
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "svgz", "tiff",
  "mp3", "mp4", "wav", "ogg", "flac", "aac", "mov", "avi", "mkv", "webm",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "exe", "dll", "dylib", "so", "bin", "obj", "class", "jar", "wasm",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "woff", "woff2", "ttf", "otf", "eot",
  "sqlite", "db", "pak", "asar",
]);

/** 常见 SPDX 许可证名（用于从 LICENSE 文本猜测标识） */
const SPDX_PATTERNS: Array<[string, RegExp]> = [
  ["MIT", /\bMIT License\b/i],
  ["Apache-2.0", /\bApache License\b.*\bVersion 2\b|\bApache-2\.0\b/i],
  ["GPL-3.0-only", /\bGNU GENERAL PUBLIC LICENSE\b.*\bVersion 3\b/is],
  ["GPL-2.0-only", /\bGNU GENERAL PUBLIC LICENSE\b.*\bVersion 2\b/is],
  ["BSD-3-Clause", /\bRedistribution and use in source and binary forms\b/i],
  ["ISC", /\bISC License\b/i],
  ["MPL-2.0", /\bMozilla Public License\b.*\bVersion 2\b/is],
  ["PolyForm-Noncommercial-1.0.0", /\bPolyForm Noncommercial\b.*\b1\.0\.0\b/is],
  ["Unlicense", /\bThis is free and unencumbered software released into the public domain\b/i],
  ["CC-BY-4.0", /\bCreative Commons Attribution 4\.0\b/i],
];

const MAX_FILE_BYTES = 512 * 1024;
/** 文本源码扩展名：真实源码可能很大（如单文件服务），上限放宽到 2MB，避免误杀 */
const TEXT_SOURCE_EXT = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md", "html", "css", "scss",
  "yml", "yaml", "sh", "py", "txt", "xml", "toml",
]);
const MAX_TEXT_SOURCE_BYTES = 2 * 1024 * 1024;

function isIgnoredDir(relPath: string): boolean {
  return relPath.split("/").some((seg) => IGNORED_DIRS.has(seg));
}

function looksBinary(absPath: string): boolean {
  // 读前 8KB，含 NUL 字节视为二进制
  const fd = readFileSync(absPath);
  const head = fd.subarray(0, 8192);
  return head.includes(0);
}

/** 检测许可证：LICENSE/COPYING 文件 + package.json 字段 */
function detectLicense(repoDir: string, trackedFiles: string[]): Manifest["license"] {
  const licenseFile = trackedFiles.find((f) => {
    const name = path.basename(f).toLowerCase();
    return /^(license|licence|copying|notice)(\.[^.]+)?$/.test(name);
  });

  let fromFile: string | null = null;
  if (licenseFile) {
    try {
      const text = readFileSync(path.join(repoDir, licenseFile), "utf-8").slice(0, 4096);
      const hit = SPDX_PATTERNS.find(([, re]) => re.test(text));
      if (hit) fromFile = hit[0];
    } catch {
      // 许可证文件读取失败（编码异常）时跳过文件检测
    }
  }

  let fromPackageJson: string | null = null;
  const pkgFile = trackedFiles.find((f) => f === "package.json");
  if (pkgFile) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(repoDir, pkgFile), "utf-8"));
      if (typeof pkg.license === "string") fromPackageJson = pkg.license;
    } catch {
      // package.json 非法 JSON 时跳过
    }
  }

  // 优先 package.json 显式声明，其次文件内容猜测
  return {
    spdx: fromPackageJson ?? fromFile,
    package_json_field: fromPackageJson,
    license_file: licenseFile ?? null,
  };
}

/** 遍历被跟踪文件，应用过滤规则，生成确定性清单 */
export function buildManifest(handle: RepositoryHandle, ref: string): Manifest {
  const { repoDir, commit } = handle;

  // git ls-files -s 输出：<mode> <sha> <stage>\t<path>
  const out = execFileSync("git", ["ls-files", "-s"], {
    cwd: repoDir,
    encoding: "utf-8",
  });

  const files: ManifestFile[] = [];
  let excludedBinary = 0;
  let excludedOversized = 0;
  const ignoredDirs = new Set<string>();

  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [meta, filePath] = line.split("\t");
    const [, blobSha] = meta.split(" ");
    if (!filePath || !blobSha) continue;

    if (isIgnoredDir(filePath)) {
      const firstSeg = filePath.split("/").find((s) => IGNORED_DIRS.has(s));
      if (firstSeg) ignoredDirs.add(firstSeg);
      continue;
    }

    const absPath = path.join(repoDir, filePath);
    let size = 0;
    try {
      size = readFileSync(absPath).byteLength;
    } catch {
      continue; // 文件读取失败（符号链接断裂等）直接跳过
    }

    const ext = path.extname(filePath).slice(1).toLowerCase();
    const sizeLimit = TEXT_SOURCE_EXT.has(ext) ? MAX_TEXT_SOURCE_BYTES : MAX_FILE_BYTES;
    if (size > sizeLimit) {
      excludedOversized++;
      continue;
    }

    if (BINARY_EXT.has(ext) || looksBinary(absPath)) {
      excludedBinary++;
      continue;
    }

    files.push({ path: filePath, bytes: size, blob_sha: blobSha });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const tracked = out.split("\n")
    .map((l) => l.split("\t")[1])
    .filter(Boolean);

  return {
    schema_version: "1.0",
    repository: handle.repoId,
    remote: handle.remote,
    ref,
    commit,
    license: detectLicense(repoDir, tracked),
    filters: {
      max_file_bytes: MAX_FILE_BYTES,
      max_text_source_bytes: MAX_TEXT_SOURCE_BYTES,
      ignored_dirs: [...ignoredDirs].sort(),
      excluded_binary: excludedBinary,
      excluded_oversized: excludedOversized,
    },
    file_count: files.length,
    total_bytes: files.reduce((s, f) => s + f.bytes, 0),
    files,
  };
}
