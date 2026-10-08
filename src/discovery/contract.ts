/**
 * contract.ts —— module-map 输出契约校验（P1-1）
 *
 * Agent 输出必须满足的结构契约（与仓库无关）：
 *
 * validateModuleMap(raw, context, manifestPaths)
 *     ├─> JSON 可解析且为对象
 *     ├─> schema_version / repository / commit 与发现上下文一致
 *     ├─> modules 非空数组，每项：
 *     │     ├─> id 非空且全表唯一
 *     │     ├─> source_files 非空且全部在 manifest 白名单内
 *     │     ├─> dependencies 全部指向存在的模块 id
 *     │     └─> confidence 属于 high medium low
 *     └─> 返回 { ok, errors[], moduleMap? }
 */

import type { DiscoveryContext } from "./context.ts";

export interface ContractResult {
  ok: boolean;
  errors: string[];
  moduleMap: unknown | null;
}

export function validateModuleMap(
  raw: string,
  context: DiscoveryContext,
  manifestPaths: Set<string>,
): ContractResult {
  const errors: string[] = [];

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`输出不是合法 JSON: ${(e as Error).message}`], moduleMap: null };
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.modules)) {
    return { ok: false, errors: ["输出缺少 modules 数组"], moduleMap: null };
  }

  if (parsed.schema_version !== "1.0") errors.push(`schema_version 应为 "1.0"，实际 ${JSON.stringify(parsed.schema_version)}`);
  if (parsed.repository !== context.repository) errors.push(`repository 与上下文不一致: ${parsed.repository} vs ${context.repository}`);
  if (parsed.commit !== context.commit) errors.push(`commit 与上下文不一致: ${parsed.commit} vs ${context.commit}`);

  const ids = new Set<string>();
  for (const m of parsed.modules) {
    if (!m.id || typeof m.id !== "string") errors.push(`模块缺少 id: ${JSON.stringify(m).slice(0, 60)}`);
    else if (ids.has(m.id)) errors.push(`模块 id 重复: ${m.id}`);
    else ids.add(m.id);
  }

  for (const m of parsed.modules) {
    if (!Array.isArray(m.source_files) || m.source_files.length === 0) {
      errors.push(`模块 ${m.id}: source_files 为空`);
    } else {
      for (const f of m.source_files) {
        if (!manifestPaths.has(f)) errors.push(`模块 ${m.id}: source_file 不在白名单: ${f}`);
      }
    }
    if (Array.isArray(m.dependencies)) {
      for (const d of m.dependencies) {
        if (!ids.has(d)) errors.push(`模块 ${m.id}: dependency 指向不存在的 id: ${d}`);
      }
    }
    if (!["high", "medium", "low"].includes(m.confidence)) {
      errors.push(`模块 ${m.id}: confidence 非法: ${m.confidence}`);
    }
  }

  return { ok: errors.length === 0, errors, moduleMap: errors.length ? null : parsed };
}
