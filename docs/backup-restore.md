# Offline backup and restore

Use the same Effectory build and Effect 4.0.5 when restoring. Retained revision manifests reject a changed host ABI; this procedure is not an upgrade or migration tool. Keep the source checkout quiet while copying.

```sh
bun run effectory daemon stop --repository /path/to/project
bun run effectory backup /private/backups/project-2026-11-05 --repository /path/to/project --json
bun run effectory restore /private/backups/project-2026-11-05 --repository /path/to/restored-project --json
# Reinstall the application's locked dependencies if it uses packages beyond the host SDK.
bun run effectory daemon start --repository /path/to/restored-project
bun run effectory doctor --repository /path/to/restored-project --json
bun run effectory run list --repository /path/to/restored-project --json
```

Backup and restore are local operations and do not evaluate application code. They acquire exclusive repository ownership and refuse to race a live daemon. The destination must not exist, its parent must exist, and it must be outside the source directory. There is no overwrite or merge mode.

The snapshot contains source/configuration, the SQLite database and any retained WAL, JSON and binary blobs, application revision bundles, extension archives/cache, lockfile, generated facade, local digest-trust decisions, and repository credentials. It excludes `.git`, every `node_modules` directory, daemon connection/log files, and transient ownership/SQLite shared-memory files. Startup recreates canonical SDK and extension dependency links. Credentials and trust decisions make the snapshot sensitive and privileged: store it privately and restore only a snapshot you trust. This is a plaintext local snapshot, not encrypted remote storage.

Every copied file has its SHA-256 and length verified, and the original inventory is checked again before success. Restore verifies the completed manifest before creating its destination. The copy writes files and directories durably and records a completion manifest last. Source symlinks and special files are rejected; generated dependency links are excluded. Fixed limits cap a snapshot at 1 GiB, 50,000 filesystem entries, 128 MiB per file, and a 16 MiB manifest. Application dependencies must be reinstalled from their lockfile when needed; `node_modules` is not part of the backup.

Cancellation waits for the bounded file-copy operation to release ownership. A failed copy removes the destination it just created. Process death can leave an incomplete destination with a copy marker. The daemon refuses to start while that marker exists. Remove the incomplete destination and restore again to a fresh destination; deleting the marker is not a repair. Existing destinations are always preserved.

The integration test backs up a waiting workflow after it publishes an artifact, restores to a different directory, removes the original directory, and resumes the same run and wait. It verifies the old artifact bytes/provenance, the pinned bundle, trusted extension restoration, and execution of an extension task after approval. It also checks live-owner exclusion, existing-destination refusal and modified-file rejection. See `packages/platform-bun/test/backup.test.ts` for the current executable evidence.

Binary installation work must finish before builtin backup. If the dedicated binary-staging directory contains any entry, backup returns Conflict without opening the source database or changing its WAL/shared-memory files. Start then stop the daemon to finish recovery before retrying. Failed binary installation recovery prevents startup and reports its cause; repair permissions or free space and retry. Ordinary pending reclamation continues to copy normally.

The fixed 1 GiB snapshot limit is shared by all repository files; 64 distinct 16 MiB blobs alone reach it. For a larger repository, use the [verified offline-copy procedure](binary-artifacts-api-draft.md#offline-filesystem-copy-procedure), preserving hard links with rsync -aHS. Keep the source stopped, mark the destination incomplete, and verify its full file inventory, lengths and hashes before removing that marker. This manual copy starts directly as a repository; it is not a builtin restore manifest.
