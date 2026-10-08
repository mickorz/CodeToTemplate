# 快速开始

CodeToTemplate（code-to-knowledge）把 GitHub 仓库源码提取为带证据、可复用的技术知识库文档。

## 前提条件

- Node.js 22.6+（项目直接以 `node src/cli.ts` 运行 TypeScript，依赖原生类型剥离；低于 23.6 的版本需确认 `--experimental-strip-types` 可用）
- git（采集阶段需要 clone 目标仓库）

## 安装

```bash
git clone <本仓库地址> CodeToTemplate
cd CodeToTemplate
npm install
```

## 验证

```bash
npm run typecheck
```

无输出即类型检查通过。

## 第一次运行

按管道顺序采集并分析一个 GitHub 仓库：

```bash
npm run collect -- --repo <github 仓库地址> --ref <分支或 tag> --output <输出目录>
npm run analyze -- --manifest <输出目录>/repository-manifest.json --output <索引输出目录>
```

产物为仓库清单（repository-manifest.json）与符号/依赖索引（source-map）。

## 下一步

- 各命令参数详见 [配置参考](configuration.md)
- 完整管道（discover / generate / verify）见 [操作指南](how-to-guides.md)
- 安装或运行异常见 [常见问题排查](troubleshooting.md)
