# 迁移实验工件归档（P2-3 三轮 + 元数据）

## 运行元数据

| 项 | 值 |
| --- | --- |
| Coding Agent | opencode 1.18.35（stdio run，默认模型配置） |
| CodeToTemplate | v0.2 基线（P2 各轮提交号见各组目录） |
| 知识库 commit | p-queue 180ab9e25c / bottleneck b83528333b / y-protocols 73b2ff7548 |
| 验收方式 | node --test（显性 + 隐藏双层，测试文件在每组 shared/） |

## 目录

- round1-scheduler/：第一轮 A/B（任务调度器，5/5）
- round2-limiter/：第二轮 A/B/C（令牌桶限流器，隐藏测试 5 项，9/9）
- pre03-presence/：预实验 03（Presence CRDT，契约 4 + 特有 5，9/9）

各组含：prompt*.txt（A/B/C 提示词）、*-run.log（Agent 运行日志）、workspace-*/src（实现产物）、shared（验收测试）、opencode.json（B 组 MCP 配置）。

复现说明：B 组需先构建对应知识库（collect→generate→review→catalog），MCP server 指向本仓库 knowledge/。Token 用量 opencode 未输出（记录缺失）。
