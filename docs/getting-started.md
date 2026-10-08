# Getting Started

CodeToTemplate (code-to-knowledge) extracts GitHub repository source code into evidence-backed, reusable technical knowledge base documents.

## Prerequisites

- Node.js 22.6+ (the project runs TypeScript directly via `node src/cli.ts`, relying on native type stripping; versions below 23.6 need `--experimental-strip-types`)
- git (the collect stage clones target repositories)

## Install

```bash
git clone <repo-url> CodeToTemplate
cd CodeToTemplate
npm install
```

## Verify

```bash
npm run typecheck
```

No output means the type check passed.

## First Run

Collect and analyze a GitHub repository in pipeline order:

```bash
npm run collect -- --repo <github-repo-url> --ref <branch-or-tag> --output <dir>
npm run analyze -- --manifest <dir>/repository-manifest.json --output <index-dir>
```

Outputs: repository manifest (repository-manifest.json) and the symbol/dependency index (source-map).

## Next Steps

- Command parameters: [Configuration Reference](configuration.md)
- Full pipeline (discover / generate / verify): [How-To Guides](how-to-guides.md)
- Install or runtime issues: [Troubleshooting](troubleshooting.md)
