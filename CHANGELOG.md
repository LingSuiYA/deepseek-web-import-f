# Changelog

## 0.2.0-dlc.5 (2026-10-18)

### 新增

- **批量导入模式**：勾选后导入不逐条刷新，累计计数并显示「完成导入并刷新（N 条）」按钮，
  点一次统一刷新。偏好存 `localStorage`（`dswi.batchMode`）。
- **导入即显示真实标题**：侧边栏标题来自投影缓存（`storages/session_projcache` 的 `rows.title`），
  新导入的会话没有缓存条目，所以要点开一次才有标题。现在导入成功后调用
  `sessions.refreshProjections(sessionId)` 预热，刷新后直接显示 DeepSeek 原标题。
- `tools/apply-dlc.mjs` 增加 stage 5（纯客户端改动）。

## 0.2.0-dlc.4 (2026-10-18)

### 新增

- **导入后自动刷新**：导入成功后 1.2 秒自动刷新页面，侧边栏直接出现新会话，不用再手动 F5。
  「获取对话目录」旁新增复选框，关闭后连续导入不会被打断；偏好存 `localStorage`。
- `tools/apply-dlc.mjs` 增加 stage 4（纯客户端改动，无需重启宿主，刷新页面即生效）。

## 0.2.0-dlc.3 (2026-10-18)

### 修复

- **Markdown 杂质清理**：DeepSeek 的 `[reference:N]` 引用标记（目标只存在于实时搜索状态，
  历史负载里没有 URL）和表格里的零散 `<br>` 会原样显示。新增 `lib/text.js` 在导入时清除两者，
  围栏代码块内保持原样。
- 实测：同一条对话导入后引用标记 26 → 0、`<br>` 1 → 0，正文其余部分与网页端逐字节一致。
- `tools/apply-dlc.mjs` 增加 stage 3，已贴 stage 1/2 的安装可增量升级。

## 0.2.0-dlc.2 (2026-10-18)

### 新增

- **文档附件导入**：`FILE` fragment 中 `is_image: false` 的条目（PDF / Word / 文本等）
  按 `?ty=r` 取原件，流式写入临时文件后交给 `attachments.saveFileStream`
  （无该接口时退回 `saveFile`），事件中写入 `{ type: 'file', attachment }`。
- **不设人为大小上限**：网页端默认单文件 100 MB（`0x6400000`）、最多 50 个，模型还可用
  `file_feature.max_upload_file_size` 放宽；导入侧只保留 1 GiB 失控保护，且优先按
  `file_size` 判断，避免把浏览器允许的文件拦掉。
- 文件名按 `sanitizeFileName` 清洗（去路径分隔符与控制字符、限长 180）。
- 结果行新增「含附件 N 个」/ `0/N`。
- `test/files.test.mjs`：9 项（URL、组包、流式保存、回退路径、大小保护、服务缺失）。
- `tools/apply-dlc.mjs` 改为两阶段（图片 → 文档），已贴过 stage 1 的安装可增量升级。

### 说明

- 文档字节恢复的是原件；模型上下文仍只有 DeepSeek 当时存下的文本（解析正文不在历史负载里）。
- 带 `file` 块的历史在续聊时依赖模型适配器接受该块，需用一条文档对话验证一次。

## 0.2.0-dlc.1 (2026-10-18)

**DLC 补丁层**：基于上游 `0.2.0`，只新增「图片附件导入」这一项能力。

> 早先针对上游 0.1.0 的 5 项兼容性修复（fragments 正文提取、会话 v4 header、
> `stream` 字段、持久化 handle 调用、长对话截断）已被上游 0.2.0 全部吸收，
> 本层不再单独维护；那段历史保留在 `legacy/0.1.0-flat` 分支。

### 新增

- **图片导入**：解析用户消息 `FILE` fragment 的 `files[]`（`id` / `file_name` /
  `is_image` / `width` / `height` / `status` / `signed_path`，兼容 snake_case 与
  camelCase），经 `GET /api/v0/file/fetch_files?file_ids=…` 刷新签名路径，再从
  `https://files.deepseeksvc.com/api<path>?ty=p` 下载（`ty` 必填，`&fmt=jpeg` 转码，
  省略时为 WebP），用魔数识别真实格式后交给 DSH `attachments` 服务落盘，并在
  `user/message` 中写入 `{ type: 'image', attachment }`：文本在前、图片在后。
