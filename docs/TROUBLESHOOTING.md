# Troubleshooting

> 本文档主体继承自上游 `wpc0323/deepseek-web-import`；末尾的「导入相关」一节是本仓库补充。

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

## 导入相关

### 侧边栏显示「未命名」

侧边栏标题读的是投影缓存（`~/.dsh/storages/session_projcache`），不是每次读会话日志。
导入后宿主会尝试写一次缓存，导入结果里的 `titleCached` 字段报告结果：

| 值 | 含义 |
|---|---|
| `written` | 已做耐久 checkpoint，刷新后应显示标题 |
| `ok` | 冷读折叠成功，但未走 checkpoint 路径 |
| `no_cache` | 宿主没有 `sessionProjectionCache` 服务 |
| `no_events` | 读回的日志为空 |
| `error` | 预热抛错，原因在 DSH 日志 |

如果刷新后仍是「未命名」，用诊断区确认会话日志里有 `session/title` 事件；没有则是导入阶段的问题，有则是缓存路径的问题。

### 图片或附件显示 `0/N`

表示找到了 N 个附件但一个都没存下。先看 DSH 日志里的 `projection warm-up` /
`image import failed` 记录，再确认 `userToken` 是否过期（过期时连目录都拉不到）。

### 启动报 `deepseek-web-import: import failed`

启动期客户端模块加载失败。用启动对话框的「禁用第三方插件」先把 DSH 拉起来，然后只回滚客户端文件（见 [INSTALL-FROM-ZERO](INSTALL-FROM-ZERO.md#只回滚客户端保留导入功能)）。
