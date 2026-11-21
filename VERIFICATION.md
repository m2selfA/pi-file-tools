# Verification

[verification-summary.json](verification-summary.json) records the latest local test summary for this public source snapshot. Raw logs are intentionally local-only because they contain machine paths, OS item IDs and unrelated workspace metadata. Reproduce checks from source using the commands below.

## Reproducible gates

| Command | Scope |
|---|---|
| `npm run verify` | TypeScript, Biome and unit tests |
| `npm run test:host` | Two official Pi-loader rounds with isolated settings and actual tool calls |
| `npm run test:scale` | 16K historical records and an actual 16K-file directory scan |
| `npm run test:windows` | Windows native recycle/restore and selected-only cleanup |
| `npm run test:links:windows` | Deep nested junctions, broken/cyclic links and file/directory symbolic links: recycle/restore/purge with unchanged outside sentinels; missing OS privilege is an explicit skip |
| `npm run test:linux` | Native Linux integration; skipped on other platforms |
| `npm run test:user-settings` | Optional read-only loader check when a local settings file exists |

On Windows, also run `powershell -NoProfile -File ./scripts/native-audit.ps1` to check the PowerShell AST, C# declarations and four callback guards. Native tests may permanently remove only their own fresh fixture IDs; they do not clear the user's entire recycle bin.

## Preflight prompt checks

The preflight tests render prompts using the locked development SDK and cover default-on behavior, explicit disable, next-run settings reload, fixed-key deduplication, hidden tools, custom prefixes, existing forced prompts and string-only event fixtures. They also check strict boolean parsing, preservation during policy saves, and no managed-store creation or AGENTS modification by the hook.

The official-loader smoke test invokes the actual registered `before_agent_start` callback in each loader round, toggles an isolated settings file, and checks owned marker presence, deduplication and forced-prefix preservation. This is callback/prompt-construction evidence, not an actual provider request or a measurement of model compliance. Later handlers that replace the entire prompt may still discard prior additions.

## Evidence boundaries

- The public summary is derived from local receipts. The private raw receipts are preserved separately and are not independently inspectable from this repository. No independent advisor approval is claimed.
- Source-input hashes cover the files selected by `scripts/source-state.ts`; they are not Git commit hashes, binary hashes or runtime memory-image hashes.
- The 16K fixtures verify metadata roundtrips and recursive scanning, not native recycling throughput at the maximum configured count.
- Real-time long retention, maximum-capacity payloads and Linux-host behavior require their own native runs. A platform skip is not a pass.
- Shared stores can receive unrelated additions during a test. Verify owned and baseline IDs, preserve unrelated items and record concurrent deltas.
- Local historical failures remain failures. Redaction and public summaries must not relabel them as passes.