- 单张图片失败不阻断文本导入；批量保存被拒时逐张重试。
- 设置页结果新增「含图片 N 张」，全部失败时显示 `0/N`。
- 新增 `lib/images.js` 与 `test/images.test.mjs`（字段兼容、MIME 嗅探、URL 构造、
  事件拼装、下载/保存桩）。
- 新增 `tools/apply-dlc.mjs`：把补丁层贴到**市场托管的上游包**上（默认
  `~/.dsh/profiles/desktop/node_modules/deepseek-web-import`）。可重复执行、
  写入换新 inode（不破坏 pnpm 硬链接）、锚点不匹配即报错。市场更新基线后重跑一次即可恢复图片导入。

### 验证

- 上游原有测试全部通过（`events` 28、`host-routes` 41、`http-limits` 6、`i18n` 5、
  `persistence-evidence` 8），新增图片用例 9 项。
- 真实账号端到端：4 条消息 / 1 图（`imageFiles=1, imageCount=1`）、42 条消息 / 无图
  （回归），会话格式 v4。

## 0.2.0 (2026-10-14)

### 第二轮：i18n 与审阅修正

#### 新增

- **界面多语言**（issue #1）：设置页全部文案（标题、说明、状态、错误、按钮、诊断）改为词典表 `key → [zh, en]`，
  注册进宿主 locale 命名空间（`ctx.locale`），跟随 DSH/浏览器语言；未注册的语言回落到英文；宿主没有 locale
  服务时按浏览器语言自行判断。切换语言时重新注册设置页，标签与内容即时更新。
- 失败响应统一携带**稳定错误码**（`save_failed`/`probe_refused`/`credentials_unavailable`/`persistence_unavailable`/
  `workspace_registry_unavailable`/`subprocess_unavailable`/`token_empty` 等），由前端本地化；未知 code 仍显示后端原文。
- 失败响应新增 `sessionId`：写入失败时也能知道创建了哪个会话（持久化接口没有删除，便于人工清理）。
- `test/i18n.test.mjs` 与真实 `node:http` 的请求体/方法用例（413、400、405）；单测总数 95（`npm test` 现在自动跑全部 `test/*.test.mjs`，CI 同步）。
- README 按 DSH 生态约定拆成**英文主文件** `README.md` + 中文 `README.zh.md`（两份都有语言切换行，均随插件包一起分发）。

#### 修复

- **413 现在真的能送达**：请求体超限时原先 `req.destroy()` 会连带销毁 socket，浏览器看到的是连接重置而非 413；
  改为排空请求体后回 413（`Connection: close`）。原来的测试把 `req.destroy()` 伪造成空函数，因此测不出真实行为。
- **路由处理器返回 promise**：`handlerFor` 之前返回 `undefined`，路由内的 rejection 无法进入 DSH 的错误日志与 400 兜底，
  而是变成 unhandled rejection；同时给 req/res 挂 `error` 监听（调用方中途断开不再升级为未处理异常）。
- **凭据服务的报错在写入日志前抹掉 token**：该报错可能内嵌被拒绝的值，而 README 恰恰鼓励贴日志报障。
- **probe 收紧到默认端口**：`https://chat.deepseek.com:8443/…` 之前会放行，现在只接受默认端口（或省略端口）。
- **目录接口检查截断**：响应被截断时返回 `too_large`，不再表现为「响应非 JSON（可能 Token 无效）」。
- **标题兜底恢复**：目录侧不再把无标题会话写成 `(无标题)`（前端另有本地化显示），否则会挤掉 `dsh-session-title` 的兜底标题。
- **版本首猜取已存会话的最大版本**：`list()` 不保证顺序，而同一 profile 可能同时存在多代会话（v0 与 v4 混存是真实情况），
  按列表第一条猜会猜错并白白浪费一次拒绝重试。
- **拒绝文案多模式匹配**：除 `requires Session format vN` 外，同时匹配 `header version must be N`、`reads only vN`、
  `format version must be N`（大小写不敏感），避免换一个构建就退化成硬失败。
