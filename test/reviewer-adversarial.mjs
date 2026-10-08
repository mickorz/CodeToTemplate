/**
 * reviewer-adversarial.mjs —— Reviewer 对抗测试（P1-4 硬验收，自包含不调 LLM）
 *
 * 评审验收用例：「即使引用了真实存在的 queue.ts，Reviewer 也应能识别
 * 『源码存在，不等于这个结论成立』，并拒绝把它标记为 verified。」
 *
 * 用例：
 *   A1 持久化数据库伪造（引用真实 queue.ts）        -> 必须拦截
 *   A2 任务失败自动重试伪造                          -> 必须拦截（p-queue 不自动重试）
 *   A3 分布式集群伪造                                -> 必须拦截
 *   A4 真实事实（EventEmitter 继承，源码有支撑）      -> 不得误报
 *   A5 真实事实（并发控制，源码有支撑）               -> 不得误报
 */

import { checkClaims } from "../src/review/claim-checker.ts";

// 自包含：内嵌 p-queue 特征源码片段（不依赖本地 cache，CI 干净环境可跑）
const INDEX_TS = `
import {EventEmitter} from 'eventemitter3';
import pTimeout from 'p-timeout';
export default class PQueue extends EventEmitter {
  #concurrency: number;
  #queue: Queue;
  #tryToStartAnother() { /* 逐个启动任务 */ }
}
`;
const QUEUE_TS = `export interface Queue {}\nexport type RunFunction = () => Promise<void>;\n`;
const srcFiles = ["source/index.ts", "source/queue.ts"];
const sourceContents = new Map([
  ["source/index.ts", INDEX_TS],
  ["source/queue.ts", QUEUE_TS],
]);

let pass = 0, fail = 0;
function assert(cond, name, detail = "") {
  if (cond) { console.log(`[通过] ${name}`); pass++; }
  else { console.error(`[失败] ${name}${detail ? `: ${detail}` : ""}`); fail++; }
}

// 模块真实源码（作为核查的源码内容来源）
const deps = { internal_files: srcFiles, external_packages: ["eventemitter3", "p-timeout"] };

function makeAnalysis(facts) {
  return {
    schema_version: "1.0", module_id: "scheduling.index", name: "index", summary: facts[0]?.statement ?? "",
    facts: facts.map((statement) => ({ statement, status: "verified", evidence: [{ file: "source/queue.ts", lines: [1, 10] }] })),
    execution_flows: [], interfaces: [],
    dependencies: deps, inferences: [], reuse_guidance: { portable: [], adapt: [], risks: [] },
    open_questions: [], read_files: srcFiles,
  };
}

// A1: 评审原例——持久化数据库（引用真实 queue.ts，行号也对，但结论错误）
{
  const v = checkClaims(makeAnalysis(["p-queue 通过持久化数据库保存排队任务，应用退出后可以自动恢复"]), sourceContents);
  assert(v.length >= 1 && v.some((x) => x.claim === "persistence"), "A1 持久化伪造结论被拦截（引用真实文件也无效）", JSON.stringify(v));
}

// A2: 自动重试伪造
{
  const v = checkClaims(makeAnalysis(["任务执行失败时队列会自动重试该任务"]), sourceContents);
  assert(v.some((x) => x.claim === "auto_retry"), "A2 自动重试伪造被拦截（p-queue 不自动重试）");
}

// A3: 分布式伪造
{
  const v = checkClaims(makeAnalysis(["支持分布式集群部署，多节点协同调度"]), sourceContents);
  assert(v.some((x) => x.claim === "distributed"), "A3 分布式伪造被拦截");
}

// A4/A5: 真实事实不得误报
{
  const v = checkClaims(makeAnalysis([
    "PQueue 类继承自 EventEmitter，发出 active/idle/empty 等事件",
    "通过 concurrency 选项控制并发上限，#tryToStartAnother 逐个启动任务",
  ]), sourceContents);
  assert(v.length === 0, "A4/A5 真实事实零误报", JSON.stringify(v));
}

// 网络能力在无网络依赖的模块声称 -> 拦截（泛化用例）
{
  const v = checkClaims(makeAnalysis(["支持通过 HTTP API 远程提交任务"]), sourceContents);
  assert(v.some((x) => x.claim === "network"), "泛化：网络能力伪造被拦截");
}

console.log(`\n[结果] Reviewer 对抗测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
