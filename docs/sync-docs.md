# 文档同步插件

把项目内值得存档的 Markdown 文档自动镜像到 Obsidian 知识库的 `40_Projects/<项目名>/` 目录下，按文档类型分类存放，不值得存档的自动跳过。

## 工作原理

```
项目仓库 (.md 文件)
        │
        ▼  读取内容 → 路径分类 + 质量过滤
        │
        ├─ 值得存档 → Obsidian vault / 40_Projects / <项目名> /
        │   ├─ CLAUDE.md              根目录文档
        │   ├─ docs/...               L1 读者向文档（镜像路径）
        │   └─ experience/...         L3 跨项目经验（来自 dev-docs/experience/）
        │
        └─ 不值得 / L2 过程文档 → 跳过（留 Git）
```

vault 根目录通过 `obsidian vault` 命令自动获取，项目名取项目目录名，**无需手动配置任何路径**。

## 文档分类（3 层模型）

| 层级 | 说明 | 源路径 | 同步? | Obsidian 目标 |
|------|------|--------|-------|--------------|
| L1 工程知识 | 当前有效：架构、模块设计、接口规范 | `docs/**` | 是 | 镜像原路径 |
| L1 项目规范 | 项目级文档 | 根目录 `CLAUDE.md`/`README.md`/`AGENTS.md` | 是 | 根目录 |
| L2 开发过程 | 可追溯：需求、计划、进度、报告 | `dev-docs/design`、`meeting`、`planning`、`progress` 等 | 否 | 留 Git |
| L3 经验知识 | 跨项目复用：踩坑、通用方案 | `dev-docs/experience/**` | 是 | `experience/` |

> L2 过程文档（开发计划、会议记录、执行报告等）是项目特定的，留 Git 可追溯，不进 Obsidian。
> 只有 L3 经验知识具有跨项目复用价值，才同步到 Obsidian。

### 内容质量过滤

同步前会读取文档内容，以下情况自动跳过：

- 空文件或内容 < 100 字符（占位文件）
- 纯模板骨架（去掉 `{{占位符}}` 和 HTML 注释后无实质内容）
- 有效内容 < 3 行
- 内容全为 TODO / 待填充 / TBD 标记

## 支持的 AI 编程工具

| 工具 | 脚本路径 | 触发机制 |
|------|----------|----------|
| Claude Code | `.claude/hooks/sync-docs.cjs` | PostToolUse hook（stdin JSON） |
| OpenCode | `.opencode/plugins/sync-docs.js` | `tool.execute.after` 钩子 |

两套实现共享同一套分类与过滤逻辑，只是接入方式不同。可按需只启用其中一套。

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
| `SYNC_DOCS_DEV_DIRS` | 否 | dev-docs 下需同步的子目录（默认 `experience`，可设 `experience,troubleshooting`） |
| `SYNC_DOCS_VERBOSE` | 否 | 设为 `1` 输出同步与跳过日志 |

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

## Obsidian 目标结构示例

```
<vault根>/40_Projects/<项目名>/
├── CLAUDE.md                    # 项目规范（来自根目录）
├── README.md                    # 项目概述
├── AGENTS.md                    # Agent规范（如有）
├── docs/                        # L1 读者向文档（镜像 docs/）
│   ├── getting-started.md
│   ├── sync-docs.md
│   └── architecture/
│       └── overview.md
└── experience/                  # L3 跨项目经验（来自 dev-docs/experience/）
    ├── llm-timeout.md
    └── node-version-conflict.md
```

## 注意事项

- 需本机安装 obsidian CLI 并能运行 `obsidian vault`，否则需手动设置 `OBSIDIAN_VAULT_ROOT` 或 `OBSIDIAN_DOCS_ROOT`
- `settings.local.json` 含机器特定配置，**不进 git**，换机器需各自复制
- 修改 hook 脚本或插件后，Claude Code 需重启会话让 hook 生效
- OpenCode 插件在启动时自动加载，修改后重启即可
- L2 过程文档不进 Obsidian 是设计决策，如需同步额外子目录，设 `SYNC_DOCS_DEV_DIRS` 环境变量
