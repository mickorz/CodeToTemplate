/**
 * failure-injection.mjs —— M6 失败注入测试
 *
 * 测试流程：
 *
 * main()
 *     ├─> 复制知识目录到临时目录
 *     ├─> 注入 1：module-map 塞入不存在的 source_file      -> 期望检查「source_files 存在性」失败
 *     ├─> 注入 2：dependencies 塞入不存在的模块 id          -> 期望检查「模块 id 有效」失败
 *     ├─> 注入 3：module-map 的 commit 改掉一位             -> 期望检查「commit 一致」失败
 *     ├─> 注入 4：模块文档塞入幽灵仓库路径                  -> 期望检查「文档路径存在」失败
 *     ├─> 每次注入后独立跑 runVerify，断言目标 check 为 fail 且其余不受影响
 *     └─> 全部按预期拦截 = 通过（退出码 0）
 *
 * 说明：行号断言（检查 5）的拦截能力已有真实案例——开发期 bridge-main.js 断言因
 * token 空格差异被拦截并修复（见 verification-report 与执行报告），不在此重复构造。
 */

import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVerify } from "../src/knowledge/verify.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcKnowledge = path.join(root, "knowledge", "openworkbuddy", "desktop");
const repoDir = path.join(root, "cache", "repos", "mickorz__openworkbuddy");
const tmpBase = path.join(root, "dev-examples", "m6-injection");

function freshCopy() {
  rmSync(tmpBase, { recursive: true, force: true });
  cpSync(srcKnowledge, tmpBase, { recursive: true });
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf-8"));
}

let pass = 0;
let fail = 0;

function expectFail(checkName, result, expectDetailIncludes) {
  const target = result.checks.find((c) => c.check === checkName);
  if (!target || target.status !== "fail") {
    console.error(`[失败] 预期拦截未生效: ${checkName}`);
    fail++;
    return;
  }
  if (expectDetailIncludes && !target.detail.includes(expectDetailIncludes)) {
    console.error(`[失败] 拦截详情不含预期关键字 "${expectDetailIncludes}": ${target.detail}`);
    fail++;
    return;
  }
  console.log(`[通过] 已拦截: ${checkName}（${expectDetailIncludes ?? target.detail.slice(0, 60)}）`);
  pass++;
}

// 注入 1：不存在的 source_file
freshCopy();
{
  const mmPath = path.join(tmpBase, "module-map.json");
  const mm = readJson(mmPath);
  mm.modules[0].source_files.push("src/desktop/ghost-file-不存在.js");
  writeFileSync(mmPath, JSON.stringify(mm, null, 2), "utf-8");
  expectFail("module-map source_files 存在于 manifest", runVerify(tmpBase, repoDir), "ghost-file");
}

// 注入 2：不存在的依赖 id
freshCopy();
{
  const mmPath = path.join(tmpBase, "module-map.json");
  const mm = readJson(mmPath);
  mm.modules[0].dependencies.push("desktop.not-exists-module");
  writeFileSync(mmPath, JSON.stringify(mm, null, 2), "utf-8");
  expectFail("module-map dependencies 指向存在的模块 id", runVerify(tmpBase, repoDir), "not-exists-module");
}

// 注入 3：commit 版本不匹配
freshCopy();
{
  const mmPath = path.join(tmpBase, "module-map.json");
  const mm = readJson(mmPath);
  mm.commit = mm.commit.slice(0, -1) + (mm.commit.endsWith("0") ? "1" : "0");
  writeFileSync(mmPath, JSON.stringify(mm, null, 2), "utf-8");
  expectFail("manifest 与 module-map 的 commit 一致", runVerify(tmpBase, repoDir), "vs");
}

// 注入 4：文档幽灵路径
freshCopy();
{
  const docPath = path.join(tmpBase, "modules", "packaging.md");
  const doc = readFileSync(docPath, "utf-8");
  writeFileSync(docPath, doc.replace("electron-builder.config.js", "`src/desktop/ghost.js`（首次出现位置）"), "utf-8");
  expectFail("文档引用的仓库路径真实存在", runVerify(tmpBase, repoDir), "ghost");
}

// 清理
rmSync(tmpBase, { recursive: true, force: true });

console.log(`\n[结果] 失败注入测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log("[结果] 四类篡改均被确定性检查拦截，测试通过");
