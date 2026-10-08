/**
 * 文档同步插件 (OpenCode Plugin)
 *
 * 作用：把项目内的 Markdown 文档（新增 / 修改 / 删除）
 *      自动镜像到 Obsidian 知识库的 40_Projects/<项目名>/ 目录下。
 *
 * 触发：通过 tool.execute.after 钩子，在工具执行完成后介入。
 *      - write / edit 工具 → 复制 .md 到 Obsidian
 *      - bash 工具 → 解析删除命令，移除 Obsidian 侧对应文件
 *
 * 目标路径解析顺序：
 *   1. OBSIDIAN_DOCS_ROOT 环境变量 = 完整路径（最高优先级，跳过自动检测）
 *   2. obsidian vault 命令自动获取 vault 根 → 拼接 40_Projects/<项目名>/
 *      - 项目名：SYNC_DOCS_PROJECT_NAME 环境变量 > 项目目录名
 *   3. OBSIDIAN_VAULT_ROOT 环境变量 = 覆盖 vault 根（obsidian CLI 不可用时）
 *
 * 规则：
 *   - 仅同步 .md 文件
 *   - 排除 .git、node_modules、dist 等目录（可通过 SYNC_DOCS_EXCLUDE 扩展）
 *   - Obsidian 内保持相对仓库根的目录结构
 *
 * 可配置（环境变量）：
 *   - OBSIDIAN_VAULT_ROOT       覆盖 vault 根目录（默认运行 obsidian vault 自动获取）
 *   - SYNC_DOCS_PROJECT_NAME    覆盖项目名（默认取项目目录名）
 *   - OBSIDIAN_DOCS_ROOT        完整目标路径（最高优先级，跳过自动检测）
 *   - SYNC_DOCS_EXCLUDE         追加排除目录（逗号分隔，如 "vendor,build"）
 *   - SYNC_DOCS_VERBOSE=1       输出同步日志（默认静默）
 *
 * 本插件不含任何机器特定路径，便于随仓库共享。
 * vault 根目录通过 obsidian vault 命令自动获取，无需手动配置。
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// ===== 配置区 =====
const VERBOSE = !!process.env.SYNC_DOCS_VERBOSE;
const DOC_EXT = ".md";
const EXCLUDE_DIRS = [
  ".git",
  "node_modules",
  "dist",
  ...(process.env.SYNC_DOCS_EXCLUDE
    ? process.env.SYNC_DOCS_EXCLUDE.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : []),
];
// vault 内的项目存放目录
const VAULT_PROJECTS_DIR = "40_Projects";
// ==================

const log = (...a) => {
  if (VERBOSE) console.log("[文档同步]", ...a);
};

// 自动检测 Obsidian vault 根目录
function detectVaultRoot() {
  if (process.env.OBSIDIAN_VAULT_ROOT) return process.env.OBSIDIAN_VAULT_ROOT;
  try {
    const output = execSync("obsidian vault", {
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe",
    });
    const match = output.match(/^path\s+(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// 解析 Obsidian 同步目标根目录
function resolveObsidianRoot(projectRoot) {
  // 1. 完整路径（最高优先级，跳过自动检测）
  if (process.env.OBSIDIAN_DOCS_ROOT) return process.env.OBSIDIAN_DOCS_ROOT;

  // 2. 自动检测 vault 根 → 拼接 40_Projects/<项目名>/
  const vaultRoot = detectVaultRoot();
  if (vaultRoot) {
    const name =
      process.env.SYNC_DOCS_PROJECT_NAME || path.basename(projectRoot);
    return path.join(vaultRoot, VAULT_PROJECTS_DIR, name);
  }

  return "";
}

// 计算 absPath 相对仓库根的路径（正斜杠）；不在仓库内返回 null
function toRel(absPath, projectRoot) {
  if (!absPath) return null;
  const rel = path.relative(projectRoot, absPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

// 是否为应跟踪的项目内 .md 文档
function isTrackable(absPath, projectRoot) {
  if (!absPath || !absPath.toLowerCase().endsWith(DOC_EXT)) return false;
  const rel = toRel(absPath, projectRoot);
  if (!rel) return false;
  const parts = rel.split("/");
  if (parts.some((p) => EXCLUDE_DIRS.includes(p))) return false;
  return true;
}

function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// 新增 / 修改：复制到 Obsidian
function syncFile(absPath, projectRoot, obsidianRoot) {
  if (!isTrackable(absPath, projectRoot)) return false;
  if (!fs.existsSync(absPath)) return false;
  const rel = toRel(absPath, projectRoot);
  const dest = path.join(obsidianRoot, ...rel.split("/"));
  ensureDirFor(dest);
  fs.copyFileSync(absPath, dest);
  log("sync ->", dest);
  return true;
}

// 删除：从 Obsidian 移除（做范围校验，避免越界删除）
function removeFile(absPath, projectRoot, obsidianRoot) {
  const rel = toRel(absPath, projectRoot);
  if (!rel) return false;
  if (!rel.toLowerCase().endsWith(DOC_EXT)) return false;
  const dest = path.join(obsidianRoot, ...rel.split("/"));
  if (fs.existsSync(dest)) {
    fs.unlinkSync(dest);
    log("delete ->", dest);
    return true;
  }
  return false;
}

// 从 Bash 命令中尽力提取被删除的 .md 路径
function extractDeletedDocs(command) {
  if (!command) return [];
  if (!/(\brm\b|\bdel\b|Remove-Item)/i.test(command)) return [];
  const files = [];
  const re = /([^\s'";|&<>]+\.md)/gi;
  let m;
  while ((m = re.exec(command)) !== null) {
    files.push(m[1].replace(/^['"]|['"]$/g, ""));
  }
  return files;
}

// 尝试从工具参数中提取文件路径（兼容多种字段名）
function extractFilePath(args) {
  if (!args) return null;
  return args.filePath || args.file_path || args.path || args.file || null;
}

export const SyncDocsPlugin = async ({ directory, worktree }) => {
  // 项目根目录：优先用 directory，回退到 worktree
  const projectRoot = directory || worktree || process.cwd();
  const obsidianRoot = resolveObsidianRoot(projectRoot);

  if (!obsidianRoot) {
    console.error(
      "[文档同步] 无法确定 Obsidian 目标路径。请确保已安装 obsidian CLI（运行 obsidian vault 验证），或设置 OBSIDIAN_DOCS_ROOT 环境变量。插件已加载但跳过同步"
    );
    return {};
  }

  log("插件已加载，项目根:", projectRoot, "目标:", obsidianRoot);

  return {
    "tool.execute.after": async (input, output) => {
      try {
        const tool = (input && input.tool) || "";
        const args = (output && output.args) || {};
        const toolLower = String(tool).toLowerCase();

        // 写入 / 编辑类工具 → 同步文件
        if (
          toolLower === "write" ||
          toolLower === "edit" ||
          toolLower === "multiedit" ||
          toolLower === "str_replace_editor"
        ) {
          const fp = extractFilePath(args);
          if (fp) syncFile(path.resolve(fp), projectRoot, obsidianRoot);
          return;
        }

        // Bash 类工具 → 检测删除操作
        if (
          toolLower === "bash" ||
          toolLower === "shell" ||
          toolLower === "terminal"
        ) {
          const cmd = args.command || "";
          for (const f of extractDeletedDocs(cmd)) {
            const abs = path.isAbsolute(f)
              ? f
              : path.resolve(projectRoot, f);
            removeFile(abs, projectRoot, obsidianRoot);
          }
          return;
        }
      } catch (e) {
        console.error("[文档同步] 发生错误:", e.message);
      }
    },
  };
};

export default SyncDocsPlugin;
