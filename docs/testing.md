# Install & Run Acceptance Checklist

## Overview

Goal: environment works, pipeline runs end to end, outputs pass evidence validation.

## Installation Checks

- [ ] `node --version` >= 22.6
- [ ] `git --version` works
- [ ] `npm install` completes without errors
- [ ] `npm run typecheck` passes

## Smoke Test

- [ ] `npm run collect -- --repo <small-repo> --ref main --output /tmp/smoke` emits a manifest
- [ ] `npm run analyze -- --manifest /tmp/smoke/repository-manifest.json --output /tmp/smoke-idx` emits an index
- [ ] `node src/cli.ts trace --sourcemap <index> --from <A> --to <B>` exits with the expected code

## Final Checklist

- [ ] `npm test` all three suites green
- [ ] `npm run verify` gold-set assertions all pass
