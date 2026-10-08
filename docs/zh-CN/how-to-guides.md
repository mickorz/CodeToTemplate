# 操作指南

一个常见任务一节，按步骤执行。

## 采集一个 GitHub 仓库

场景：为目标仓库建立本地清单。

```bash
npm run collect -- --repo https://github.com/owner/repo --ref main --output ./cache/manifests/owner__repo
```

预期：输出目录生成 `repository-manifest.json`。

## 构建符号与依赖索引

场景：基于已有清单生成 source-map。

```bash
npm run analyze -- --manifest ./cache/manifests/owner__repo/repository-manifest.json --output ./cache/index/owner__repo
```

前提：对应仓库已在 `cache/repos/` 有本地缓存（collect 阶段产生）。

## 追踪两个文件间的依赖路径

场景：断言 A 文件到 B 文件依赖可达（测试用退出码判定）。

```bash
node src/cli.ts trace --sourcemap <source-map.json> --from <fileA> --to <fileB>
```

## 生成知识库文档

场景：完整管道产出文档。

```bash
npm run discover   # 模块发现
npm run generate   # 渲染并发布到 knowledge/
```

## 校验知识库证据

场景：用 gold-set 断言验证产物可信度。

```bash
npm run verify
```

预期：全部断言通过，退出码 0。
