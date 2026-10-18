<div align="center">

# deepseek-web-import · 功能补充版

**把 DeepSeek 网页端的历史对话，连同图片和附件一起带进 DSH**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Based on](https://img.shields.io/badge/based%20on-wpc0323%2Fdeepseek--web--import%200.2.0-blue)
![Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB)

[上游仓库](https://github.com/wpc0323/deepseek-web-import) · [从零安装](docs/INSTALL-FROM-ZERO.md) · [问题反馈](https://github.com/LingSuiYA/deepseek-web-import-f/issues)

</div>

---

## 写在前面

本项目是 [wpc0323/deepseek-web-import](https://github.com/wpc0323/deepseek-web-import) 的**功能补充与修改**，不是原创项目。对话目录、Token 存储、会话格式兼容、设置页与诊断能力都来自上游，版权归原作者所有。

我们只补齐「导入时会丢失的东西」：图片、文档附件，以及随之而来的正文清洗、结果反馈和刷新体验。

- 与上游**同名、同 Cordis row**，安装本包会替换上游包，二选一。
- 上游发布新版本后，被修改过的文件会被还原，需要重新贴一次补丁（见「安装与更新」）。
- 只想用纯文本导入的话，直接用上游即可。
- 本项目与 DeepSeek 官方无关，也不代表上游作者；它通过非官方内部接口读取**用户自己的**对话数据，使用风险由使用者承担。

## 为什么需要这个补充

从网页端导入对话时，原始版本只保留文字：对话里的图片和 PDF 会消失；搜索回答末尾的 `[reference:N]` 会以字面量留在正文里；导入完成还要手动刷新才能看到新会话，侧边栏标题也要点开一次才显示。

这些都不影响「能不能导入」，但决定了「导进来能不能用」。

## 核心特性

### 1. 图片与附件

- **图片**：从用户消息的 `FILE` fragment 取文件 ID，经 `fetch_files` 刷新签名路径，用 `ty=p` 下载预览图；按魔数识别真实格式后交给 DSH 附件服务，会话里直接显示。预览接口单张上限 12 MB，正常截图远小于此。
- **文档**：PDF / Word / 文本等按 `ty=r` 取原件，**流式落盘**（先写临时文件，再交给 `saveFileStream`），不再受 20 MB 之类的人为限制；上限跟随网页端（默认单文件 100 MB、最多 50 个），只保留 1 GiB 的失控保护。
- **失败隔离**：单张图片或单个文档失败只跳过它，文本与会话照常写入。
- **正文清洗**：去掉 `[reference:N]` 引用标记和孤立的 `<br>`，围栏代码块内的内容保持原样。

### 2. 结果报告

导入完成后直接给出：会话 ID、消息数、事件数、会话格式版本，以及 `含图片 N 张` / `含附件 N 个`。

找到但一个都没存下时显示 `0/N`，能立刻区分「本来就没有」和「有但失败了」。

### 3. 自动刷新

导入成功后 1.2 秒自动刷新页面，新会话直接出现在侧边栏，不需要手动刷新。

连续导入多条时，勾选「批量导入」改为累计计数，最后点一次「完成导入并刷新（N 条）」，中途不打断。两个偏好都记在 `localStorage`。

### 4. 报错处理

- 错误码沿用上游约定（`no_token`、`api`、`too_large`、`persist` 等），新增失败只影响对应附件。
- 图片或文档任一环节出错，都会继续写会话，不会整体失败。
- 导入结果附带 `titleCached` 字段（`written` / `ok` / `error` / `no_cache`），用于判断标题缓存是否写入。
- 启动期若出现 `deepseek-web-import: import failed`，可先用启动对话框的「禁用第三方插件」拉起 DSH，再只回滚客户端文件（命令见[从零安装](docs/INSTALL-FROM-ZERO.md)）。

## 实现

上游把 `history_messages` 的 `fragments` 翻译成 DSH 会话事件；本补充在写会话之前，多做两步附件处理和一步正文清洗：

```text
DeepSeek 历史
   │  fragments: REQUEST / RESPONSE / THINK / FILE
   ├─ 图片  ── fetch_files ── ty=p ── 魔数校验 ── attachments.saveImages
   ├─ 文档  ── fetch_files ── ty=r ── 流式临时文件 ── attachments.saveFileStream
   └─ 正文  ── 去 [reference:N] / <br> ── 写入 text 块
                                   │
                             buildSessionEvents
```

| 文件 | 作用 |
|---|---|
| `lib/images.js` | 图片发现、下载、格式嗅探（新增） |
| `lib/files.js` | 文档发现、流式下载、保存（新增） |
| `lib/text.js` | 正文 Markdown 清洗，代码块保持原样（新增） |
| `lib/events.js` | `messageBlocks(message, role, images, files)`、`buildSessionEvents(…, imagesByMessage, filesByMessage)` |
| `lib/index.js` | 写会话前执行附件流程，返回计数与 `titleCached` |
| `lib/client.js` | 结果展示、自动刷新、批量模式 |
| `test/*.test.mjs` | 离线用例：解析、URL、事件拼装、下载/保存流水线、清洗 |

## 安装与更新

目标客户端既没有上游插件、也没有本补充？按[从零安装](docs/INSTALL-FROM-ZERO.md)选一条路线即可。三条路线的区别只有一点：**能不能享受插件市场的自动更新**。

### A. 仓库公开后：一步安装

市场可以跟踪本仓库的更新，装完即可持续升级。

```sh
dsh plugin add LingSuiYA/deepseek-web-import-f
```

### B. 当前方式：市场托管基线 + 本地补丁层

市场继续管理上游版本，本补充作为补丁贴在其上；上游每次更新后需要重贴一次。

```sh
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/refs/heads/main.tar.gz
git clone git@github.com:LingSuiYA/deepseek-web-import-f.git
node deepseek-web-import-f/tools/apply-dlc.mjs
```

### C. 离线：本地 tgz

适合内网或给别人试用，代价是放弃市场更新。

```sh
npm pack && dsh plugin add file:/absolute/path/deepseek-web-import-*.tgz
```

市场更新会还原上游文件，补丁层随之消失；重新执行一次 `node tools/apply-dlc.mjs` 即可恢复，脚本会按阶段跳过已应用的部分，锚点对不上时会直接报错而不是留下半成品。

> 宿主半部的改动需要重启 DSH 或 toggle 一次插件；纯客户端改动（刷新、批量）刷新页面即可。

## 兼容性与限制

- 基线：上游 `0.2.0`，写入 DSH 会话格式 v4。
- 文档字节被完整保留，但模型上下文里仍只有 DeepSeek 当时存下的文本——解析后的文档正文本来就不在历史负载里。
- 带 `file` 块的历史在续聊时需要模型适配器接受该块，建议用一条文档对话验证一次。
- 依赖 DeepSeek 非官方接口，`userToken` 过期后需要重新保存。

## 致谢

- 上游作者 [wpc0323](https://github.com/wpc0323) 提供了完整的导入实现与格式兼容层。
- 设置页与错误处理沿用了上游的约定，本补充只在其上做增量。

## License

[MIT](LICENSE)，继承自上游。
