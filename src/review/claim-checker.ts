/**
 * claim-checker.ts —— 确定性主张-证据一致性核查（P1-4 Reviewer 第一层）
 *
 * 评审定位：拦截「源码路径存在，但技术结论错误」——例如引用真实 queue.ts
 * 却声称「通过持久化数据库保存排队任务」。路径与行号正确不等于结论成立。
 *
 * 核查流程：
 *
 * checkClaims(analysis, sourceContents)
 *     ├─> 逐条扫描 facts/summary/inferences 中的能力主张关键词（词典驱动）
 *     ├─> 每个主张必须在依赖或源码中找到支撑证据：
 *     │     ├─> 依赖支撑：external_packages / internal_files 命中该能力的库
 *     │     └─> 源码支撑：模块源码文本含该能力的关键调用
 *     └─> 无支撑 -> violation（该条不得保持 verified，进 review-report 阻断发布）
 *
 * 边界：本核查是必要条件而非充分条件——能拦「无中生有的能力」，不判「细节是否准确」
 * （细节准确性由 LLM Reviewer 第二层负责）。
 */

import type { ModuleAnalysis } from "../generate/analysis-contract.ts";

/** 能力主张词典：主张关键词 -> 支撑证据（依赖包名 / 源码调用特征） */
const CLAIM_DICTIONARY: Record<string, {
  claim_patterns: RegExp[];
  dep_evidence: RegExp[];
  code_evidence: RegExp[];
}> = {
  persistence: {
    claim_patterns: [/持久化/, /数据库/, /\bdatabase\b/i, /sqlite|postgres|mysql|mongodb/i, /写入磁盘/, /保存到(文件|磁盘)/, /\bpersist/i], // 注：redis 不作为持久化主张触发词（内存型存储，属分布式/进程间协调语境）
    dep_evidence: [/sqlite|pg|mysql|mongo|redis|level|lowdb|better-sqlite/i],
    code_evidence: [/\.writeFile|\.openSync|sqlite3|\.query\(|createTable|INSERT\s+INTO/i],
  },
  network: {
    claim_patterns: [/网络(请求|通信)/, /\bHTTP\b(请求|服务)?/, /\bsocket\b/i, /websocket/i, /\bAPI 调用/, /远程(调用|服务)/],
    dep_evidence: [/^http$|^https$|^net$|^axios$|^node-fetch$|^undici$|^ws$|^got$/i],
    code_evidence: [/http\.(createServer|request|get)|net\.connect|new WebSocket|fetch\(/i],
  },
  multiprocessing: {
    claim_patterns: [/多进程/, /子进程/, /\bworker(线程|进程)?/, /进程(间)?通信/, /\bIPC\b/, /\bcluster\b/],
    dep_evidence: [/child_process|worker_threads|cluster|pm2|redis|ioredis/], // Redis pub/sub 是常见跨进程同步通道
    code_evidence: [/child_process|fork\(|new Worker\(|process\.send|utilityProcess|publish\(|subscribe\(|pub\/sub/i],
  },
  auto_retry: {
    claim_patterns: [/自动重试/, /重试机制/, /失败后(会)?重试/, /\bauto.?retry\b/i, /\bretry\b.*机制/],
    dep_evidence: [/p-retry|async-retry|retry|^p-timeout$/],
    code_evidence: [/retry|retries|backoff|attempt/i],
  },
  distributed: {
    claim_patterns: [/分布式/, /集群/, /多(机|节点)/, /横向扩展/, /\bscal(e|ing) out\b/i],
    dep_evidence: [/zookeeper|etcd|consul|kafka|nats|redis|ioredis/], // Redis 集群（SCAN 键发现/共享存储）是分布式语境
    code_evidence: [/raft|consensus|leader.?elect|shard|scan|cluster/i],
  },
};

export interface ClaimViolation {
  module_id: string;
  source: "facts" | "summary" | "inferences";
  index: number;
  statement: string;
  claim: string;
  reason: string;
}

function hasSupport(claimKey: string, analysis: ModuleAnalysis, sourceContents: Map<string, string>): boolean {
  const dict = CLAIM_DICTIONARY[claimKey];
  const deps = [
    ...(analysis.dependencies?.external_packages ?? []),
    ...(analysis.dependencies?.internal_files ?? []),
  ].join(" ");
  if (dict.dep_evidence.some((re) => re.test(deps))) return true;
  const code = [...sourceContents.values()].join("\n");
  if (dict.code_evidence.some((re) => re.test(code))) return true;
  return false;
}

/** 主张词命中但无支撑的字符串集合检查 */
function scanText(
  text: string,
  analysis: ModuleAnalysis,
  sourceContents: Map<string, string>,
): Array<{ claim: string; reason: string }> {
  const hits: Array<{ claim: string; reason: string }> = [];
  for (const [claimKey, dict] of Object.entries(CLAIM_DICTIONARY)) {
    const claimed = dict.claim_patterns.some((re) => re.test(text));
    if (claimed && !hasSupport(claimKey, analysis, sourceContents)) {
      hits.push({
        claim: claimKey,
        reason: `结论主张「${claimKey}」能力，但模块依赖与源码中均无该能力的支撑证据`,
      });
    }
  }
  return hits;
}

export function checkClaims(
  analysis: ModuleAnalysis,
  sourceContents: Map<string, string>,
): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  const moduleId = analysis.module_id;

  for (const hit of scanText(analysis.summary ?? "", analysis, sourceContents)) {
    violations.push({ module_id: moduleId, source: "summary", index: 0, statement: analysis.summary, ...hit });
  }
  analysis.facts?.forEach((f, i) => {
    for (const hit of scanText(f.statement, analysis, sourceContents)) {
      violations.push({ module_id: moduleId, source: "facts", index: i, statement: f.statement, ...hit });
    }
  });
  analysis.inferences?.forEach((inf, i) => {
    for (const hit of scanText(inf.statement, analysis, sourceContents)) {
      violations.push({ module_id: moduleId, source: "inferences", index: i, statement: inf.statement, ...hit });
    }
  });
  return violations;
}
