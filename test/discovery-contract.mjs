/**
 * discovery-contract.mjs —— P1-1 发现链路契约测试（自包含，不依赖 cache/knowledge）
 *
 * 测试流程：
 *
 * main()
 *     ├─> 正向 1：mini fixture 生成受限上下文（断言：无仓库路径泄漏到上下文、白名单正确）
 *     ├─> 正向 2：mock-discover 经 runner 子进程全链路（受控读取协议）-> 契约校验通过
 *     ├─> 负向 1：白名单外 source_file -> 契约拒绝
 *     ├─> 负向 2：confidence 非法 -> 契约拒绝
 *     ├─> 负向 3：commit 与上下文不一致 -> 契约拒绝
 *     └─> 退出码：全部通过 0
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDiscoveryContext } from "../src/discovery/context.ts";
import { validateModuleMap } from "../src/discovery/contract.ts";
import { runAgent } from "../src/discovery/runner.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixtureKnowledge = path.join(here, "fixtures", "mini-knowledge");
const fixtureRepo = path.join(here, "fixtures", "mini-repo");
const tmp = path.join(root, "dev-examples", "p1-discovery-contract");

let pass = 0;
let fail = 0;
function assert(cond, name, detail = "") {
  if (cond) { console.log(`[通过] ${name}`); pass++; }
  else { console.error(`[失败] ${name}${detail ? `: ${detail}` : ""}`); fail++; }
}

const manifest = JSON.parse(readFileSync(path.join(fixtureKnowledge, "repository-manifest.json"), "utf-8"));
const sourceMap = JSON.parse(readFileSync(path.join(fixtureKnowledge, "source-map.json"), "utf-8"));

// 正向 1：受限上下文
const context = buildDiscoveryContext(manifest, sourceMap, "test", { name: "mini-repo", main: "entry.js" });
const ctxJson = JSON.stringify(context);
assert(context.repository === "example/mini-repo", "上下文含仓库标识");
assert(context.readable_files.length === 3, "白名单含全部 manifest 文件");
assert(!ctxJson.includes("gold-set") && !ctxJson.includes("knowledge"), "上下文无 gold-set/knowledge 泄漏");
assert(context.dependency_summary.length >= 2, "依赖摘要已生成");

// 正向 2：mock agent 全链路
mkdirSync(tmp, { recursive: true });
const ctxPath = path.join(tmp, "discovery-context.json");
writeFileSync(ctxPath, JSON.stringify(context, null, 2), "utf-8");
const result = await runAgent(path.join(root, "agents", "mock-discover.mjs"), ctxPath, fixtureRepo, new Set(context.readable_files));
assert(result.ok, "mock agent 子进程完成", result.error ?? "");
if (result.output) {
  const contract = validateModuleMap(result.output, context, new Set(manifest.files.map((f) => f.path)));
  assert(contract.ok, "契约校验通过", contract.errors.join("; "));
  const mm = contract.moduleMap;
  assert(mm && mm.modules.length >= 1, "产出至少 1 个模块");
  assert(result.readLog.length >= 1, `受控读取协议被使用（读取 ${result.readLog.length} 文件）`);
}

// 负向：契约拒绝
const valid = JSON.parse(result.output ?? "{}");
const paths = new Set(manifest.files.map((f) => f.path));

const bad1 = structuredClone(valid);
bad1.modules[0].source_files.push("etc/passwd-不存在.js");
assert(!validateModuleMap(JSON.stringify(bad1), context, paths).ok, "白名单外文件被拒绝");

const bad2 = structuredClone(valid);
bad2.modules[0].confidence = "super-high";
assert(!validateModuleMap(JSON.stringify(bad2), context, paths).ok, "非法 confidence 被拒绝");

const bad3 = structuredClone(valid);
bad3.commit = "f".repeat(40);
assert(!validateModuleMap(JSON.stringify(bad3), context, paths).ok, "commit 不一致被拒绝");

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[结果] 发现契约测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
