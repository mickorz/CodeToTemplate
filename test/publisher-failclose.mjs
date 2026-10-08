/**
 * publisher-failclose.mjs —— Publisher fail-close 单测（P2-0a，自包含）
 *
 * 评审漏洞：三报告全缺失时 overall_passed 仍为 true。
 * 验收：
 *   1. 全缺失 + 默认必需集 -> overall=false（fail-close 修复生效）
 *   2. deterministic+review 均存在且 passed -> overall=true（e2e 缺席不阻断，按策略可选）
 *   3. review 缺失 -> overall=false
 *   4. review 存在但 passed=false -> overall=false
 *   5. 中间汇总模式（required 仅 deterministic）-> 不受 review 缺席影响，mode=partial
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publish } from "../src/generate/publisher.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.resolve(here, "..", "dev-examples", "publisher-test");

let pass = 0, fail = 0;
function assert(cond, name, detail = "") {
  if (cond) { console.log(`[通过] ${name}`); pass++; }
  else { console.error(`[失败] ${name}${detail ? `: ${detail}` : ""}`); fail++; }
}

function fresh() {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
}
function writeReport(name, passed) {
  writeFileSync(path.join(tmp, `${name}.json`), JSON.stringify({ passed }), "utf-8");
}

// 1. 全缺失 -> fail（原漏洞场景）
fresh();
assert(publish(tmp).overall_passed === false, "P0 修复：全部报告缺失时 overall=false（不再 fail open）");

// 2. det + review 均通过 -> true（e2e 可选）
fresh();
writeReport("deterministic-report", true);
writeReport("review-report", true);
{
  const r = publish(tmp);
  assert(r.overall_passed === true, "det+review 通过时 overall=true");
  assert(r.sections["e2e-report"].present === false && r.sections["e2e-report"].required === false, "e2e 按策略非必需");
}

// 3. review 缺失 -> fail
fresh();
writeReport("deterministic-report", true);
assert(publish(tmp).overall_passed === false, "必需的 review 缺失时 overall=false");

// 4. review 存在但 passed=false -> fail
fresh();
writeReport("deterministic-report", true);
writeReport("review-report", false);
assert(publish(tmp).overall_passed === false, "review 未通过时 overall=false");

// 5. 中间汇总模式
fresh();
writeReport("deterministic-report", true);
{
  const r = publish(tmp, { required: ["deterministic-report"], mode: "partial" });
  assert(r.overall_passed === true && r.mode === "partial", "partial 模式不受 review 缺席影响（显式声明）");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[结果] Publisher fail-close 测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
