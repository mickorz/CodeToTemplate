/**
 * run-p3-experiment.sh —— P3-0 五组实验配置与运行器
 *
 * 五组：
 *   A   无参考（基线）
 *   B1  MCP facts-only（当前知识呈现方式）
 *   B2  MCP facts-with-snippets（摘要 + 关键源码行段原文）
 *   B3  MCP evidence-required（要求 Agent 必须按需读取并核对证据）
 *   C   直接提供固定 Commit 原始源码
 *
 * 每组：新建干净 workspace -> MCP 预检 -> Agent 运行 -> 隐藏测试隔离首跑
 * run_id 格式：p3-<task>-<group>-<seq>
 */

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK="${1:-presence}"
BASE_DIR="$ROOT/dev-examples/p3-$TASK"
SHARED="$BASE_DIR/shared"

# --- 预检 ---
echo "=== MCP 预检 ==="
CTT_PRECHECK=1 node "$ROOT/src/mcp/server.ts" "$ROOT/knowledge" || {
  echo "[中止] 固定 Commit 预检失败，禁止开始实验（防止把工具故障误判为知识理解问题）"
  exit 1
}

# --- 运行单组 ---
run_group() {
  local group="$1" mode_env="$2" prompt_file="$3"
  local ws="$BASE_DIR/workspace-$group"
  local run_id="p3-$TASK-$group-001"

  echo ""
  echo "=== 组 $group（run_id: $run_id）==="
  rm -rf "$ws"
  mkdir -p "$ws/src" "$ws/test"
  cp "$SHARED/contract.test.ts" "$ws/test/" # 只给公开契约

  # 隐藏测试不在 workspace（eval-isolated 首跑时注入）
  node "$ROOT/scripts/eval-isolated.mjs" "$ws" "$SHARED" --check-only

  # 基础配置
  cat > "$ws/package.json" << 'PKG'
{ "name": "presence-migration", "version": "1.0.0", "type": "module", "private": true,
  "scripts": { "test": "node --test test/contract.test.ts" } }
PKG
  cat > "$ws/tsconfig.json" << 'TSC'
{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "strict": true, "allowImportingTsExtensions": true, "noEmit": true } }
TSC

  # C 组：vendor 源码
  if [[ "$group" == "c" ]]; then
    mkdir -p "$ws/vendor/src"
    cp "$ROOT/cache/repos/yjs__y-protocols/src/awareness.js" "$ws/vendor/src/"
  fi

  # MCP 组：opencode.json（不同消费模式）
  if [[ "$group" == b* ]]; then
    cat > "$ws/opencode.json" << MCPJSON
{
  "mcp": {
    "codetotemplate": {
      "type": "local",
      "command": ["node", "$ROOT/src/mcp/server.ts", "$ROOT/knowledge"],
      "enabled": true,
      "environment": {
        "CTT_REPOS_ROOT": "$ROOT/cache/repos",
        "CTT_RUN_ID": "$run_id",
        "CTT_AUDIT_PATH": "$BASE_DIR/mcp-audit-$group.jsonl",
        "CTT_CONSUMPTION_MODE": "$mode_env"
      }
    }
  }
}
MCPJSON
  fi

  # Agent 运行
  local t0=$(date +%s)
  (cd "$ws" && opencode run "$(cat "$prompt_file")" > "$BASE_DIR/$group-run.log" 2>&1)
  local t1=$(date +%s)
  echo "耗时: $((t1 - t0))s"

  # 隐藏测试隔离首跑
  node "$ROOT/scripts/eval-isolated.mjs" "$ws" "$SHARED"
  local exit_code=$?
  echo "组 $group 完成（eval exit: $exit_code）"
  return $exit_code
}

# --- 主流程 ---
echo "=== P3-0 $TASK 实验 ==="

run_group "a"   ""                  "$SHARED/prompt-a.txt"
run_group "b1"  "facts-only"        "$SHARED/prompt-b1.txt"
run_group "b2"  "facts-with-snippets" "$SHARED/prompt-b2.txt"
run_group "b3"  "evidence-required" "$SHARED/prompt-b3.txt"
run_group "c"   ""                  "$SHARED/prompt-c.txt"

echo ""
echo "=== 全部完成 ==="
echo "首跑结果："
for g in a b1 b2 b3 c; do
  f="$BASE_DIR/workspace-$g-first-run.json"
  if [[ -f "$f" ]]; then
    echo "  $g: $(node -e "const r=require('$f');console.log('pass='+r.pass+' fail='+r.fail)")"
  fi
done
