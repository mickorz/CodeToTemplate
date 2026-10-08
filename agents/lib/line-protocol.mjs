/**
 * line-protocol.mjs —— Agent 侧行协议客户端（P1-2）
 *
 * 受控读取协议的 stdin 端解析：runner 的应答可能跨多个 chunk（大文件 JSON 可达数百 KB），
 * 必须累积缓冲按换行切分，不能假设一个 data 事件就是一条完整消息。
 */

export function makeLineReader() {
  let buf = "";
  const waiters = [];
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  return function readLine() {
    return new Promise((resolve) => waiters.push(resolve));
  };
}
