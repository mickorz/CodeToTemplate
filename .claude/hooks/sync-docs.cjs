#!/usr/bin/env node
/**
 * 文档同步 Hook (Claude Code PostToolUse)
 *
 * 作用：把项目内的 Markdown 文档（新增 / 修改 / 删除）
 *      自动镜像到 Obsidian 知识库的 40_Projects/<项目名>/ 目录下。
 *
 * 触发：由 .claude/settings.local.json 的 PostToolUse hook 调用，
 *      匹配 Write|Edit|MultiEdit（新增 / 修改）与 Bash（删除）。
 *
 * 目标路径解析顺序：
 *   1. OBSIDIAN_DOCS_ROOT 环境变量 = 完整路径（最高优先级，跳过自动检测）
 *   2. obsidian vault 命令自动获取 vault 根 → 拼接 40_Projects/<项目名>/
 *      - 项目名：命令行参数 > SYNC_DOCS_PROJECT_NAME 环境变量 > 项目目录名
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
 * 本脚本不含任何机器特定路径，便于随仓库共享。
 * vault 根目录通过 obsidian vault 命令自动获取，无需手动配置。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ===== 配置区 =====
// 仓库根（脚本位于 <root>/.claude/hooks/，向上两级）
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DOC_EXT = '.md';
const VERBOSE = !!process.env.SYNC_DOCS_VERBOSE;
// 需排除的子目录（相对仓库根的任一层级匹配）
const EXCLUDE_DIRS = [
    '.git',
    'node_modules',
    'dist',
    ...(process.env.SYNC_DOCS_EXCLUDE
        ? process.env.SYNC_DOCS_EXCLUDE.split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : []),
];
// vault 内的项目存放目录
const VAULT_PROJECTS_DIR = '40_Projects';
// ==================

const log = (...a) => {
    if (VERBOSE) console.log('[文档同步]', ...a);
};

// 自动检测 Obsidian vault 根目录
// 优先级：OBSIDIAN_VAULT_ROOT 环境变量 > obsidian vault 命令输出
function detectVaultRoot() {
    if (process.env.OBSIDIAN_VAULT_ROOT) return process.env.OBSIDIAN_VAULT_ROOT;
    try {
        const output = execSync('obsidian vault', {
            encoding: 'utf8',
            timeout: 5000,
            stdio: 'pipe',
        });
        // 输出格式：name<TAB或空格>vault名\npath<TAB或空格>路径\n...
        const match = output.match(/^path\s+(.+)$/m);
        return match ? match[1].trim() : null;
    } catch {
        return null;
    }
}

// 解析 Obsidian 同步目标根目录
function resolveObsidianRoot(projectNameOverride) {
    // 1. 完整路径（最高优先级，跳过自动检测）
    if (process.env.OBSIDIAN_DOCS_ROOT) return process.env.OBSIDIAN_DOCS_ROOT;

    // 2. 自动检测 vault 根 → 拼接 40_Projects/<项目名>/
    const vaultRoot = detectVaultRoot();
    if (vaultRoot) {
        const name =
            projectNameOverride ||
            process.env.SYNC_DOCS_PROJECT_NAME ||
            path.basename(PROJECT_ROOT);
        return path.join(vaultRoot, VAULT_PROJECTS_DIR, name);
    }

    return '';
}

// 命令行参数 = 可选的项目名覆盖（不再是完整路径）
const OBSIDIAN_ROOT = resolveObsidianRoot(process.argv[2] || '');

// 读取 stdin（带超时保险，防止异常情况下挂起阻塞工具）
function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let done = false;
        const finish = () => {
            if (!done) {
                done = true;
                resolve(data);
            }
        };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (data += c));
        process.stdin.on('end', finish);
        setTimeout(finish, 3000); // 3 秒超时
    });
}

// 计算 absPath 相对仓库根的路径（正斜杠）；不在仓库内返回 null
function toRel(absPath) {
    if (!absPath) return null;
    const rel = path.relative(PROJECT_ROOT, absPath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
}

// 是否为应跟踪的项目内 .md 文档
function isTrackable(absPath) {
    if (!absPath || !absPath.toLowerCase().endsWith(DOC_EXT)) return false;
    const rel = toRel(absPath);
    if (!rel) return false;
    const parts = rel.split('/');
    if (parts.some((p) => EXCLUDE_DIRS.includes(p))) return false;
    return true;
}

function ensureDirFor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// 新增 / 修改：复制到 Obsidian
function syncFile(absPath) {
    if (!isTrackable(absPath)) return false;
    if (!fs.existsSync(absPath)) return false; // 源已不存在
    const rel = toRel(absPath);
    const dest = path.join(OBSIDIAN_ROOT, ...rel.split('/'));
    ensureDirFor(dest);
    fs.copyFileSync(absPath, dest);
    log('sync ->', dest);
    return true;
}

// 删除：从 Obsidian 移除（做范围校验，避免越界删除）
function removeFile(absPath) {
    const rel = toRel(absPath);
    if (!rel) return false; // 必须在仓库范围内
    if (!rel.toLowerCase().endsWith(DOC_EXT)) return false;
    const dest = path.join(OBSIDIAN_ROOT, ...rel.split('/'));
    if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
        log('delete ->', dest);
        return true;
    }
    return false;
}

// 从 Bash 命令中尽力提取被删除的 .md 路径
function extractDeletedDocs(command) {
    if (!command) return [];
    // 仅在命令含删除意图时处理
    if (!/(\brm\b|\bdel\b|Remove-Item)/i.test(command)) return [];
    const files = [];
    // 提取所有 .md 结尾的 token（去掉首尾引号）
    const re = /([^\s'";|&<>]+\.md)/gi;
    let m;
    while ((m = re.exec(command)) !== null) {
        files.push(m[1].replace(/^['"]|['"]$/g, ''));
    }
    return files;
}

async function main() {
    if (!OBSIDIAN_ROOT) {
        console.error(
            '[文档同步] 无法确定 Obsidian 目标路径。请确保已安装 obsidian CLI（运行 obsidian vault 验证），或设置 OBSIDIAN_DOCS_ROOT 环境变量。本次跳过'
        );
        return;
    }
    log('目标路径:', OBSIDIAN_ROOT);
    const raw = await readStdin();
    if (!raw || !raw.trim()) return;
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return; // 非 JSON 输入，忽略
    }
    const tool = payload.tool_name;
    const input = payload.tool_input || {};

    try {
        if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
            const fp = input.file_path;
            if (fp) syncFile(path.resolve(fp));
        } else if (tool === 'Bash') {
            const cmd = input.command || '';
            for (const f of extractDeletedDocs(cmd)) {
                const abs = path.isAbsolute(f)
                    ? f
                    : path.resolve(PROJECT_ROOT, f);
                removeFile(abs);
            }
        }
    } catch (e) {
        console.error('[文档同步] 发生错误:', e.message);
    }
}

main();
