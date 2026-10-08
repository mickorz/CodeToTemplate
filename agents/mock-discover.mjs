/**
 * mock-discover.mjs —— Mock Discovery Agent（P1-1 契约测试用）
 *
 * 通用规则版（无任何仓库专名，陌生仓库同样可跑）：
 *
 * main()
 *     ├─> 读入 discovery-context.json（唯一输入，无仓库路径）
 *     ├─> 种子选择：入边最多的枢纽文件 + 根入口文件
 *     ├─> 模块聚合：种子 + 其直接文件依赖 + 同目录邻文件
 *     ├─> 受控读取：经协议读种子文件头 40 行，提取注释行作为 summary
 *     └─> 输出 module-map JSON（done 消息）
 */

import { readFileSync } from "node:fs";
import { makeLineReader } from "./lib/line-protocol.mjs";

const contextPath = process.argv[2];
if (!contextPath) {
  console.error("用法: node mock-discover.mjs <discovery-context.json>");
  process.exit(2);
}

const ctx = JSON.parse(readFileSync(contextPath, "utf-8"));
const readLine = makeLineReader();

// --- 受控读取协议：stdout 请求，stdin 应答 ---
function request(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function readViaProtocol(path) {
  request({ op: "read_file", path });
  const line = await readLine();
  try { return JSON.parse(line); } catch { return { ok: false, error: "协议应答解析失败" }; }
}

/** 从文件头注释行提取摘要（通用启发式） */
function summarizeFromCode(code) {
  const lines = code.split(/\r?\n/).slice(0, 40);
  const comments = lines
    .filter((l) => /^\s*(\/\/|\*|\/\*|#)/.test(l))
    .map((l) => l.replace(/^\s*(\/\/|\*|\/\*|#)\s?/, "").trim())
    .filter((l) => l.length > 4)
    .slice(0, 3);
  return comments.join(" / ") || "（无注释摘要，按连接度聚合）";
}

async function main() {
  const whitelist = new Set(ctx.readable_files);
  const summaryMap = new Map(ctx.dependency_summary.map((s) => [s.path, s]));

  // 候选种子：连接度最高的枢纽（有入边）+ 根入口
  const hubs = ctx.dependency_summary.filter((s) => s.in_edges > 0).slice(0, 5);
  const rootEntries = ctx.entry_candidates.roots.filter((p) => summaryMap.has(p)).slice(0, 3);
  const seeds = [...rootEntries, ...hubs.filter((h) => !rootEntries.includes(h.path)).map((h) => h.path)];

  // 邻接：从种子出发收集直接依赖 + 同目录文件（限流：每模块至多 8 文件，避免巨石模块）
  const modules = [];
  const used = new Set();

  for (const seed of seeds) {
    if (used.has(seed)) continue;
    const s = summaryMap.get(seed);
    const dir = seed.includes("/") ? seed.slice(0, seed.lastIndexOf("/")) : "";
    const group = new Set([seed]);
    // 同目录邻文件
    for (const other of ctx.dependency_summary.map((x) => x.path)) {
      if (group.size >= 8) break;
      if (other !== seed && !used.has(other)) {
        const otherDir = other.includes("/") ? other.slice(0, other.lastIndexOf("/")) : "";
        if (dir && otherDir === dir && whitelist.has(other)) group.add(other);
      }
    }
    const files = [...group].filter((f) => !used.has(f));
    if (!files.length) continue;
    files.forEach((f) => used.add(f));

    // 受控读取种子文件，取注释摘要
    let summary = `枢纽文件（入边 ${s?.in_edges ?? 0}）`;
    const resp = await readViaProtocol(seed);
    if (resp && resp.ok) summary = summarizeFromCode(resp.content);

    const name = seed.split("/").pop()?.replace(/\.[^.]+$/, "") ?? seed;
    modules.push({
      id: `${ctx.topic}.${name}`,
      name,
      summary,
      source_files: files.sort(),
      dependencies: [],
      confidence: (s?.in_edges ?? 0) >= 3 ? "high" : "medium",
    });
  }

  request({
    op: "done",
    output: JSON.stringify({
      schema_version: "1.0",
      repository: ctx.repository,
      commit: ctx.commit,
      topic: ctx.topic,
      generated_by: "mock-discover (rule-based, no repo-specific hints)",
      modules,
    }, null, 2),
  });

  // stdout 刷盘后立即退出：stdin 监听器会挂住事件循环，导致 runner 等不到进程结束
  await new Promise((r) => setTimeout(r, 50));
  process.exit(0);
}

main().catch((e) => {
  console.error("Mock Agent 失败:", e);
  process.exit(1);
});
