/**
 * publisher.ts —— 分文件报告汇总器（P2-0a 起 fail-close）
 *
 * 评审修复：原实现三报告全缺失时 allPassed 仍为 true（Fail Open）。
 * 现在必需报告缺失即失败；必需集合由发布策略决定：
 *   - 默认（正式发布）：deterministic-report + review-report 必需，e2e-report 可选
 *   - 中间汇总（generate 内）：调用方显式传 required 并标注 partial，不得冒充通过
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export const REQUIRED_DEFAULT = ["deterministic-report", "review-report"] as const;
const ALL_SOURCES = ["deterministic-report", "review-report", "e2e-report"] as const;

export interface PublishResult {
  overall_passed: boolean;
  /** partial = 存在缺席的必需报告之外的情况（中间汇总显式声明时） */
  mode: "full" | "partial";
  sections: Record<string, { present: boolean; passed?: boolean; required: boolean }>;
}

export function publish(
  knowledgeDir: string,
  options: { required?: readonly string[]; mode?: "full" | "partial" } = {},
): PublishResult {
  const required = options.required ?? REQUIRED_DEFAULT;
  const mode = options.mode ?? "full";

  const sections: PublishResult["sections"] = {};
  let allPassed = true;

  for (const name of ALL_SOURCES) {
    const p = path.join(knowledgeDir, `${name}.json`);
    if (!existsSync(p)) {
      const isRequired = required.includes(name);
      if (isRequired) allPassed = false; // P2-0a 修复：必需报告缺失即失败（fail-close）
      sections[name] = { present: false, required: isRequired };
      continue;
    }
    const data = JSON.parse(readFileSync(p, "utf-8"));
    const passed = data.passed === true;
    if (!passed && required.includes(name)) allPassed = false;
    sections[name] = { present: true, passed, required: required.includes(name) };
  }

  const manifestPath = path.join(knowledgeDir, "repository-manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : null;

  const report = {
    schema_version: "1.0",
    repository: manifest?.repository ?? null,
    commit: manifest?.commit ?? null,
    published_by: "publisher (P2-0a fail-close)",
    mode,
    required_reports: required,
    overall_passed: allPassed,
    sections,
  };
  writeFileSync(path.join(knowledgeDir, "verification-report.json"), JSON.stringify(report, null, 2), "utf-8");
  return { overall_passed: allPassed, mode, sections };
}
