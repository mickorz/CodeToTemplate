/**
 * git.ts —— 仓库采集：Clone 或复用本地缓存，并锁定 Commit
 *
 * 采集流程：
 *
 * resolveRepository(url, ref)
 *     ├─> repoId = owner/name（从 URL 解析）
 *     ├─> cache/repos/<repoId> 已存在？
 *     │     ├─ 是 -> git fetch --all --tags（更新远端引用）
 *     │     └─ 否 -> gh repo clone <repoId>（GitHub CLI 克隆，自动处理认证）
 *     ├─> git rev-parse <ref>^{commit}   解析为完整 Commit SHA
 *     ├─> git checkout --detach <sha>    锁定到该 Commit（只读分析）
 *     └─> 返回 { repoDir, commit, remote }
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface RepositoryHandle {
  /** 本地仓库目录（缓存内） */
  repoDir: string;
  /** 锁定的完整 Commit SHA（40 位） */
  commit: string;
  /** 远端地址 */
  remote: string;
  /** owner/name 形式的仓库标识 */
  repoId: string;
  /** 是否为本次新克隆 */
  cloned: boolean;
}

/** 从任意 GitHub URL 解析 owner/name */
export function parseRepoId(repoUrl: string): string {
  // 支持 https://github.com/owner/name.git、https://github.com/owner/name、owner/name
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?(?:\/|$)/i);
  if (m) return `${m[1]}/${m[2]}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(repoUrl)) return repoUrl;
  throw new Error(`无法从 URL 解析仓库标识: ${repoUrl}`);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * 采集仓库并锁定 Commit。
 * 已有缓存则 fetch 后 checkout 指定 ref，实现「同一 ref 可复用，同一 commit 结果确定」。
 */
export function resolveRepository(
  repoUrl: string,
  ref: string,
  cacheRoot: string,
): RepositoryHandle {
  const repoId = parseRepoId(repoUrl);
  const repoDir = path.join(cacheRoot, "repos", repoId.replace("/", "__"));
  const remote = repoUrl.startsWith("http") || repoUrl.includes("://") ? repoUrl : `https://github.com/${repoId}`;

  let cloned = false;
  if (existsSync(path.join(repoDir, ".git"))) {
    console.log(`[采集] 复用本地缓存: ${repoDir}，执行 fetch 更新`);
    git(["fetch", "--all", "--tags", "--prune"], repoDir);
  } else {
    mkdirSync(path.dirname(repoDir), { recursive: true });
    console.log(`[采集] 克隆仓库: ${repoId} -> ${repoDir}`);
    // 项目约定：克隆一律走 gh（GitHub CLI），认证由 gh 托管
    execFileSync("gh", ["repo", "clone", repoId, repoDir], { stdio: "inherit" });
    cloned = true;
  }

  // 解析 ref 为完整 Commit SHA（支持 branch、tag、SHA）
  const commit = git(["rev-parse", `${ref}^{commit}`], repoDir);
  if (commit.length !== 40) {
    throw new Error(`ref "${ref}" 未解析为有效 Commit: ${commit}`);
  }

  // 锁定到该 Commit（detach，保证后续文件读取内容与 SHA 一一对应）
  git(["checkout", "--detach", commit], repoDir);
  console.log(`[采集] 已锁定 Commit: ${commit}`);

  return { repoDir, commit, remote, repoId, cloned };
}
