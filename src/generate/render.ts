/**
 * render.ts —— module-analysis JSON 到 12 节 Markdown 的渲染器（P1-2）
 *
 * 设计原则（评审要求）：宁可空槽声明不足，不编造内容。
 *   - facts -> 第 8 节（仅 verified）
 *   - inferences -> 第 9 节（显式标注「推断」）
 *   - execution_flows 为空 -> 第 5 节写明证据不足
 *   - open_questions -> 第 12 节
 * 纯模板代码，无 LLM：所有文字均来自 analysis JSON 字段。
 */

import type { ModuleAnalysis } from "./analysis-contract.ts";

const NOTE = "（证据不足：规则版分析未取得流程证据，待 LLM Agent 补充）";

function renderAnalysis(a: ModuleAnalysis, repoMeta: { repository: string; commit: string }): string {
  const factRows = a.facts.length
    ? a.facts
        .map((f) => {
          const ev = f.evidence.map((e) => `${e.file}${e.lines ? `:${e.lines[0]}` : ""}`).join("、");
          return `| ${f.statement.replace(/\|/g, "/")} | ${ev} |`;
        })
        .join("\n")
    : "| （无已验证事实） | - |";

  const interfaceRows = a.interfaces.length
    ? a.interfaces.map((i) => `| \`${i.symbol}\` | ${i.kind} | ${i.file}${i.line ? `:${i.line}` : ""} |`).join("\n")
    : "| （未提取到导出符号） | - | - |";

  const flows = a.execution_flows.length
    ? a.execution_flows
        .map((fl) => {
          const steps = fl.steps.map((s, i) => `${i + 1}. ${s.action}${s.evidence_file ? `（${s.evidence_file}）` : "（推断）"}`).join("\n");
          return `### ${fl.name}（${fl.status === "verified" ? "已验证" : "推断"}）\n\n${steps}`;
        })
        .join("\n\n")
    : `> ${NOTE}`;

  const inferences = a.inferences.length
    ? a.inferences.map((inf) => `- **[推断]** ${inf.statement}（依据：${inf.basis}）`).join("\n")
    : "- （无推断内容：分析中未产生需要标注的推断）";

  const deps = [
    a.dependencies.internal_files.length ? `内部文件：${a.dependencies.internal_files.map((f) => `\`${f}\``).join("、")}` : "内部文件：（未发现文件内依赖）",
    a.dependencies.external_packages.length ? `外部包：${a.dependencies.external_packages.map((p) => `\`${p}\``).join("、")}` : "外部包：（无）",
  ].join("\n\n");

  const reuse = [
    a.reuse_guidance.portable.length ? `可直接借鉴：\n${a.reuse_guidance.portable.map((s) => `- ${s}`).join("\n")}` : "可直接借鉴：（待补充——规则版不生成复用建议）",
    a.reuse_guidance.adapt.length ? `需适配：\n${a.reuse_guidance.adapt.map((s) => `- ${s}`).join("\n")}` : "需适配：（待补充）",
    a.reuse_guidance.risks.length ? `风险：\n${a.reuse_guidance.risks.map((s) => `- ${s}`).join("\n")}` : "风险：（待补充）",
  ].join("\n\n");

  const openQ = a.open_questions.length
    ? a.open_questions.map((q) => `- ${q}`).join("\n")
    : `- （规则版分析范围内未发现悬而未决的问题；不代表全部问题已澄清）`;

  return `# 模块：${a.name}（${a.module_id}）

> 自动生成（P1-2 规则版）| ${repoMeta.repository} @ \`${repoMeta.commit.slice(0, 10)}\`
> 证据边界：本页全部已验证内容仅来自实际读取的 ${a.read_files.length} 个文件：${a.read_files.map((f) => `\`${f}\``).join("、") || "（无）"}

## 1. 能力定义

${a.summary || "（摘要缺失：证据不足，不编造）"}

## 2. 应用场景

（规则版不生成应用场景推断——待 LLM Agent 基于 facts 补充）

## 3. 总体设计

基于已验证事实的组件构成见第 4、8 节；设计动机类结论需要注释或文档证据，未取得时不在本页出现。

## 4. 核心组件

| 符号 | 类型 | 位置 |
| --- | --- | --- |
${interfaceRows}

## 5. 执行时序

${flows}

## 6. API / 数据契约

导出接口见第 4 节；参数与返回值契约需逐签名分析（待 LLM Agent 补充）。

## 7. 依赖关系

${deps}

## 8. 源码证据

| 已验证事实 | 证据 |
| --- | --- |
${factRows}

## 9. 关键设计权衡

${inferences}

## 10. 移植与复用指南

${reuse}

## 11. 测试与验收

（规则版未分析测试文件；验收方法待 LLM Agent 或人工补充）

## 12. 未确认事项

${openQ}
`;
}

export function renderAll(
  analyses: ModuleAnalysis[],
  repoMeta: { repository: string; commit: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of analyses) {
    const fileName = a.module_id.replace(/^[\w]+\./, "").replace(/[^\w-]/g, "-");
    out[`${fileName}.md`] = renderAnalysis(a, repoMeta);
  }
  return out;
}
