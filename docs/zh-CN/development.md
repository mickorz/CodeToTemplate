# 贡献者指南

面向本项目贡献者。开发过程文档（设计、踩坑、进度）放 `dev-docs/`，不进 git。

## 环境与常用命令

- Node.js 22.6+，无构建步骤（源码直跑 TS）
- `npm run typecheck` —— tsc --noEmit 类型检查
- `npm test` —— 失败注入 + discovery 契约 + generate 契约三套测试

## 架构总览

```text
collect（collector）  ->  repository-manifest.json
analyze（analyzer）   ->  source-map 符号/依赖索引
discover（discovery） ->  模块发现（agent 参与）
generate（generate）  ->  渲染并发布知识库文档
verify（knowledge）   ->  gold-set 断言校验
```

`src/cli.ts` 为唯一命令行入口，子命令分派见文件头注释。

## 测试

```bash
npm test        # test/failure-injection + discovery-contract + generate-contract
npm run verify  # gold-set 断言（openworkbuddy 样例）
```

契约变更时同步更新 `test/` 下对应契约测试。

## 本地开发流程

1. 改动 `src/` 对应模块
2. `npm run typecheck` + `npm test`
3. 用一个小仓库跑通 `collect -> analyze` 冒烟
4. 过程文档按类型归档到 `dev-docs/`（分类见根目录 CLAUDE.md）

## 发布

项目当前为 private，无 npm 发布流程。
