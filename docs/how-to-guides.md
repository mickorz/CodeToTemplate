# How-To Guides

One section per common task, step by step.

## Collect a GitHub Repository

Scenario: build a local manifest for a target repository.

```bash
npm run collect -- --repo https://github.com/owner/repo --ref main --output ./cache/manifests/owner__repo
```

Expected: `repository-manifest.json` appears in the output directory.

## Build the Symbol & Dependency Index

Scenario: produce a source-map from an existing manifest.

```bash
npm run analyze -- --manifest ./cache/manifests/owner__repo/repository-manifest.json --output ./cache/index/owner__repo
```

Prerequisite: the repository is cached locally under `cache/repos/` (produced by collect).

## Trace a Dependency Path Between Two Files

Scenario: assert that file A reaches file B (exit code decides pass/fail in tests).

```bash
node src/cli.ts trace --sourcemap <source-map.json> --from <fileA> --to <fileB>
```

## Generate Knowledge Base Documents

Scenario: run the full pipeline to produce documents.

```bash
npm run discover   # module discovery
npm run generate   # render & publish into knowledge/
```

## Verify Knowledge Evidence

Scenario: validate outputs against gold-set assertions.

```bash
npm run verify
```

Expected: all assertions pass, exit code 0.