- **只有思维链的回答也补正文块**：判断条件从「有没有块」改为「有没有 text 块」——思考中被中断的回答此前会渲染成空回合。
- **传输层流式限流**：字符上限只是事后切片，子进程仍会整体缓冲响应；现在同时设字节上限（6MB），超限即停止读取并报 `too_large`。
- **TLS 先校验、只在证书错误时降级**：原先对每个携带 userToken 的请求都无条件 `rejectUnauthorized: false`；
  现在先正常校验，仅在证书类错误时重试一次并标记 `insecureTls`（日志留痕），不再是静默的全量降级。
- **路由归属改为代际记账**：释放权判定不再依赖 `webServer.exact` 这一内部字段（未来改名也不会 fail-open 误删新实例路由）；
  驱逐旧实例路由时留日志；挂载中途失败时把已驱逐的旧路由**恢复**（此前会留下无人服务的路径且无任何报错）。
- 文档数字修正（单测数量、"21 events"、v0/v3/v4 版本区间），并补「已知限制」：检索步骤与消息状态不保留、重复导入会生成两个会话。

### 首轮：Session 格式 v0–v4

修复导入链路，并按运行中的 DSH 版本自适应写入 Session 格式 v0–v4。

#### 修复

- 会话头版本原先写死为 `0`，在 0.1.5-alpha.1+（v3）与 0.1.7-alpha.1+（v4）上导入直接失败（`encodeCurrent requires Session format v3`）；
  现在先从已存会话读取版本，再按后端拒绝时报出的版本自动重试。
- 持久化接口按代次自动选择：v0/v1 的服务级 `create(meta)` + `append(id, events)`，v2+ 的句柄式 `create(header)` + `append/flush/close`。
- 消息正文取自 `fragments`（`REQUEST`/`RESPONSE`/`THINK`）而不是空的 `content` 字段；思维链导入为 `reasoning` 块，时间取 `inserted_at`（缺失/乱序/离谱时按缺失处理，不会把 2023 年的对话标到导入时刻）。
- **事件顺序**：`turn/start → step/start → user/message`。v2→v3 迁移在第一个 `step/start` 处插入 system 头，
  因此「首个 step 之前有 surface 事件」的 v0/v2 日志会被 v3+ 构建拒绝 —— 在旧版本导入的会话升级后会打不开。
- **写入后读回校验**：后端写入不校验事件词表，读不回来时不再报成功（返回 `verify` 失败）。
- 超长对话不再被静默截断成「响应非 JSON（可能 Token 无效）」，而是返回明确的 `too_large`；请求体超限返回 413、非法 JSON 返回 400。
- 路由注册可重入并在 fiber 销毁时释放：只回收本插件上一实例的路由，旧实例销毁不会误删新实例的路由，挂载中途失败会释放已注册的路由；插件重载不再报 `webserver: duplicate exact route`。
- 非 `USER`/`ASSISTANT` 行不再被拼成助手回复；没有可翻译回合时返回 `empty_history`，不写入空会话；只有附件的消息写明确说明。
- 标题按 `dsh-session-title` 的语义归一（去转义/控制字符、折成一行、UTF-8 字节上限）。
- 安全性：请求 spec（含 `Authorization`）改走子进程 stdin（不再出现在 `ps`/`/proc`）；`probe` 只允许 `https://chat.deepseek.com` 且忽略调用方自带的 `Authorization`；上游原文截断并把 token 抹成 `[token]`；凭据服务报错只进日志。

#### 新增

- `test/`：59 个单测（翻译层 + 传输层 + 8 条路由及其错误路径）、真实后端兼容矩阵（v0/v2/v3/v4）、
  跨代读取测试（旧版本写、新版本读）与离线端到端导入测试。- `docs/COMPATIBILITY.md`：各代差异的证据、跨代迁移约束与验证命令。
- `.github/workflows/ci.yml`：push/PR 跑单测，手动触发跑完整矩阵。

## 0.1.0 (2026-08-17)

- Initial release as an installable DSH plugin bundle (`dsh.bundle` + `dsh.client`).
- Settings-page UI ("DeepSeek 对话导入"): paste `userToken`, list the chat.deepseek.com conversation directory (title + date, most recent 100), and import a chosen conversation into a chosen workspace as a durable, resumable DSH session.
- Imported sessions: DeepSeek title preserved, openable and resumable in DSH (does not enter the live store, so it can be resumed and continued).
- Empty-conversation guard and attach-failure reporting (`attached: false` instead of a false "import failed").
- Same-origin JSON routes served by the host half; the browser half calls them with `fetch`.
- Diagnostic route restricted to chat.deepseek.com URLs.
