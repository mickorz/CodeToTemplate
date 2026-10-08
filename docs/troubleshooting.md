# Troubleshooting

## Installation

**`node src/cli.ts` throws syntax errors / does not understand TypeScript**

Node version too old. Type stripping requires Node 22.6+ (on by default since 23.6); upgrade Node or verify the runtime flag.

**`npm install` fails**

Check network and npm registry; the project has only two devDependencies, usually a registry issue.

## Runtime

**collect fails**

Check in order: repo URL and ref exist; network can reach GitHub; disk space for `cache/`.

**analyze reports missing repository cache**

analyze depends on the local cache under `cache/repos/`; run collect for that repository first.

**verify assertions fail**

Outputs do not match gold-set expectations: confirm `knowledge/` holds the latest generate output and the assertions file path is correct.

## Still Stuck

Search `dev-docs/experience/` for past pitfalls; if none, record a new entry (symptom -> investigation -> root cause -> fix) after resolving.
