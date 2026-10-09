/**
 * catalog-search.mjs —— Capability 索引与检索测试（P1-5，自包含）
 *
 * 评审验收例句：
 *   「并发限制、任务优先级和暂停恢复的调度器」 -> 命中 p-queue（无需知道仓库名）
 *   「独立服务进程 崩溃重启」                    -> 命中 openworkbuddy
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { buildCatalog, extractCapabilities } from "../src/catalog/builder.ts";
import { claimsHash, buildClaimsForReview } from "../src/review/claims.ts";
import { searchCapabilities } from "../src/catalog/search.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "fixtures", "mini-knowledge-multi");

// setup：为 p-queue fixture 的 review-report 补 claims_hash（时效严格校验要求存在且匹配）
{
  const rp = path.join(fixtureRoot, "p-queue", "scheduling", "review-report.json");
  const rr = JSON.parse(readFileSync(rp, "utf-8"));
  const ma = JSON.parse(readFileSync(path.join(fixtureRoot, "p-queue", "scheduling", "module-analysis.json"), "utf-8"));
  for (const entry of rr.llm ?? []) {
    const a = ma.analyses.find((x) => x.module_id === entry.module_id);
    if (a && !entry.claims_hash) entry.claims_hash = claimsHash(buildClaimsForReview(a));
  }
  writeFileSync(rp, JSON.stringify(rr, null, 2));
}

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

// P2 评审修复回归：仅有 inference、无对应 verified fact 的模块不得进入可信能力
{
  const analysis = {
    schema_version: "1.0", module_id: "x.infer-only", name: "x", summary: "",
    facts: [],
    execution_flows: [], interfaces: [],
    dependencies: { internal_files: [], external_packages: [] },
    inferences: [{ statement: "推测支持分布式集群部署", basis: "直觉" }],
    reuse_guidance: { portable: [], adapt: [], risks: [] },
    open_questions: [], read_files: [],
  };
  const caps = extractCapabilities(analysis, { repo: "t", topic: "t", doc: "t" });
  assert(!caps.some((c) => c.id === "distributed"), "仅 inference 不触发能力分类（inferences 已移除匹配源）");
  assert(!caps.some((c) => c.id === "auto_retry"), "inference 中的重试主张不触发能力");
}

// P2 评审修复回归：unsupported 的事实不作为能力证据
{
  const analysis2 = {
    ...{
      schema_version: "1.0", module_id: "x.mix", name: "x", summary: "",
      facts: [
        { statement: "支持并发限制与优先级调度", status: "verified", evidence: [{ file: "a.ts", lines: [1, 2] }] },
        { statement: "支持分布式集群部署", status: "verified", evidence: [{ file: "a.ts", lines: [3, 4] }] },
      ],
      execution_flows: [], interfaces: [],
      dependencies: { internal_files: [], external_packages: [] },
      inferences: [],
      reuse_guidance: { portable: [], adapt: [], risks: [] },
      open_questions: [], read_files: [],
    },
  };
  const verdictMap = new Map(["支持分布式集群部署"].map((s) => [s, "unsupported"]));
  const caps = extractCapabilities(analysis2, { repo: "t", topic: "t", doc: "t" }, verdictMap);
  const dist = caps.find((c) => c.id === "distributed");
  assert(!dist || dist.evidence.every((e) => e.statement !== "支持分布式集群部署"), "unsupported 事实不作为能力证据");
  const conc = caps.find((c) => c.id === "concurrency-limit");
  assert(!!conc && conc.evidence.length >= 1, "supported 事实正常作为证据");
}

// P2 评审修复回归：review-report 的 commit 与分析不一致时模块降级 unreviewed
{
  const badReview = { passed: true, commit: "f".repeat(40), llm: [{ module_id: "scheduling.index", review_status: "reviewed", verdicts: [] }] };
  const tmpK = path.join(here, "fixtures", "mini-knowledge-multi-badcommit");
  cpSync(fixtureRoot, tmpK, { recursive: true });
  writeFileSync(path.join(tmpK, "p-queue", "scheduling", "review-report.json"), JSON.stringify(badReview));
  const cat2 = buildCatalog(tmpK);
  const conc2 = cat2.capabilities.find((c) => c.id === "concurrency-limit");
  const pq2 = conc2?.modules.find((m) => m.repo === "p-queue");
  assert(pq2?.review_status === "unreviewed", "旧 commit 的审查报告不生效（时效校验）");
  rmSync(tmpK, { recursive: true, force: true });
}

// P2 第三轮评审修复 1：缺 claims_hash 的旧格式报告降级 unreviewed（fail-close）
{
  const tmpK = path.join(here, "fixtures", "mini-knowledge-multi-nohash");
  cpSync(fixtureRoot, tmpK, { recursive: true });
  const rp = path.join(tmpK, "p-queue", "scheduling", "review-report.json");
  const rr = JSON.parse(readFileSync(rp, "utf-8"));
  delete rr.llm[0].claims_hash; // 模拟旧格式
  writeFileSync(rp, JSON.stringify(rr));
  const cat2 = buildCatalog(tmpK);
  const pq2 = cat2.capabilities.find((c) => c.id === "concurrency-limit")?.modules.find((m) => m.repo === "p-queue");
  assert(pq2?.review_status === "unreviewed", "缺 claims_hash 的旧格式报告降级 unreviewed");
  rmSync(tmpK, { recursive: true, force: true });
}

// P2 第五轮评审修复回归：超过 100 字符的 supported 事实不因截断丢失 verdict 关联
{
  const longStatement = "令牌桶限流器在刷新窗口内通过 reservoirRefreshAmount 补足容量而非累加且进行中任务不重复计入新容量这是实现刷新语义的关键边界行为".repeat(2);
  const analysis3 = {
    schema_version: "1.0", module_id: "x.long", name: "x", summary: "限流令牌桶",
    facts: [{ statement: longStatement, status: "verified", evidence: [{ file: "a.js", lines: [1, 2] }] }],
    execution_flows: [], interfaces: [],
    dependencies: { internal_files: [], external_packages: [] },
    inferences: [],
    reuse_guidance: { portable: [], adapt: [], risks: [] },
    open_questions: [], read_files: [],
  };
  const verdictMap2 = new Map([[longStatement, "supported"]]);
  const caps3 = extractCapabilities(analysis3, { repo: "t", topic: "t", doc: "t" }, verdictMap2);
  const rl3 = caps3.find((c) => c.id === "rate-limiting");
  assert(!!rl3 && rl3.evidence.length >= 1, "超长事实进入能力证据");
  if (rl3) {
    assert(rl3.evidence[0].claim_key === longStatement, "claim_key 保留完整 statement（截断仅展示层）");
    assert(rl3.evidence[0].statement.length <= 100, "展示 statement 已截断");
  }
}
{
  const tmpK = path.join(here, "fixtures", "mini-knowledge-multi-noreview");
  cpSync(fixtureRoot, tmpK, { recursive: true });
  rmSync(path.join(tmpK, "p-queue", "scheduling", "review-report.json"), { force: true }); // 无审查报告
  const cat2 = buildCatalog(tmpK);
  const pq2 = cat2.capabilities.find((c) => c.id === "concurrency-limit")?.modules.find((m) => m.repo === "p-queue");
  assert(pq2?.evidence_status === "inferred-only", "无 supported verdict 时 evidence_status 降为 inferred-only（未送审事实不作可信证据）", JSON.stringify(pq2?.evidence_status));
  rmSync(tmpK, { recursive: true, force: true });
}

console.log(`\n[结果] 能力索引与检索测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
