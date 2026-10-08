// 假监护模块
const READY_MS = 20000;
function create(opts) {
  return { readyMs: READY_MS, retry: opts.retry };
}
module.exports = { create };
