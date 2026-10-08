# Configuration Reference

This is a private CLI tool (`"private": true`) with no standalone config file; configuration is passed via per-command CLI arguments.

## Commands & Arguments

| Command | Arguments | Description |
|---------|-----------|-------------|
| `npm run collect` | `--repo <url>` `--ref <ref>` `--output <dir>` | M1 collect: clone repo and emit repository-manifest.json |
| `npm run analyze` | `--manifest <path>` `--output <dir>` | M2 analyze: build symbol/dependency index from manifest + local cache |
| `npm run trace` | `--sourcemap <path>` `--from <file>` `--to <file>` | BFS reachability assertion between two files (exit code 0/1) |
| `npm run discover` | see `src/cli.ts` header comments | module discovery |
| `npm run generate` | see `src/cli.ts` header comments | render and publish knowledge docs |
| `npm run verify` | `<knowledgeDir> <repoDir> <assertions.json>` | validate knowledge docs against gold-set assertions |

## Cache & Output Locations

- `cache/` — local clone cache produced by collect
- `knowledge/` — knowledge base document output

## Upgrade

Bump dependencies in `package.json` and re-run `npm install` (devDependencies: typescript, @types/node only).

## Uninstall

Delete the project directory; caches and outputs live inside it, no global residue.
