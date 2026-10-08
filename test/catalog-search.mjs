/**
 * catalog-search.mjs —— Capability 索引与检索测试（P1-5，自包含）
 *
 * 评审验收例句：
 *   「并发限制、任务优先级和暂停恢复的调度器」 -> 命中 p-queue（无需知道仓库名）
 *   「独立服务进程 崩溃重启」                    -> 命中 openworkbuddy
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildCatalog } from "../src/catalog/builder.ts";
import { searchCapabilities } from "../src/catalog/search.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "fixtures", "mini-knowledge-multi");

let pass = 0, fail = 0;
function assert(cond, name, detail = "") {
  if (cond) { console.log(`[通过] ${name}`); pass++; }
  else { console.error(`[失败] ${name}${detail ? `: ${detail}` : ""}`); fail++; }
}

const catalog = buildCatalog(fixtureRoot);

// 索引结构
assert(catalog.capabilities.length >= 3, "多能力被索引", JSON.stringify(catalog.capabilities.map((c) => c.id)));
assert(catalog.capabilities.some((c) => c.id === "concurrency-limit" && c.modules.some((m) => m.repo === "p-queue")), "p-queue 并发能力入索引");
assert(catalog.capabilities.some((c) => c.id === "crash-recovery" && c.modules.some((m) => m.repo === "openworkbuddy")), "openworkbuddy 崩溃恢复能力入索引");

// 评审例句 1：调度器需求
{
  const hits = searchCapabilities(catalog, "我需要实现支持并发限制、任务优先级和暂停恢复的调度器");
  const ids = hits.map((h) => h.capability);
  assert(ids.includes("concurrency-limit"), "例句1 命中并发限制能力", ids.join(","));
  assert(ids.includes("priority-scheduling"), "例句1 命中优先级调度能力");
  assert(ids.includes("pause-resume"), "例句1 命中暂停恢复能力");
  const topRepos = new Set(hits.flatMap((h) => h.modules.map((m) => m.repo)));
  assert(topRepos.has("p-queue") && !topRepos.has("openworkbuddy"), "例句1 检索指向 p-queue（跨仓库正确分流）");
}

// 评审例句 2：桌面进程需求
{
  const hits = searchCapabilities(catalog, "Electron 桌面端 独立服务进程 崩溃重启");
  const ids = hits.map((h) => h.capability);
  assert(ids.includes("process-isolation") || ids.includes("crash-recovery"), "例句2 命中进程隔离/崩溃恢复能力", ids.join(","));
  const repos = new Set(hits.flatMap((h) => h.modules.map((m) => m.repo)));
  assert(repos.has("openworkbuddy"), "例句2 检索指向 openworkbuddy");
}

// 证据引用完整（file + line）
{
  const cap = catalog.capabilities.find((c) => c.id === "crash-recovery");
  const ev = cap?.modules[0]?.evidence[0];
  assert(ev && ev.file && typeof ev.line === "number", "能力条目携带源码证据（file:line）");
}

// P2-0b：审查状态标注与 trusted 过滤
{
  const conc = catalog.capabilities.find((c) => c.id === "concurrency-limit");
  const pq = conc?.modules.find((m) => m.repo === "p-queue");
  assert(pq?.review_status === "reviewed" && pq?.evidence_status === "evidenced", "已审查模块正确标注（reviewed/evidenced）");
  const crash = catalog.capabilities.find((c) => c.id === "crash-recovery");
  const owb = crash?.modules.find((m) => m.repo === "openworkbuddy");
  assert(owb?.review_status === "unreviewed", "无 review-report 的模块标 unreviewed");
}
{
  const trusted = searchCapabilities(catalog, "崩溃 重启 崩溃恢复", { trustedOnly: true });
  const hasUnreviewed = trusted.some((h) => h.modules.some((m) => m.review_status !== "reviewed"));
  assert(!hasUnreviewed, "trustedOnly 过滤后无未审查条目");
}
{
  const all = searchCapabilities(catalog, "崩溃 重启");
  const firstModule = all.flatMap((h) => h.modules)[0];
  assert(firstModule.review_status === "reviewed" || all.every((h) => h.modules.every((m) => m.review_status !== "reviewed")), "默认排序已审查模块优先");
}

console.log(`\n[结果] 能力索引与检索测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
