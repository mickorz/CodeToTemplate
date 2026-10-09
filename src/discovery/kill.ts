/**
 * kill.ts —— 统一进程树清理（P0-2：超时/SIGINT/错误退出共用同一路径）
 *
 * Windows 下 child.kill() 无法保证清理嵌套后代（opencode/Bun 等），
 * 一律使用 taskkill /T /F；类 Unix 用进程组 SIGKILL。
 */

import { execFileSync } from "node:child_process";

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
  } catch {
    /* 进程已退出 */
  }
}

/** 活动子进程注册表：并发安全（engine 2 并发时全部 PID 可追踪与回收） */
export class ProcessSupervisor {
  private pids = new Set<number>();

  register(pid: number | undefined): void {
    if (pid) this.pids.add(pid);
  }

  unregister(pid: number | undefined): void {
    if (pid) this.pids.delete(pid);
  }

  /** 回收全部活动进程树（SIGINT / 致命错误时调用） */
  killAll(): number[] {
    const killed = [...this.pids];
    for (const pid of killed) killTree(pid);
    this.pids.clear();
    return killed;
  }

  get size(): number {
    return this.pids.size;
  }
}
