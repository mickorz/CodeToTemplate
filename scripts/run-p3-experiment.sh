#!/usr/bin/env bash
# P3-0 五组实验执行器（修复版：Bash 格式 + 目录分离 + 失败隔离 + 唯一 run_id）
#
# 用法: bash scripts/run-p3-experiment.sh [task] [seq]
#   task: 实验任务名（默认 presence）
#   seq:  实验轮次号（默认 001，每轮独立 workspace 与结果）
#
# 五组: A（基线）/ B1（facts-only）/ B2（facts-with-snippets）/ B3（evidence-required）/ C（直接源码）
#
# 关键设计（评审修复）:
#   - MCP 预检失败 -> 中止（基础设施失败）
#   - 隐藏测试失败 -> 保存成绩继续下一组（任务实现失败 = 有效实验数据）
#   - 每组独立 workspace + run_id，禁止覆盖历史

set -uo pipefail  # 不用 -e：允许组级失败继续

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK="${1:-presence}"
SEQ="${2:-001}"
BASE_DIR="$ROOT/dev-examples/p3-$TASK"
SHARED="$BASE_DIR/shared"
RESULTS="$BASE_DIR/results"
mkdir -p "$RESULTS"

echo "=== P3-0 $TASK 实验（轮次 $SEQ）==="

# ============ MCP 预检（基础设施失败 -> 中止）============
echo "=== MCP 预检 ==="
if ! (cd "$ROOT" && CTT_PRECHECK=1 node src/mcp/server.ts "$ROOT/knowledge"); then
  echo "[中止] 预检失败，禁止开始实验"
  exit 1
fi

# ============ 单组运行函数 ============
run_group() {
  local group="$1"
  local mode_env="$2"
  local prompt_file="$3"
  local run_id="p3-${TASK}-${group}-${SEQ}"
  local ws="$BASE_DIR/workspace-${group}-${SEQ}"
  local result_file="$RESULTS/${run_id}.json"

  echo ""
  echo "=== 组 $group（run_id: $run_id）==="

  # 清理旧 workspace（每轮独立，不覆盖历史结果）
  rm -rf "$ws"
  mkdir -p "$ws/src" "$ws/test"

  # 只给公开契约测试（hidden 在独立目录，不进 workspace）
  cp "$SHARED/public/contract.test.ts" "$ws/test/"
  node "$ROOT/scripts/eval-isolated.mjs" "$ws" "$SHARED/hidden" --check-only || {
    echo "[中止] 公开测试被误判为隐藏测试"
    return 1
  }

  # 基础配置
  cat > "$ws/package.json" << 'PKG'
{ "name": "presence-migration", "version": "1.0.0", "type": "module", "private": true,
  "scripts": { "test": "node --test test/contract.test.ts" } }
PKG
  cat > "$ws/tsconfig.json" << 'TSC'
{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "strict": true, "allowImportingTsExtensions": true, "noEmit": true } }
TSC

  # C 组：git show 固定 Commit 源码（不复制工作树）
  if [[ "$group" == "c" ]]; then
    mkdir -p "$ws/vendor/src"
    (cd "$ROOT" && git -C cache/repos/yjs__y-protocols show 73b2ff75486c9879843718dc6c7fc52d63aea4fe:src/awareness.js > "$ws/vendor/src/awareness.js")
  fi

  # MCP 组：opencode.json（不同消费模式 + 独立审计）
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
        "CTT_AUDIT_PATH": "$RESULTS/${run_id}-mcp-audit.jsonl",
        "CTT_CONSUMPTION_MODE": "$mode_env"
      }
    }
  }
}
MCPJSON
  fi

  # Agent 运行
  local t0=$(date +%s)
  (cd "$ws" && opencode run "$(cat "$prompt_file")" > "$RESULTS/${run_id}-run.log" 2>&1)
  local agent_exit=$?
  local t1=$(date +%s)
  local duration=$((t1 - t0))
  echo "Agent 耗时: ${duration}s（exit: $agent_exit）"

  # 隐藏测试隔离首跑（失败 = 有效实验数据，不中断）
  local eval_pass=0 eval_fail=0
  if node "$ROOT/scripts/eval-isolated.mjs" "$ws" "$SHARED/hidden" > "$RESULTS/${run_id}-eval.log" 2>&1; then
    echo "首跑: 通过"
  else
    echo "首跑: 有失败（有效实验数据）"
  fi

  # 读取首跑成绩
  local first_run="$ws-first-run.json"
  if [[ -f "$first_run" ]]; then
    eval_pass=$(node -pe "require('$first_run').pass" 2>/dev/null || echo 0)
    eval_fail=$(node -pe "require('$first_run').fail" 2>/dev/null || echo 0)
  fi

  # 汇总元数据
  local prompt_hash=$(sha256sum "$prompt_file" | cut -c1-12)
  cat > "$result_file" << META
{
  "run_id": "$run_id",
  "task": "$TASK",
  "group": "$group",
  "mode": "$mode_env",
  "seq": "$SEQ",
  "duration_s": $duration,
  "agent_exit": $agent_exit,
  "eval_pass": $eval_pass,
  "eval_fail": $eval_fail,
  "prompt_hash": "$prompt_hash",
  "knowledge_commit": "$(node -pe "require('$ROOT/knowledge/y-protocols/presence/repository-manifest.json').commit" 2>/dev/null || echo 'unknown')",
  "model": "$(opencode --version 2>/dev/null | head -1 || echo 'unknown')",
  "workspace": "$ws",
  "prompt_file": "$prompt_file",
  "mcp_audit": "$RESULTS/${run_id}-mcp-audit.jsonl",
  "run_log": "$RESULTS/${run_id}-run.log",
  "eval_log": "$RESULTS/${run_id}-eval.log"
}
META

  echo "结果: pass=$eval_pass fail=$eval_fail -> $result_file"
  return 0  # 组级失败不阻断下一组
}

# ============ 运行五组（顺序执行，组间失败隔离）============
PROMPTS="$SHARED/prompts"

run_group "a"  ""                   "$PROMPTS/prompt-a.txt"   || echo "[警告] A 组基础设施异常"
run_group "b1" "facts-only"         "$PROMPTS/prompt-b1.txt"  || echo "[警告] B1 组基础设施异常"
run_group "b2" "facts-with-snippets" "$PROMPTS/prompt-b2.txt" || echo "[警告] B2 组基础设施异常"
run_group "b3" "evidence-required"  "$PROMPTS/prompt-b3.txt"  || echo "[警告] B3 组基础设施异常"
run_group "c"  ""                   "$PROMPTS/prompt-c.txt"   || echo "[警告] C 组基础设施异常"

# ============ 汇总 ============
echo ""
echo "=== 轮次 $SEQ 完成 ==="
echo "结果汇总："
for g in a b1 b2 b3 c; do
  f="$RESULTS/p3-${TASK}-${g}-${SEQ}.json"
  if [[ -f "$f" ]]; then
    echo "  $g: $(node -pe "const r=require('$f');r.eval_pass+'/'+(r.eval_pass+r.eval_fail)+' (${r.duration_s}s)'" 2>/dev/null || echo '读取失败')"
  else
    echo "  $g: 未运行"
  fi
done
echo "详细报告: $RESULTS/"
