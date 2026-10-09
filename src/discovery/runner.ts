/**
 * runner.ts —— Discovery Agent 运行器（P1-1）
 *
 * 环境级隔离设计：
 *
 * runAgent(agentScript, contextPath, repoDir, whitelist)
 *     ├─> spawn 子进程：node <agentScript> <contextPath>
 *     │     （Agent 只拿到 context 文件路径，拿不到仓库路径/gold-set）
 *     ├─> 受控读取协议（stdout 请求 -> stdin 应答，逐行 JSON）：
 *     │     Agent 发 {op:"read_file", path}   -> runner 校验白名单后回 {ok:true, content}
 *     │                                  或  -> {ok:false, error}（白名单外一律拒绝）
 *     ├─> Agent 发 {op:"done", output}   -> runner 结束并返回 output
 *     └─> 超时/异常兜底：退出码非 0 或超时 => 失败
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { killTree } from "./kill.ts";

export interface AgentRunResult {
  ok: boolean;
  output: string | null;
  error: string | null;
  /** Agent 经协议读取的文件清单（审计用） */
  readLog: string[];
}

const PROTOCOL_IDLE_TIMEOUT_MS = Number(process.env.CTT_AGENT_IDLE_TIMEOUT_MS) || 20 * 60 * 1000; // 活动感知：收到 Agent 消息即重置；可用环境变量覆盖（测试用）

/** 运行 Discovery Agent 子进程，代理全部源码读取（白名单制）；onSpawn 暴露 pid 供外部中断清理 */
export function runAgent(
  agentScript: string,
  contextPath: string,
  repoDir: string,
  whitelist: Set<string>,
  onSpawn?: (pid: number | undefined) => void,
): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve(agentScript), path.resolve(contextPath)], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    if (onSpawn) onSpawn(child.pid ?? undefined);

    const readLog: string[] = [];
    let stdoutBuf = "";
    let output: string | null = null;
    let settled = false;

    const finish = (result: Omit<AgentRunResult, "readLog">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child.pid); // P0-2 修复：统一树清理（child.kill 在 Windows 杀不干净嵌套后代）
      resolve({ ...result, readLog });
    };

    // 活动感知超时：任何 stdout 消息（协议请求/日志/done）都重置计时器
    let timer = setTimeout(() => {
      finish({ ok: false, output: null, error: `Agent 空闲超时（${PROTOCOL_IDLE_TIMEOUT_MS / 60000}min 无消息）` });
    }, PROTOCOL_IDLE_TIMEOUT_MS);
    const resetTimer = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish({ ok: false, output: null, error: `Agent 空闲超时（${PROTOCOL_IDLE_TIMEOUT_MS / 60000}min 无消息）` });
      }, PROTOCOL_IDLE_TIMEOUT_MS);
    };

    function handleLine(line: string) {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // 非 JSON 行视为 Agent 日志，忽略（stderr 已 inherit）
        return;
      }
      if (msg.op === "read_file") {
        const p = String(msg.path ?? "");
        if (!whitelist.has(p)) {
          child.stdin.write(JSON.stringify({ ok: false, error: `白名单外路径拒绝读取: ${p}` }) + "\n");
          return;
        }
        try {
          const content = readFileSync(path.join(repoDir, p), "utf-8");
          readLog.push(p);
          child.stdin.write(JSON.stringify({ ok: true, path: p, content }) + "\n");
        } catch (e) {
          child.stdin.write(JSON.stringify({ ok: false, error: `读取失败: ${(e as Error).message}` }) + "\n");
        }
      } else if (msg.op === "read_range") {
        // P2-4-3 按需读取：行段级源码访问（白名单 + 200 行/次上限）
        const p = String(msg.path ?? "");
        const from = Math.max(1, Number(msg.from ?? 1));
        const to = Math.min(from + 199, Number(msg.to ?? from + 199));
        if (!whitelist.has(p)) {
          child.stdin.write(JSON.stringify({ ok: false, error: `白名单外路径拒绝读取: ${p}` }) + "\n");
        } else {
          try {
            const lines = readFileSync(path.join(repoDir, p), "utf-8").split(/\r?\n/);
            const seg = lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join("\n");
            readLog.push(`${p}:${from}-${to}`);
            child.stdin.write(JSON.stringify({ ok: true, path: p, from, to, total_lines: lines.length, content: seg }) + "\n");
          } catch (e) {
            child.stdin.write(JSON.stringify({ ok: false, error: `读取失败: ${(e as Error).message}` }) + "\n");
          }
        }
      } else if (msg.op === "done") {
        output = typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output ?? null);
      }
      resetTimer(); // 活动感知：收到消息重置空闲计时
    }

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) handleLine(l);
    });

    child.on("close", (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (code !== 0) {
        finish({ ok: false, output: null, error: `Agent 退出码 ${code}` });
      } else if (output === null) {
        finish({ ok: false, output: null, error: "Agent 结束但未发送 done 消息" });
      } else {
        finish({ ok: true, output, error: null });
      }
    });

    child.on("error", (e) => finish({ ok: false, output: null, error: `Agent 启动失败: ${e.message}` }));
  });
}
