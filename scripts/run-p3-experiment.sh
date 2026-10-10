#!/usr/bin/env bash
# P3-0 五组实验执行器（补丁版：run_status 四态分类 + B2 审计读取 + B3 合规接入 + 防覆盖）
#
# 运行状态分类：
#   valid          Agent 完成，隐藏测试成功执行（含测试未通过的成绩）
#   invalid-tool   MCP 或关键源码读取失败（B2 片段不足 / B3 tool-failure）
#   invalid-infra  环境异常（workspace 构建失败 / 评测器未生成成绩 / Agent 未运行）
#   non-compliant  B3 未执行规定的证据读取（单独统计，不混入合规样本）
#
# 用法: bash scripts/run-p3-experiment.sh [task] [seq]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK="${1:-presence}"
SEQ="${2:-001}"
BASE_DIR="$ROOT/dev-examples/p3-$TASK"
SHARED="$BASE_DIR/shared"
RESULTS="$BASE_DIR/results"
mkdir -p "$RESULTS"

# ============ 预检（基础设施失败 -> 中止）============
echo "=== P3-0 $TASK 实验（轮次 $SEQ）==="
if ! (cd "$ROOT" && CTT_PRECHECK=1 node src/mcp/server.ts "$ROOT/knowledge"); then
  echo "[中止] MCP 预检失败"
  exit 1
fi

# ============ 防覆盖：同 run_id 结果已存在 -> 拒绝 ============
for g in a b1 b2 b3 c; do
  if [[ -f "$RESULTS/p3-${TASK}-${g}-${SEQ}.json" ]]; then
    echo "[中止] 结果已存在: p3-${TASK}-${g}-${SEQ}.json（换新 seq 或删除旧结果）"
    exit 1
  fi
done

# ============ 单组运行 ============
run_group() {
  local group="$1" mode_env="$2" prompt_file="$3"
  local run_id="p3-${TASK}-${group}-${SEQ}"
  local ws="$BASE_DIR/workspace-${group}-${SEQ}"
  local result_file="$RESULTS/${run_id}.json"
  local audit_file="$RESULTS/${run_id}-mcp-audit.jsonl"
  local run_log="$RESULTS/${run_id}-run.log"
  local eval_log="$RESULTS/${run_id}-eval.log"

  echo ""
  echo "=== 组 $group（$run_id）==="

  # -- 工作区构建 --
  rm -rf "$ws"
  if ! mkdir -p "$ws/src" "$ws/test"; then
    echo "[invalid-infra] workspace 创建失败"
    write_result "$result_file" "$group" "$mode_env" "invalid-infra" "workspace_creation_failed" 0 0 "$run_id" "" "$audit_file" "$run_log" "$eval_log"
    return 0
  fi

  # -- 公开测试注入 --
  if ! cp "$SHARED/public/contract.test.ts" "$ws/test/" 2>/dev/null; then
    echo "[invalid-infra] 公开测试文件缺失"
    write_result "$result_file" "$group" "$mode_env" "invalid-infra" "public_test_missing" 0 0 "$run_id" "" "$audit_file" "$run_log" "$eval_log"
    return 0
  fi
  if ! node "$ROOT/scripts/eval-isolated.mjs" "$ws" "$SHARED/hidden" --check-only >/dev/null 2>&1; then
    echo "[invalid-infra] 公开/隐藏测试隔离校验失败"
    write_result "$result_file" "$group" "$mode_env" "invalid-infra" "isolation_check_failed" 0 0 "$run_id" "" "$audit_file" "$run_log" "$eval_log"
    return 0
  fi

  # -- 基础配置 --
  cat > "$ws/package.json" << 'PKG'
{ "name": "presence-migration", "version": "1.0.0", "type": "module", "private": true,
  "scripts": { "test": "node --test test/contract.test.ts" } }
PKG
  cat > "$ws/tsconfig.json" << 'TSC'
{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "strict": true, "allowImportingTsExtensions": true, "noEmit": true } }
TSC

  # C 组：git show 固定 Commit
  if [[ "$group" == "c" ]]; then
    mkdir -p "$ws/vendor/src"
    if ! (cd "$ROOT" && git -C cache/repos/yjs__y-protocols show 73b2ff75486c9879843718dc6c7fc52d63aea4fe:src/awareness.js > "$ws/vendor/src/awareness.js" 2>/dev/null); then
      echo "[invalid-infra] C 组源码 git show 失败"
      write_result "$result_file" "$group" "$mode_env" "invalid-infra" "git_show_failed" 0 0 "$run_id" "" "$audit_file" "$run_log" "$eval_log"
      return 0
    fi
  fi

  # MCP 组配置
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
        "CTT_AUDIT_PATH": "$audit_file",
        "CTT_CONSUMPTION_MODE": "$mode_env"
      }
    }
  }
}
MCPJSON
  fi

  # -- Agent 运行 --
  local t0=$(date +%s)
  (cd "$ws" && opencode run "$(cat "$prompt_file")" > "$run_log" 2>&1)
  local agent_exit=$?
  local t1=$(date +%s)
  local duration=$((t1 - t0))
  echo "Agent 耗时: ${duration}s（exit: $agent_exit）"

  # -- 隐藏测试首跑 --
  node "$ROOT/scripts/eval-isolated.mjs" "$ws" "$SHARED/hidden" > "$eval_log" 2>&1
  local eval_exit=$?
  local first_run="$ws-first-run.json"
  local eval_pass=0 eval_fail=-1  # -1 = 评测器异常

  if [[ -f "$first_run" ]] && node -e "const r=require('$first_run');if(typeof r.pass!=='number')process.exit(1)" 2>/dev/null; then
    eval_pass=$(node -pe "require('$first_run').pass")
    eval_fail=$(node -pe "require('$first_run').fail")
  else
    echo "[invalid-infra] 评测器未生成合法首跑成绩"
    write_result "$result_file" "$group" "$mode_env" "invalid-infra" "eval_no_result" 0 0 "$run_id" "$duration" "$audit_file" "$run_log" "$eval_log"
    return 0
  fi

  # -- B2 审计读取：snippet_sufficient 检查 --
  local run_status="valid"
  local invalid_reason=""
  if [[ "$group" == "b2" && -f "$audit_file" ]]; then
    local snippet_ok=$(node -e "
      const lines = require('fs').readFileSync('$audit_file','utf-8').split('\n').filter(l=>l.trim());
      for (const l of lines) {
        try { const e = JSON.parse(l);
          if (e.tool==='build_reference_context' && e.snippet_sufficient === false) { console.log('false'); process.exit(0); }
        } catch {}
      }
      console.log('true');
    " 2>/dev/null || echo "true")
    if [[ "$snippet_ok" == "false" ]]; then
      run_status="invalid-tool"
      invalid_reason="b2_snippets_insufficient"
      echo "[invalid-tool] B2 片段不足"
    fi
  fi

  # -- B3 合规检查 --
  if [[ "$group" == "b3" && -f "$audit_file" ]]; then
    local b3_verdict=$(node "$ROOT/scripts/check-b3-compliance.mjs" "$audit_file" 2>/dev/null | node -pe "JSON.parse(require('fs').readFileSync(0,'utf-8')).verdict" 2>/dev/null || echo "unknown")
    if [[ "$b3_verdict" == "non-compliant" ]]; then
      run_status="non-compliant"
      invalid_reason="b3_no_source_read"
      echo "[non-compliant] B3 未调用源码工具"
    elif [[ "$b3_verdict" == "tool-failure" ]]; then
      run_status="invalid-tool"
      invalid_reason="b3_source_read_all_failed"
      echo "[invalid-tool] B3 源码读取全部失败"
    else
      echo "B3 合规: $b3_verdict"
    fi
  fi

  # -- 写入结果 --
  local prompt_hash=$(sha256sum "$prompt_file" | cut -c1-12)
  local knowledge_commit=$(node -pe "require('$ROOT/knowledge/y-protocols/presence/repository-manifest.json').commit" 2>/dev/null || echo "unknown")
  local cli_version=$(opencode --version 2>/dev/null | head -1 || echo "unknown")

  cat > "$result_file" << META
{
  "run_id": "$run_id",
  "task": "$TASK",
  "group": "$group",
  "mode": "$mode_env",
  "seq": "$SEQ",
  "run_status": "$run_status",
  "invalid_reason": "$invalid_reason",
  "duration_s": $duration,
  "agent_exit": $agent_exit,
  "eval_pass": $eval_pass,
  "eval_fail": $eval_fail,
  "prompt_hash": "$prompt_hash",
  "knowledge_commit": "$knowledge_commit",
  "agent_cli_version": "$cli_version",
  "model_id": "unknown",
  "workspace": "$ws",
  "prompt_file": "$prompt_file",
  "mcp_audit": "$audit_file",
  "run_log": "$run_log",
  "eval_log": "$eval_log"
}
META

  echo "结果: $run_status pass=$eval_pass fail=$eval_fail -> $result_file"
  return 0
}

