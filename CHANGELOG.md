# Changelog

## 0.3.0 - 2026-11-22

- Eliminate lock contention across concurrent Pi sessions: skip SHA-256 during `temp` scans, move `backup create` staging and `restore` copy-out outside the global store lock, and make `list`/`inspect`/`policy` previews lock-free.
- Add in-process lock queues, atomic `owner.json` diagnostics, PID-reuse-aware stale-lock detection (refusing auto-reclaim when `creating`/`recycling`/`purging` states exist), and cross-process `WindowsTrash` serialization.
- Make `session_start` maintenance non-blocking and cancellable on `session_shutdown`, deduplicate background sweeps via `.maintenance.lock` and `lastSweep` cooldown, bound per-sweep cleanup actions, and suppress raw stderr writes in interactive TUI mode.
- Add Pi session identity (`sessionId`, `sessionFile`), lightweight `sessions/` heartbeats protecting active-session `temp` items, `list` `scope` filtering (`session`/`project`/`all`), and isolation of historical `failed` items from unrelated sessions.
- Add optional `lockWaitMs`, `sweepCooldownMinutes`, and `autoReclaimStaleLocks` settings plus multi-process and native concurrency tests.


## 0.2.4 - 2026-11-22

- Declare one controller-local filesystem scope for all six tools and clarify that paths resolve against the local Pi cwd, never an active SSH remote cwd.
- Add SSH-specific temp/backup guidance: temp paths stay local, backup never reads remote trees, and remote trees must be downloaded first.
- Document the family-wide boundary, mounted-share caveat and the fact that this is prompt/doc guidance rather than a path interceptor.
- Add unit and official-loader assertions for the six descriptions, preflight section and managed SSH rules; no file-operation behavior changed.


## 0.2.3 - 2026-11-21

- Treat nested temp symlinks/junctions as opaque leaves without scanning target contents; retain strict backups and root redirection guards.
- Preserve Windows link type and raw targets during temp restore using bounded read-only reparse metadata queries.
- Isolate inspection errors from mutation states and report partial maintenance with explicit unknown usage.
- Use target-level recovery/release/touch checks, category-level admission, and timers independent of first-sweep success.
- Add native deep-link lifecycle, old-digest compatibility and confirmed-versus-uncertain recovery gates.


## 0.2.2 - 2026-11-21

- Add a default-on `before_agent_start` preflight prompt, configurable with the top-level boolean `preflightPrompt`.
- Reload the switch on each run, preserve AGENTS files and unrelated prompt content, and deduplicate the owned prompt section.
- Cover hidden tools, custom prefixes, existing forced prompts and string-only event shapes; verify the actual loader callback without model requests.


## 0.2.1 - 2026-11-21

- Accept binary human-readable count/size strings and duration strings in settings and Pi tool inputs; preserve their spelling when saving policies.
- Raise policy limits to 64K active items, 1 PiB budgets and 100-year durations, with matching registry and tree bounds.
- Bound registry writes before replacement, use linear-time directory registration checks and reject unsafe aggregate arithmetic.
- Add 16K metadata/tree checks and a read-only official-loader probe for actual user settings.
- Preserve raw verification archives in Git and document source/evidence ownership rules.

## 0.2.0 - 2026-11-21

- Add `file-tools.json` settings for storage root and per-category retention/count/byte limits, with HOME expansion and atomic policy persistence.
- Add centralized `backup` and `temp` tools with policy previews, leases, pins and bounded cleanup.
- Add SHA-256 snapshot verification, atomic registry updates and OS-trash recovery windows.
- Run maintenance at session start and through a cancellable session-scoped sweep.

## 0.1.0 - 2026-11-21

- Independently implement mkdir, copy and rename for Pi.
- Replace permanent-delete tool with trash put/list/restore/empty.
- Add Windows Shell Recycle Bin backend and Freedesktop home-trash backend.
- Preserve overwritten copy/rename targets in the OS trash.
- Add bounded subprocess execution, protected paths, scoped empty and native test probes.
