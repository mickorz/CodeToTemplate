/**
 * publisher.ts —— 分文件报告汇总器（P1-2，回应评审：单项检查不得覆盖已有证据）
 *
 * 汇总流程：
 *
 * publish(knowledgeDir)
 *     ├─> 读取分文件报告（存在才并入，不存在标记 missing）：
 *     │     deterministic-report.json   确定性校验
 *     │     review-report.json          Reviewer 语义审查
 *     │     e2e-report.json             E2E 测试
 *     ├─> 全部 passed 才 overall passed
 *     └─> 合成 verification-report.json（只由 Publisher 写，其他环节禁止写此文件）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const SOURCES = ["deterministic-report", "review-report", "e2e-report"] as const;

export interface PublishResult {
  overall_passed: boolean;
  sections: Record<string, { present: boolean; passed?: boolean }>;
}

export function publish(knowledgeDir: string): PublishResult {
  const sections: PublishResult["sections"] = {};
  let allPassed = true;

  for (const name of SOURCES) {
    const p = path.join(knowledgeDir, `${name}.json`);
    if (!existsSync(p)) {
      sections[name] = { present: false };
      continue;
    }
    const data = JSON.parse(readFileSync(p, "utf-8"));
    const passed = data.passed === true;
    sections[name] = { present: true, passed };
    if (!passed) allPassed = false;
  }

  const manifestPath = path.join(knowledgeDir, "repository-manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : null;

  const report = {
    schema_version: "1.0",
    repository: manifest?.repository ?? null,
    commit: manifest?.commit ?? null,
    published_by: "publisher (P1-2)",
    overall_passed: allPassed,
    sections,
  };
  writeFileSync(path.join(knowledgeDir, "verification-report.json"), JSON.stringify(report, null, 2), "utf-8");
  return { overall_passed: allPassed, sections };
}
