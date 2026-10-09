/**
 * hang-agent.mjs —— 测试用挂起 Agent（超时清理验证）
 *
 * 立即派生一个长驻子进程（模拟 opencode 嵌套进程树），然后主进程挂起不响应——
 * 验证 runner 空闲超时后 taskkill /T 能清理整棵树。
 */

import { spawn } from "node:child_process";

// 嵌套子进程：ping -n 300 自持 5 分钟（Windows 可靠）
const grandchild = spawn("ping", ["-n", "300", "127.0.0.1"], { stdio: "ignore" });
console.error(`[hang-agent] 已派生子进程 pid=${grandchild.pid}，主进程挂起`);

// 不发 done，保持静默触发空闲超时
setInterval(() => {}, 1 << 30);
