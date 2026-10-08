# 配置参考

本项目为私有 CLI 工具（`"private": true`），无独立配置文件，配置通过各子命令的命令行参数传入。

## 命令与参数

| 命令 | 参数 | 说明 |
|------|------|------|
| `npm run collect` | `--repo <url>` `--ref <ref>` `--output <dir>` | M1 采集：clone 仓库并生成 repository-manifest.json |
| `npm run analyze` | `--manifest <path>` `--output <dir>` | M2 分析：基于清单与本地缓存仓库生成符号/依赖索引 |
| `npm run trace` | `--sourcemap <path>` `--from <file>` `--to <file>` | 依赖追踪：BFS 断言两文件可达性（退出码 0/1） |
| `npm run discover` | 见 `src/cli.ts` 帮助注释 | 模块发现 |
| `npm run generate` | 见 `src/cli.ts` 帮助注释 | 渲染并发布知识库文档 |
| `npm run verify` | `<knowledgeDir> <repoDir> <assertions.json>` | 用 gold-set 断言校验知识库证据 |

## 缓存与产物位置

- `cache/` —— 采集阶段 clone 的仓库本地缓存
- `knowledge/` —— 知识库文档输出目录

## 升级

依赖升级：编辑 `package.json` 后重新 `npm install`（本项目 devDependencies 仅 typescript 与 @types/node）。

## 卸载

删除项目目录即可；缓存与产物均在项目目录内，无全局残留。
