/**
 * analysis-contract.ts —— module-analysis 结构契约校验（P1-2）
 *
 * 评审要求：生成器不能自行把 inferred 升级为 verified。
 * 本契约从结构上强制：
 *   - facts 数组内每条 status 必须为 "verified"，且 evidence 非空、文件在白名单内
 *   - 推断只能存在 inferences 字段（渲染时显式标注）
 *   - execution_flows 每步若缺证据文件则 status 必须为 "inferred"
 *   - 必填七字段齐全（空数组合法——证据不足就留空，不编造）
 */

export interface FactEvidence {
  file: string;
  lines?: [number, number];
  note?: string;
}

export interface ModuleAnalysis {
  schema_version: "1.0";
  module_id: string;
  name: string;
  summary: string;
  facts: Array<{ statement: string; status: "verified"; evidence: FactEvidence[] }>;
  execution_flows: Array<{ name: string; status: "verified" | "inferred"; steps: Array<{ action: string; evidence_file?: string }> }>;
  interfaces: Array<{ symbol: string; kind: string; file: string; line?: number }>;
  dependencies: { internal_files: string[]; external_packages: string[] };
  inferences: Array<{ statement: string; basis: string }>;
  reuse_guidance: { portable: string[]; adapt: string[]; risks: string[] };
  open_questions: string[];
  /** 分析过程中实际读取过的文件（facts 引用范围的上界） */
  read_files: string[];
}

export interface AnalysisContractResult {
  ok: boolean;
  errors: string[];
  analysis: ModuleAnalysis | null;
}

const REQUIRED_KEYS = [
  "schema_version", "module_id", "name", "summary", "facts", "execution_flows",
  "interfaces", "dependencies", "inferences", "reuse_guidance", "open_questions", "read_files",
] as const;

export function validateModuleAnalysis(
  raw: string,
  whitelist: Set<string>,
): AnalysisContractResult {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`非法 JSON: ${(e as Error).message}`], analysis: null };
  }

  const errors: string[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed)) errors.push(`缺少必填字段: ${key}`);
  }
  if (errors.length) return { ok: false, errors, analysis: null };

  const readSet = new Set<string>(Array.isArray(parsed.read_files) ? parsed.read_files : []);

  // facts：只允许 verified + 证据在白名单且实际读过
  for (const f of parsed.facts ?? []) {
    if (f.status !== "verified") {
      errors.push(`fact「${String(f.statement).slice(0, 40)}」status 必须为 verified（推断请放 inferences）`);
    }
    if (!Array.isArray(f.evidence) || f.evidence.length === 0) {
      errors.push(`fact「${String(f.statement).slice(0, 40)}」缺少证据`);
    }
    for (const ev of f.evidence ?? []) {
      if (!whitelist.has(ev.file)) errors.push(`fact 证据文件不在白名单: ${ev.file}`);
      else if (!readSet.has(ev.file)) errors.push(`fact 引用了未读取的文件: ${ev.file}（证据边界违规）`);
    }
  }

  // execution_flows：无证据文件的步骤必须标 inferred
  for (const flow of parsed.execution_flows ?? []) {
    for (const step of flow.steps ?? []) {
      if (!step.evidence_file && flow.status === "verified") {
        errors.push(`流程「${flow.name}」标记 verified 但步骤缺证据文件`);
      }
      if (step.evidence_file && !whitelist.has(step.evidence_file)) {
        errors.push(`流程「${flow.name}」步骤证据不在白名单: ${step.evidence_file}`);
      }
    }
  }

  // interfaces 文件必须在白名单
  for (const it of parsed.interfaces ?? []) {
    if (!whitelist.has(it.file)) errors.push(`接口引用文件不在白名单: ${it.file}`);
  }

  // dependencies internal_files 在白名单
  for (const f of parsed.dependencies?.internal_files ?? []) {
    if (!whitelist.has(f)) errors.push(`内部依赖不在白名单: ${f}`);
  }

  return { ok: errors.length === 0, errors, analysis: errors.length ? null : parsed as ModuleAnalysis };
}
