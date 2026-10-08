/**
 * claims.ts —— 送审条目构造与 hash（共享：review 命令与 catalog 校验复用）
 *
 * claims_hash 用途：审查报告记录送审内容指纹，catalog/引用构建时重算比对——
 * 分析刷新后旧审查报告自动失效（防止旧结论被新分析误用，评审 P2 修复 2）。
 */

import { createHash } from "node:crypto";
import type { ModuleAnalysis } from "../generate/analysis-contract.ts";

/** 机制关键词（与 cmdReview 一致：送审抽样范围） */
const MECH = /并发|concurren|优先|priority|超时|timeout|暂停|pause|速率|rate|调度|queue|重试/i;

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
