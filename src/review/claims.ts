/**
 * claims.ts —— 送审条目构造与 hash（共享：review 命令与 catalog 校验复用）
 *
 * claims_hash 用途：审查报告记录送审内容指纹，catalog/引用构建时重算比对——
 * 分析刷新后旧审查报告自动失效（防止旧结论被新分析误用，评审 P2 修复 2）。
 */

import { createHash } from "node:crypto";
import type { ModuleAnalysis } from "../generate/analysis-contract.ts";

/** 能力关键词（与能力词典联动：送审抽样覆盖全部可检索能力领域，确保可信证据面与检索面一致） */
const MECH = /并发|concurren|优先|priority|超时|timeout|暂停|pause|速率|rate|调度|queue|重试|限流|令牌桶|token bucket|流控|throttle|reservoir|配额|quota|进程隔离|崩溃|退避|backoff|重启|监护|桥接|IPC|窗口|打包|asar|签名|clock|时钟|离线|在线|远端|心跳|删除|事件|状态同步|冲突/i;

export function buildClaimsForReview(a: any): string[] {
  return [
    ...(a.inferences ?? []).map((i: any) => i.statement),
    ...(a.facts ?? []).filter((f: any) => MECH.test(f.statement)).map((f: any) => f.statement),
    ...(a.execution_flows ?? []).map((fl: any) => `执行流程「${fl.name}」：${fl.steps.map((s: any) => s.action).join(" -> ")}`),
  ].slice(0, 15);
}

export function claimsHash(claims: string[]): string {
  return createHash("sha256").update(JSON.stringify(claims)).digest("hex").slice(0, 12);
}

/** verdict 映射：statement -> supported/unsupported/unverifiable */
export function verdictMapFromReview(moduleEntry: any): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of moduleEntry?.verdicts ?? []) {
    if (v?.statement && v?.verdict) m.set(v.statement, v.verdict);
  }
  return m;
}
