# pi-file-tools

A TypeScript ESM Pi extension providing `mkdir`, `copy`, `rename`, `trash`, `backup`, and `temp` on Windows/Linux. There is no permanent-delete fallback for trash put.

## Development

- Node.js >=22.19; install locked dependencies with `npm ci --ignore-scripts` only when needed.
- `npm run verify` runs TypeScript, Biome and unit tests.
- `npm run test:host` checks the official Pi loader with an isolated config/store.
- `npm run test:scale` exercises 16K historical records and a real 16K-file scan.
- `npm run test:user-settings` only loads actual user settings; it emits no maintenance event.
- Windows: `powershell -NoProfile -File ./scripts/native-audit.ps1`, `npm run test:windows` and `npm run test:links:windows`.
- Linux: `npm run test:linux`; a Windows-host skip is not Linux verification.

## Structure and safety

- `src/managed/` owns policy normalization, settings, snapshots and the atomic registry.
- `src/trash/` and `src/native/` own OS recycle-bin backends and helpers.
- Preserve native callback guards, no-clobber restores and uncertain-outcome errors.
- Never retry an uncertain mutation before inspecting its source and OS-bin identity.
- Managed stores are shared across projects: test only fresh owned IDs, preserve unrelated additions and never assume the registry is exclusive.
- Live Windows tests may permanently purge only their own fresh fixture IDs. Never clear the entire user bin as cleanup.
- Configuration lives outside the repo; `file-tools.example.json` is the distributable example. Do not commit a user's `file-tools.json`.
- Use the existing session timer; do not add a resident cleanup service.

## Evidence and handoff

- README.md is the usage authority; VERIFICATION.md indexes current gates and gaps.
- Keep failed/rejected receipts and their original scripts; never edit a historical failure into a pass.
- `verification/` is a local-only ignored archive. Preserve its raw failures privately; publish only a privacy-reviewed summary. Archived one-off scripts are not general test entry points.
- Bind new host/native/scale receipts to the source-input digest from `scripts/source-state.ts`. That digest is not a Git commit hash or a runtime-memory hash.
- Source, tests, scripts and listed root metadata affect that digest; docs and verification outputs do not.
- Before committing, verify staged blobs represent the tested inputs, with Git text normalization reported separately from raw evidence bytes.
- Never publish local receipts, machine paths, OS item IDs or private recovery refs. Push only the public main branch; never mirror all local refs to the public remote.
- Linux native integration, maximum-capacity throughput and real-time long retention remain bounded as described in VERIFICATION.md.
