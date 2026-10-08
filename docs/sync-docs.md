# 文档同步插件

把项目内的 Markdown 文档（新增 / 修改 / 删除）自动镜像到 Obsidian 知识库的 `40_Projects/<项目名>/` 目录下。

## 工作原理

```
项目仓库 (.md 文件)
        │
        ▼  自动镜像
Obsidian vault / 40_Projects / <项目名> /
        │
        ├─ CLAUDE.md
        ├─ README.md
        └─ docs/...
```

vault 根目录通过 `obsidian vault` 命令自动获取，项目名取项目目录名，**无需手动配置任何路径**。

## 支持的 AI 编程工具

| 工具 | 脚本路径 | 触发机制 |
|------|----------|----------|
| Claude Code | `.claude/hooks/sync-docs.cjs` | PostToolUse hook（stdin JSON） |
| OpenCode | `.opencode/plugins/sync-docs.js` | `tool.execute.after` 钩子 |

两套实现共享同一套同步逻辑，只是接入方式不同。可按需只启用其中一套。

## 配置

### 零配置（推荐）

只要本机已安装 obsidian CLI（运行 `obsidian vault` 能输出 vault 信息），插件开箱即用：

- vault 根：自动从 `obsidian vault` 输出的 `path` 字段获取
- 项目名：取项目目录名
- 目标路径：`<vault根>/40_Projects/<项目名>/`

### 环境变量（可选覆盖）

| 变量 | 必填 | 说明 |
|------|------|------|
| `OBSIDIAN_VAULT_ROOT` | 否 | 覆盖 vault 根目录（obsidian CLI 不可用时使用） |
| `SYNC_DOCS_PROJECT_NAME` | 否 | 覆盖项目名（默认取项目目录名） |
| `OBSIDIAN_DOCS_ROOT` | 否 | 完整目标路径（最高优先级，跳过自动检测） |
| `SYNC_DOCS_EXCLUDE` | 否 | 追加排除目录，逗号分隔（如 `vendor,build`） |
| `SYNC_DOCS_VERBOSE` | 否 | 设为 `1` 输出同步日志 |

### Claude Code 配置

1. 复制 `.claude/settings.local.example.json` 为 `.claude/settings.local.json`
2. 默认无需修改，开箱即用
3. 如项目名与目录名不同，可在 command 末尾加项目名参数：
   ```json
   "command": "node .claude/hooks/sync-docs.cjs \"MyProjectName\""
   ```
4. `.claude/settings.local.json` 不进 git（已在 .gitignore 忽略）

### OpenCode 配置

无需任何配置，插件自动读取 `obsidian vault` 结果。如需覆盖项目名：

```bash
$env:SYNC_DOCS_PROJECT_NAME = "MyProjectName"
```

## 同步规则

- 仅同步 `.md` 文件
- 排除目录：`.git`、`node_modules`、`dist`（可通过 `SYNC_DOCS_EXCLUDE` 扩展）
- Obsidian 内保持相对仓库根的目录结构
- 新增 / 修改 → 复制；删除单个 `.md` → 移除；删目录 / 通配符需人工核对

## 注意事项

- 需本机安装 obsidian CLI 并能运行 `obsidian vault`，否则需手动设置 `OBSIDIAN_VAULT_ROOT` 或 `OBSIDIAN_DOCS_ROOT`
- `settings.local.json` 含机器特定配置，**不进 git**，换机器需各自复制
- 修改 hook 脚本或插件后，Claude Code 需重启会话让 hook 生效
- OpenCode 插件在启动时自动加载，修改后重启即可
