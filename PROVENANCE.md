# Provenance

Independent implementation in the user's existing empty Git repository. No upstream history or source copied verbatim.

Reference: https://github.com/ryan-griffin/pi-file-tools

Pinned reference commit: `4849c161ca8018fddd4d8963ec54b729f50e88f0`, inspected with GitHub MCP on 2026-11-21.

Read upstream README.md, package.json, src/index.ts, src/paths.ts, src/shared.ts, src/tools/mkdir.ts, src/tools/copy.ts and src/tools/delete.ts for behavior. GitHub reports no license and the root lists no LICENSE; this repository's MIT license applies to this independent implementation. The initial implementation was developed locally without a remote. Public distribution uses a clean source snapshot; raw environment-specific validation archives and private local history are not included.

At the initial review on 2026-11-21, installed Pi and the inspected GitHub main package metadata both reported 1.6.0. Read official packages.md, relevant extensions.md sections and dynamic-tools/tool-override examples. Host packages remain wildcard peerDependencies; development and transitive versions are locked in package-lock.json.

Native API references inspected:

- https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags
- https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperationprogresssink-predeleteitem
- https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/ne-shobjidl_core-_transfer_source_flags
- https://specifications.freedesktop.org/trash/1.0/

Read Byron/trash-rs Windows implementation to cross-check naming/failure behavior; no Rust source incorporated.

Windows put requests FOFX_RECYCLEONDELETE and its callback rejects deletes lacking TSF_DELETE_RECYCLE_IF_POSSIBLE. Purge is a distinct internal action. Exact enumeration uses System.FileName instead of Explorer display names. Inputs cross the helper boundary as JSON on stdin, never interpolated PowerShell source. Irreversible test cleanup is restricted to fresh fixtures.

The centralized `backup`/`temp` lifecycle design was informed by static inspection of `metabolism-tools/workspace-metabolism`, `laaielichter/Agentdisk`, and `termaxa/termaxa` on 2026-11-21. Their ideas were independently implemented here. No candidate was installed or copied. The implementation uses a local atomic registry, SHA-256 snapshot checks, policy dry-runs, leases, pins, OS-trash recovery windows, and Pi session handlers without a resident service.
