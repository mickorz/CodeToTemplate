# 常见问题排查

## 安装问题

**`node src/cli.ts` 直接报语法错误 / 不认识 TypeScript 语法**

Node 版本过低。类型剥离要求 Node 22.6+（23.6 起默认开启），升级 Node 或确认运行参数。

**`npm install` 失败**

检查网络与 npm 源；本项目仅两个 devDependencies，通常为源问题。

## 运行问题

**collect 失败**

依次检查：目标仓库地址与 ref 是否存在；网络能否访问 GitHub；`cache/` 磁盘空间。

**analyze 报找不到仓库缓存**

analyze 依赖 `cache/repos/` 下的本地缓存，先完整执行对应仓库的 collect。

**verify 断言不通过**

产物与 gold-set 期望不符：检查 `knowledge/` 产物是否为最新 generate 产物、断言文件路径是否正确。

## 仍无法解决

到 `dev-docs/experience/` 检索历史踩坑记录；未有记录则在解决后按「现象 → 排查 → 根因 → 方案」沉淀新文档。
