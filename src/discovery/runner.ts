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

export interface AgentRunResult {
  ok: boolean;
  output: string | null;
  error: string | null;
  /** Agent 经协议读取的文件清单（审计用） */
  readLog: string[];
}

const PROTOCOL_TIMEOUT_MS = 120_000;

/** 运行 Discovery Agent 子进程，代理全部源码读取（白名单制） */
export function runAgent(
  agentScript: string,
  contextPath: string,
  repoDir: string,
  whitelist: Set<string>,
): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve(agentScript), path.resolve(contextPath)], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const readLog: string[] = [];
    let stdoutBuf = "";
    let output: string | null = null;
    let settled = false;

    const finish = (result: Omit<AgentRunResult, "readLog">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ...result, readLog });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, output: null, error: `Agent 超时（${PROTOCOL_TIMEOUT_MS / 1000}s）` });
    }, PROTOCOL_TIMEOUT_MS);

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
      } else if (msg.op === "done") {
        output = typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output ?? null);
      }
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