# 辅助：快速写失败结果
write_result() {
  local rf="$1" g="$2" m="$3" rs="$4" reason="$5" ep="$6" ef="$7" rid="$8" dur="$9"
  cat > "$rf" << META
{
  "run_id": "$rid", "task": "$TASK", "group": "$g", "mode": "$m", "seq": "$SEQ",
  "run_status": "$rs", "invalid_reason": "$reason",
  "duration_s": ${dur:-0}, "agent_exit": null, "eval_pass": $ep, "eval_fail": $ef,
  "prompt_hash": null, "knowledge_commit": "unknown", "agent_cli_version": "unknown", "model_id": "unknown",
  "workspace": null, "mcp_audit": null, "run_log": null, "eval_log": null
}
META
}

# ============ 运行五组 ============
PROMPTS="$SHARED/prompts"
for entry in "a:":"$PROMPTS/prompt-a.txt" "b1:facts-only:$PROMPTS/prompt-b1.txt" "b2:facts-with-snippets:$PROMPTS/prompt-b2.txt" "b3:evidence-required:$PROMPTS/prompt-b3.txt" "c:":"$PROMPTS/prompt-c.txt"; do
  IFS=':' read -r group mode <<< "$(echo "$entry" | cut -d: -f1-2)"
  local_prompt=$(echo "$entry" | rev | cut -d: -f1 | rev)
  run_group "$group" "$mode" "$local_prompt"
done

# ============ 汇总 ============
echo ""
echo "=== 轮次 $SEQ 完成 ==="
echo "结果汇总（含状态分类）："
for g in a b1 b2 b3 c; do
  f="$RESULTS/p3-${TASK}-${g}-${SEQ}.json"
  if [[ -f "$f" ]]; then
    echo "  $g: $(node -pe "const r=require('$f');r.run_status+' '+r.eval_pass+'/'+(r.eval_pass+r.eval_fail)+(r.invalid_reason?' ('+r.invalid_reason+')':'')" 2>/dev/null || echo '读取失败')"
  else
    echo "  $g: 未运行"
  fi
done
