/**
 * reference-context.mjs —— Reference Context Builder 测试（P2-1，自包含）
 *
 * 评审目标链路验收：需求输入 -> 能力检索 -> 可信筛选 -> 最小参考包
 * 断言：trusted 默认过滤 unreviewed；参考包含 facts/interfaces/依赖/源码清单/测试/许可证/复用提示；
 *       非商用许可证带显著警示。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildCatalog } from "../src/catalog/builder.ts";
import { buildReferenceContext, renderReferenceMarkdown } from "../src/reference/builder.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "fixtures", "mini-knowledge-multi");

let pass = 0, fail = 0;
function assert(cond, name, detail = "") {
  if (cond) { console.log(`[通过] ${name}`); pass++; }
  else { console.error(`[失败] ${name}${detail ? `: ${detail}` : ""}`); fail++; }
}

const catalog = buildCatalog(fixtureRoot);

// 例句：p-queue 需求（fixture 中 p-queue 模块是 reviewed）
{
  const ctx = buildReferenceContext("支持并发限制与暂停恢复的调度器", catalog, fixtureRoot);
  assert(ctx.references.length >= 1, "调度器需求命中至少 1 个可信参考模块");
  const pq = ctx.references.find((r) => r.repo === "p-queue");
  assert(!!pq, "参考包含 p-queue 模块");
  if (pq) {
    assert(pq.review_status === "reviewed", "参考模块为已审查状态");
    assert(Array.isArray(pq.facts) && pq.facts.length >= 3, "参考包含全部已验证 facts", `实际 ${pq.facts.length}`);
    assert(Array.isArray(pq.interfaces), "参考包含 interfaces");
    assert(Array.isArray(pq.dependencies.internal_files) && Array.isArray(pq.dependencies.external_packages), "参考包含依赖（内部+外部）");
    assert(Array.isArray(pq.source_files) && pq.source_files.length >= 1, "参考包含源码清单（供按需读取）");
    assert(pq.license === "MIT", "参考包含许可证（MIT）");
    assert(ctx.capabilities_hit.length >= 1, "参考记录命中能力");
  }
}

// trusted 默认过滤：openworkbuddy fixture 无 review-report -> 不出现在 trusted 参考中
{
  const ctx = buildReferenceContext("独立服务进程 崩溃重启", catalog, fixtureRoot);
  assert(ctx.references.every((r) => r.review_status === "reviewed"), "默认 trusted：未审查模块被过滤", ctx.references.map((r) => r.module_id).join(","));
  const md = renderReferenceMarkdown(ctx);
  assert(md.includes("已通过语义审查") || ctx.references.length === 0, "markdown 声明可信过滤");
}

// 非可信模式：openworkbuddy 可出现且带非商用警示
{
  const ctx = buildReferenceContext("独立服务进程 崩溃重启", catalog, fixtureRoot, { trustedOnly: false });
  const owb = ctx.references.find((r) => r.repo === "openworkbuddy");
  assert(!!owb, "非 trusted 模式包含 openworkbuddy 模块");
  if (owb) {
    assert(owb.review_status === "unreviewed", "未审查模块如实标注");
    assert(owb.license_note?.includes("非商用"), "非商用许可证显著警示");
    const md = renderReferenceMarkdown(ctx);
    assert(md.includes("非商用许可证"), "markdown 含许可证警示");
  }
}

console.log(`\n[结果] Reference Context 测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
