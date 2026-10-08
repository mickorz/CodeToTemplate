# Contributor Guide

For project contributors. Dev-process docs (design, pitfalls, progress) live in `dev-docs/` (not in git).

## Environment & Common Commands

- Node.js 22.6+, no build step (TS runs from source)
- `npm run typecheck` — tsc --noEmit
- `npm test` — failure injection + discovery contract + generate contract

## Architecture at a Glance

```text
collect (collector)  ->  repository-manifest.json
analyze (analyzer)   ->  source-map symbol/dependency index
discover (discovery) ->  module discovery (agent-assisted)
generate (generate)  ->  render & publish knowledge docs
verify (knowledge)   ->  gold-set assertion validation
```

`src/cli.ts` is the single CLI entry; subcommand dispatch is documented in its header comment.

## Tests

```bash
npm test        # test/failure-injection + discovery-contract + generate-contract
npm run verify  # gold-set assertions (openworkbuddy sample)
```

When contracts change, update the matching contract tests under `test/`.

## Local Development Loop

1. Change the module under `src/`
2. `npm run typecheck` + `npm test`
3. Smoke-run `collect -> analyze` against a small repository
4. Archive process docs into `dev-docs/` by type (categories in root CLAUDE.md)

## Release

Private project; no npm publish flow.
