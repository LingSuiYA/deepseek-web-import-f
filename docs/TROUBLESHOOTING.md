# Troubleshooting

## "corrupt session log: seq gap in committed region" after restart

Symptom: after restarting DSH, a session fails to load / resume with

```
Error: corrupt session log: seq gap in committed region at line N (expected X, got Y)
```

This is a **DSH recovery-cursor issue, not this plugin's fault**. Two conditions
together trigger it:

1. `session/end-seed` was committed by a **live session** as a **separate append
   batch** (DSH's own agent loop does this when creating/resuming a session whose
   seed tail is not already an end-seed marker);
2. on the next startup, DSH's recovery cursor does not count that batch, so the
   first post-resume write reuses the end-seed's seq → duplicate seq → the
   committed region is truncated at the duplicate and everything after it becomes
   unreadable.

This plugin imports sessions by writing the whole seed (title + messages +
`session/end-seed`) in **one** `sessionPersistence.append` batch, so an import
itself does not trigger the bug. However, once you **open an imported session and
keep chatting**, subsequent writes go through DSH's live-session machinery again,
so the same DSH bug can affect any session — imported or not.

Workaround: manually repair the affected `~/.dsh/sessions/**/session.jsonl.zstd`
by removing the duplicate line (the separately-committed `session/end-seed` whose
seq was reused), restoring contiguous seqs, and re-encoding the zstd frame. Take
a backup first. Keep `agent/inbox/spliced` insert/remove pairs intact.

This was also reported upstream at
https://github.com/deepseek-ai/deepseek-harness/discussions/2817.

## A session imported by an old version no longer opens after a DSH upgrade

Symptom: an **imported** session fails to load with

```
历史加载失败：failed to observe session "session-4":
  format v2 surface before first step cannot acquire a system head without
  changing chronology; source v0 artifact remains unchanged
  (raw log: C:\Users\<you>\.dsh\sessions\<project>\session-4\session.jsonl.zstd)
  (gateway/internal)
```

Cause: sessions imported by plugin **0.1.0** (before PR #3, 2026-09-28) were
written as `turn/start → user/message → step/start → …`. DSH's v2→v3 migration
inserts the system head at the log's first `step/start` and **refuses** a log
whose first surface event (`user/message`, `assistant/message`, `tool/result`)
comes before it — such a log cannot be migrated without changing chronology.

Version 0.2.x of this plugin writes the correct order (`turn/start → step/start →
user/message → assistant/message → step/end → turn/end`), so **new imports are
not affected**. The damage is in the artifact already on disk: upgrading DSH does
not rewrite old logs, it only migrates them on read, and that migration fails.

Two ways out (neither needs a plugin change):

1. **Repair the old log** with the bundled tool — it moves the leading surface
   events to just after the first `step/start`, permutes only the seq values of
   that window, leaves every other record (including `seq0`-carrying
   reasoning-chunk rows) untouched, and backs the original up first:

   ```sh
   # dry run: list what would change, write nothing
   node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions

   # repair in place (backups land next to the sessions root)
   node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions --apply

   # additionally re-open each repaired session through the real DSH backend
   # (run from a directory where the DSH packages resolve)
   node tools/fix-surface-before-step.mjs --root ~/.dsh/sessions --apply --verify
   ```

   Restart DSH (or refresh the page) afterwards; the repaired session migrates on
   its first open.

2. **Re-import the conversation** with the current plugin version. You get a new,
   correctly ordered session; the old, unreadable one stays in the list (DSH's
   persistence has no delete API — archive it from the workspace).

Which sessions are affected? Only ones imported by 0.1.0 and never re-imported.
Sessions written by DSH's own chat loop are fine — the old importer is the only
writer that used the wrong order. The tool above names every artifact it would
repair, so a dry run answers this for your profile in one command.
