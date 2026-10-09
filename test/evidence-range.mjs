/**
 * evidence-range.mjs —— 证据行级契约测试（P2 第六轮 P0）
 * 越界行号 / 伪造读取记录 / 未读取证据 均被确定性拒绝
 */
import { validateEvidenceRanges } from "../src/generate/analysis-contract.ts";

let pass = 0, fail = 0;
const assert = (c, n, d = "") => { if (c) { console.log(`[通过] ${n}`); pass++; } else { console.error(`[失败] ${n}${d ? ": " + d : ""}`); fail++; } };

const base = (ranges, facts, readFiles) => ({
  schema_version: "1.0", module_id: "m", name: "m", summary: "",
  facts, execution_flows: [], interfaces: [],
  dependencies: { internal_files: [], external_packages: [] },
  inferences: [], reuse_guidance: { portable: [], adapt: [], risks: [] },
  open_questions: [], read_files: readFiles, read_ranges: ranges,
});
const fact = (file, line) => [{ statement: "某事实", status: "verified", evidence: [{ file, lines: [line, line] }] }];

// 1. 行号在范围内 + readLog 一致 -> 通过
assert(validateEvidenceRanges(base([{ file: "a.js", from: 10, to: 80 }], fact("a.js", 50), ["a.js"]), ["a.js:10-80"]).ok, "范围内行号通过");

// 2. 行号越界 -> 拒绝（评审例：实读 10-80，引用 150 行）
{
  const r = validateEvidenceRanges(base([{ file: "a.js", from: 10, to: 80 }], fact("a.js", 150), ["a.js"]), ["a.js:10-80"]);
  assert(!r.ok && r.errors.some((e) => e.includes("证据行级违规")), "越界行号被确定性拒绝", r.errors.join(";"));
}

// 3. 伪造读取记录（自报 read_ranges 不在 Runner 日志中）-> 拒绝
{
  const r = validateEvidenceRanges(
    base([{ file: "a.js", from: 10, to: 80 }], fact("a.js", 50), ["a.js"]),
    ["a.js:1-50"], // Runner 真实只读过 1-50
  );
  assert(!r.ok && r.errors[0].includes("伪造"), "自报行段与 Runner 日志不符被拒绝", r.errors.join(";"));
}

// 4. 自报行段与 Runner 日志完全一致 -> 通过
assert(validateEvidenceRanges(
  base([{ file: "a.js", from: 10, to: 80 }], fact("a.js", 50), ["a.js"]),
  ["a.js:10-80"],
).ok, "真实读取记录交叉验证通过");

// 5. full 模式（无 read_ranges）文件级 -> 行号不校验范围（由文件级契约管）
assert(validateEvidenceRanges(base([], fact("a.js", 999), ["a.js"])).ok, "full 模式维持文件级校验");

// 6. 未读取文件的证据 -> 文件级拒绝（主契约职责，此处不重复报行级错）
{
  const r = validateEvidenceRanges(base([{ file: "a.js", from: 1, to: 10 }], fact("b.js", 5), ["a.js"]), ["a.js:1-10"]);
  assert(r.ok, "文件级违规交由主契约（不重复报）");
}

// 7. P2 最终复审：readLog 为空但自报行段 -> 拒绝（未走协议声称读过）
{
  const r = validateEvidenceRanges(base([{ file: "a.js", from: 10, to: 80 }], fact("a.js", 50), ["a.js"]), []);
  assert(!r.ok && r.errors[0].includes("无任何真实读取记录"), "空 readLog 拒绝自报行段", r.errors[0]);
}

// 8. P2 最终复审：起始行合法但结束行越界 -> 拒绝
{
  const f2 = [{ statement: "某事实", status: "verified", evidence: [{ file: "a.js", lines: [50, 120] }] }];
  const r = validateEvidenceRanges(base([{ file: "a.js", from: 10, to: 80 }], f2, ["a.js"]), ["a.js:10-80"]);
  assert(!r.ok && r.errors[0].includes("证据行级违规"), "结束行越界被拒绝（起点合法不足以免责）", r.errors[0]);
}

console.log(`\n[结果] 证据行级契约测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
