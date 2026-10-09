/**
 * engine-range-test.mjs —— 引擎级门禁回归测试（P2 最终复审）
 *
 * 验证：越界证据产物的模块被引擎标 failed（含"证据行级违规"）且不入缓存。
 */

import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGenerateEngine } from "../src/generate/engine.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, "..", "dev-examples", "engine-range-test");
rmSync(tmp, { recursive: true, force: true });

const kDir = path.join(tmp, "knowledge", "repo", "topic");
mkdirSync(kDir, { recursive: true });
const repoDir = path.join(tmp, "repo");
mkdirSync(path.join(repoDir, "src"), { recursive: true });
writeFileSync(path.join(repoDir, "src", "core.js"), "export const HELLO = 'world';\nexport function core() { return 1; }\n");

const manifest = {
  schema_version: "1.0", repository: "repo", commit: "a".repeat(40),
  files: [{ path: "src/core.js", bytes: 60, blob_sha: "b1" }],
  license: { spdx: "MIT" },
};
writeFileSync(path.join(kDir, "repository-manifest.json"), JSON.stringify(manifest));

const r = await runGenerateEngine({
  knowledgeDir: kDir, repoDir, manifest,
  modules: [{ id: "m.core", name: "core", summary: "s", source_files: ["src/core.js"] }],
  agentScript: path.join(here, "fixtures", "range-violation-agent.mjs"),
  agentCmdLabel: "range-violation-agent", resume: false,
});

const entry = r.journalEntries[0];
const cacheFile = path.join(kDir, "analysis-cache", "m_core.json");
console.log(`status: ${entry.status} | error: ${(entry.error ?? "").slice(0, 100)}`);
console.log(`缓存文件存在: ${existsSync(cacheFile)}`);

if (entry.status === "failed" && (entry.error ?? "").includes("证据行级违规") && !existsSync(cacheFile)) {
  console.log("[通过] 引擎级：越界产物 failed 且不入缓存");
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
} else {
  console.error("[失败] 引擎级门禁未拦截");
  process.exit(1);
}
