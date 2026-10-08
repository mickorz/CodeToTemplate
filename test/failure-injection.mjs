/**
 * failure-injection.mjs —— 失败注入测试（P1-0 起完全自包含）
 *
 * 测试流程：
 *
 * main()
 *     ├─> 冒烟：fixture（test/fixtures/mini-*）原样跑 runVerify，应全过
 *     ├─> 注入 1：module-map 塞入不存在的 source_file  -> 检查「source_files 存在性」拦截
 *     ├─> 注入 2：dependencies 塞入不存在的模块 id      -> 检查「模块 id 有效」拦截
 *     ├─> 注入 3：module-map 的 commit 改一位           -> 检查「commit 一致」拦截
 *     ├─> 注入 4：模块文档塞入幽灵仓库路径              -> 检查「文档路径存在」拦截
 *     ├─> 注入 5：断言数据塞入越界行号与错误 token      -> 检查「行号断言」拦截
 *     └─> 全部按预期拦截 = 通过（退出码 0）；不依赖 cache/ 与 knowledge/
 */

import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVerify } from "../src/knowledge/validator.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureKnowledge = path.join(here, "fixtures", "mini-knowledge");
const fixtureRepo = path.join(here, "fixtures", "mini-repo");
const fixtureAssertions = JSON.parse(readFileSync(path.join(here, "fixtures", "mini-assertions.json"), "utf-8"));
const tmp = path.resolve(here, "..", "dev-examples", "p1-injection");

let pass = 0;
let fail = 0;

function freshCopy() {
  rmSync(tmp, { recursive: true, force: true });
  cpSync(fixtureKnowledge, tmp, { recursive: true });
}

function expectCheck(checkName, expectStatus, result, expectDetailIncludes) {
  const target = result.checks.find((c) => c.check === checkName);
  if (!target || target.status !== expectStatus) {
    console.error(`[失败] 预期 ${expectStatus} 未生效: ${checkName}（实际 ${target ? target.status : "无此检查"}）`);
    fail++;
    return;
  }
  if (expectDetailIncludes && !target.detail.includes(expectDetailIncludes)) {
    console.error(`[失败] 详情不含 "${expectDetailIncludes}": ${target.detail}`);
    fail++;
    return;
  }
  console.log(`[通过] ${expectStatus === "fail" ? "已拦截" : "冒烟通过"}: ${checkName}${expectDetailIncludes ? `（${expectDetailIncludes}）` : ""}`);
  pass++;
}

// 冒烟：fixture 原样应全过
freshCopy();
{
  const result = runVerify(tmp, fixtureRepo, fixtureAssertions);
  for (const c of result.checks) {
    if (c.status !== "pass") {
      console.error(`[失败] 冒烟不应失败: ${c.check}: ${c.detail}`);
      fail++;
    }
  }
  expectCheck("关键行号断言（基准数据）", "pass", result, "2 条断言全部命中");
}

// 注入 1：不存在的 source_file
freshCopy();
{
  const p = path.join(tmp, "module-map.json");
  const mm = JSON.parse(readFileSync(p, "utf-8"));
  mm.modules[0].source_files.push("src/ghost-不存在.js");
  writeFileSync(p, JSON.stringify(mm, null, 2), "utf-8");
  expectCheck("module-map source_files 存在于 manifest", "fail", runVerify(tmp, fixtureRepo, fixtureAssertions), "ghost");
}

// 注入 2：不存在的依赖 id
freshCopy();
{
  const p = path.join(tmp, "module-map.json");
  const mm = JSON.parse(readFileSync(p, "utf-8"));
  mm.modules[0].dependencies.push("test.not-exists");
  writeFileSync(p, JSON.stringify(mm, null, 2), "utf-8");
  expectCheck("module-map dependencies 指向存在的模块 id", "fail", runVerify(tmp, fixtureRepo, fixtureAssertions), "not-exists");
}

// 注入 3：commit 篡改
freshCopy();
{
  const p = path.join(tmp, "module-map.json");
  const mm = JSON.parse(readFileSync(p, "utf-8"));
  mm.commit = mm.commit.slice(0, -1) + "9";
  writeFileSync(p, JSON.stringify(mm, null, 2), "utf-8");
  expectCheck("manifest 与 module-map 的 commit 一致", "fail", runVerify(tmp, fixtureRepo, fixtureAssertions), "vs");
}

// 注入 4：文档幽灵路径
freshCopy();
{
  const p = path.join(tmp, "modules", "supervisor.md");
  const doc = readFileSync(p, "utf-8");
  writeFileSync(p, doc.replace("`src/supervisor.js`", "`src/ghost.js`"), "utf-8");
  expectCheck("文档引用的仓库路径真实存在", "fail", runVerify(tmp, fixtureRepo, fixtureAssertions), "ghost");
}

// 注入 5：断言数据篡改（越界行号 + 错误 token）
freshCopy();
{
  const badAssertions = [
    ...fixtureAssertions,
    { file: "src/supervisor.js", from: 99, to: 120, tokens: ["module.exports"], claim: "越界行号" },
    { file: "entry.js", from: 1, to: 5, tokens: ["不存在的函数名"], claim: "错误 token" },
  ];
  expectCheck("关键行号断言（基准数据）", "fail", runVerify(tmp, fixtureRepo, badAssertions), "越界行号");
}

rmSync(tmp, { recursive: true, force: true });

console.log(`\n[结果] 失败注入测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log("[结果] 冒烟 1 + 五类篡改全部按预期拦截，测试通过（自包含，无需 cache/knowledge）");
