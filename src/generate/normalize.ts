/**
 * normalize.ts —— LLM 分析输出的确定性规范化（共享，供 Agent 端与离线验证复用）
 *
 * 评审约束：只处理明确等价的形式（路径标准化、可确认的默认结构字段），
 * 禁止自动补全技术事实或把不存在的文件路径"猜"成另一个文件。
 */

import path from "node:path";

/** 分析协议版本：prompt/schema/分析方式变更时递增使缓存失效
 * p2-4-r2：targeted 重构为真两阶段（旧 targeted 产物无真实读取，全部失效）；逐文件提取规则纳入 */
export const PROMPT_VERSION = "p2-4-r2";
/** 分析协议标识（区别 read 模式，参与缓存键） */
export const ANALYSIS_PROTOCOL = "two-stage-v1";

/** 规范化单模块分析：结构缺省补齐 + 相对路径解析到白名单 */
export function normalizeAnalysis(
  raw: any,
  mod: { id: string; name: string; summary?: string; source_files: string[] },
  whitelist: Set<string>,
  readFiles: string[],
): any {
  const a = { ...raw };
  a.module_id = mod.id;
  a.name = mod.name;
  a.read_files = readFiles;
  a.schema_version ??= "1.0";
  a.summary ??= mod.summary ?? "";
  a.facts ??= [];
  a.execution_flows ??= [];
  a.interfaces ??= [];
  a.dependencies ??= { internal_files: [], external_packages: [] };
  a.inferences ??= [];
  a.reuse_guidance ??= { portable: [], adapt: [], risks: [] };
  a.open_questions ??= [];

  const baseDir = mod.source_files[0]?.includes("/")
    ? mod.source_files[0].slice(0, mod.source_files[0].lastIndexOf("/"))
    : "";

  const resolveToWhitelist = (f: string): string => {
    if (typeof f !== "string") return f;
    const candidates: string[] = [];
    // LLM 可能把依赖写成「路径 (中文说明)」混合串：取空白/括号前 token（仅精确命中白名单才算等价规范化，不做模糊猜测）
    const bare = f.split(/[\s(（]/)[0];
    if (bare && bare !== f) candidates.push(bare, bare.replace(/\.js$/, ".ts"), `${bare}.js`, `${bare}.ts`);
    if (f.startsWith("./") || f.startsWith("../")) {
      const joined = path.posix.normalize(baseDir ? path.posix.join(baseDir, f) : f);
      candidates.push(joined, joined.replace(/\.js$/, ".ts"), `${joined}.js`, `${joined}.ts`, `${joined}/index.js`);
    } else {
      const clean = f.replace(/^\.\//, "");
      candidates.push(clean, `${clean}.js`, `${clean}.ts`); // CJS 无扩展名 require（lib/DLList -> lib/DLList.js）
    }
    candidates.push(f.replace(/\.js$/, ".ts"));
    for (const c of candidates) if (whitelist.has(c)) return c;
    return f.replace(/^\.\//, "");
  };

  a.dependencies.internal_files = (a.dependencies.internal_files ?? []).map(resolveToWhitelist);
  a.facts?.forEach((fact: any) =>
    fact.evidence?.forEach((ev: any) => { if (ev) ev.file = resolveToWhitelist(ev.file); }));
  a.execution_flows?.forEach((fl: any) =>
    fl.steps?.forEach((s: any) => { if (s) s.evidence_file = resolveToWhitelist(s.evidence_file); }));
  a.interfaces?.forEach((it: any) => { if (it) it.file = resolveToWhitelist(it.file); });
  return a;
}
