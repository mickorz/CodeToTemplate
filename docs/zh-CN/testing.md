# 安装与运行验收清单

## 概述

验收目标：环境可用、管道可跑通、产物可通过证据校验。

## 安装检查

- [ ] `node --version` 不低于 22.6
- [ ] `git --version` 可用
- [ ] `npm install` 无报错
- [ ] `npm run typecheck` 通过

## 冒烟测试

- [ ] `npm run collect -- --repo <小仓库> --ref main --output /tmp/smoke` 生成 manifest
- [ ] `npm run analyze -- --manifest /tmp/smoke/repository-manifest.json --output /tmp/smoke-idx` 生成索引
- [ ] `node src/cli.ts trace --sourcemap <索引> --from <A> --to <B>` 退出码符合预期

## 最终清单

- [ ] `npm test` 三套测试全绿
- [ ] `npm run verify` gold-set 断言全部通过
