# Changelog

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
