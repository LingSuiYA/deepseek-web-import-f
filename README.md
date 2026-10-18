<div align="center">

# deepseek-web-import · 功能补充版

**把 DeepSeek 网页端的历史对话，连同图片和附件一起带进 DSH**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Based on](https://img.shields.io/badge/based%20on-wpc0323%2Fdeepseek--web--import%200.2.0-blue)
![Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB)

[English](README.en.md) · [上游仓库](https://github.com/wpc0323/deepseek-web-import) · [从零安装](docs/INSTALL-FROM-ZERO.md) · [问题反馈](https://github.com/LingSuiYA/deepseek-web-import-f/issues)

</div>

---

## 写在前面

本项目是 [wpc0323/deepseek-web-import](https://github.com/wpc0323/deepseek-web-import) 的**功能补充与修改**，不是原创项目。对话目录、Token 存储、会话格式兼容、设置页与诊断能力都来自上游，版权归原作者所有。

我们只补齐「导入时会丢失的东西」：图片、文档附件，以及随之而来的正文清洗、结果反馈和刷新体验。

- 与上游**同名、同 Cordis row**，安装本包会替换上游包，二选一。
- 重装上游、更换基线或从市场重装后，被修改过的文件会被还原，需要重新贴一次补丁（见「安装与更新」）。
- 只想用纯文本导入的话，直接用上游即可。
- 本项目与 DeepSeek 官方无关，也不代表上游作者；它通过非官方内部接口读取**用户自己的**对话数据，使用风险由使用者承担。

## 为什么需要这个补充

从网页端导入对话时，原始版本只保留文字：对话里的图片和 PDF 会消失；搜索回答末尾的 `[reference:N]` 会以字面量留在正文里；导入完成还要手动刷新才能看到新会话，侧边栏标题也要点开一次才显示。

这些都不影响「能不能导入」，但决定了「导进来能不能用」。

## 快速开始

1. **装插件**：按[安装与更新](#安装与更新)选一条路线，装完重启 DSH。
2. **打开设置 → DeepSeek 对话导入**。
3. **粘贴 userToken**：浏览器登录 chat.deepseek.com → `F12` → `Application` → `Local Storage` → 复制 `userToken` 的值 → 粘贴并保存（插件会自动取出 `value` 字段）。
4. **获取对话目录 → 选目标工作区 → 导入为会话**。结果行会显示消息数、`含图片 N 张` / `含附件 N 个`；默认自动刷新，侧边栏直接出现新会话。

完整的验收清单和故障排查见[从零安装](docs/INSTALL-FROM-ZERO.md)。

## 前置条件

- **DSH 0.2.x**（实测 `0.2.1-rc.2`），会话格式 v4。
- **Node.js ≥ 18**：路线 B/C 需要它跑补丁脚本和打包。
- **git**：路线 A/B 需要；宿主进程的 PATH 里没有 `git` 时，路线 A 会失败。
- **能访问 GitHub**：路线 A/B 依赖。
- **一个 DeepSeek 网页账号**：用来获取 `userToken`。
- 插件市场（dshmarket）可选，只影响更新提示。

## 核心特性

### 1. 图片与附件

- **图片**：从用户消息的 `FILE` fragment 取文件 ID，经 `fetch_files` 刷新签名路径，用 `ty=p` 下载预览图；按魔数识别真实格式后交给 DSH 附件服务，会话里直接显示。预览接口单张上限 12 MB，正常截图远小于此。
- **文档**：PDF / Word / 文本等按 `ty=r` 取原件，**流式落盘**（先写临时文件，再交给 `saveFileStream`），不额外设限。网页端默认单文件 100 MB、最多 50 个是它的上传限制；导入侧只保留 1 GiB 的失控保护。
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
- 启动失败、标题未命名等排查细节见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。
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

目标客户端既没有上游插件、也没有本补充？按[从零安装](docs/INSTALL-FROM-ZERO.md)选一条路线即可。三条路线的区别主要是：装完之后，市场能不能替你继续更新。

### A. 从 Git 仓库安装（一步到位）

直接以本仓库为安装源，市场可以跟踪仓库更新。

```sh
dsh plugin add LingSuiYA/deepseek-web-import-f
```

等价写法：`dsh plugin add github:LingSuiYA/deepseek-web-import-f`。

需要能访问本仓库；宿主 PATH 里没有 `git` 时这条命令会报 `git ls-remote failed`，改用 B。

### B. 固定上游基线 + 本地补丁层

先安装上游基线，本补充作为补丁贴在其上（这条路线不安装本仓库的包，而是直接修改已安装的上游文件）。基线钉在上游 `0.2.0` 的提交 `7727f18`，保证补丁锚点稳定。

```sh
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/7727f18e3996713dec1b7046d07897c19efed5ae.tar.gz
git clone https://github.com/LingSuiYA/deepseek-web-import-f.git
cd deepseek-web-import-f
node tools/apply-dlc.mjs
```

默认目标是 `~/.dsh/profiles/desktop/node_modules/deepseek-web-import`；profile 名不同时用 `node tools/apply-dlc.mjs <包目录>` 指定，或设置环境变量：

```sh
# POSIX
DSH_PLUGIN_DIR=/path/to/pkg node tools/apply-dlc.mjs
# PowerShell
$env:DSH_PLUGIN_DIR = "C:\path\to\pkg"; node tools/apply-dlc.mjs
```

### C. 离线：本地 tgz

适合内网或给别人试用，代价是放弃市场更新。

```sh
cd deepseek-web-import-f
npm pack
dsh plugin add file:/absolute/path/deepseek-web-import-0.2.0-dlc.13.tgz
# Windows 写成 file:C:/path/to/deepseek-web-import-0.2.0-dlc.13.tgz
```

包内包含 `lib/`、`docs/`、`tools/`、`cordis.patch.yml` 和两个 README。Windows 的 cmd/PowerShell 不展开 `*`，请写实际文件名。

基线是固定提交的归档，市场不会自动升级它。需要跟进上游时，把上面的 URL 换成新的上游提交归档，再重跑 `node tools/apply-dlc.mjs`；如果脚本报锚点不匹配，说明上游改了被 patch 的文件，先 rebase 本仓库，重试没有用。

> 宿主半部的改动需要重启 DSH，或在「设置 → 插件」里把对应条目关闭再启用；纯客户端改动（刷新、批量）刷新页面即可。

## 卸载与回滚

- **回到上游**：重新执行 `dsh plugin add <上游归档 URL>`（URL 见[从零安装](docs/INSTALL-FROM-ZERO.md)），同名替换，补丁层随之消失。
- **只回滚客户端**（保留图片、附件与正文清洗）。`git clone` 只带来 `origin`，先补上 `upstream`：

  ```bash
  cd deepseek-web-import-f
  git remote add upstream https://github.com/wpc0323/deepseek-web-import.git
  git fetch upstream
  git show upstream/main:lib/client.js \
    > ~/.dsh/profiles/desktop/node_modules/deepseek-web-import/lib/client.js
  ```

  在 Windows 上请用 **Git Bash** 执行：cmd 不展开 `~`，而 PowerShell 5.1 的 `>` 默认写 UTF-16，会把 `client.js` 写坏、插件直接加载失败。profile 目录通常是 `%USERPROFILE%\.dsh\profiles\desktop`，profile 名不是 `desktop` 时替换。

  更省事的替代：直接重装上游（上一条「回到上游」），客户端也会一并还原。
- **从市场移除**：设置 → 插件 → 找到 `deepseek-web-import` 移除。

## 兼容性与限制

- **DSH 0.2.x**（实测 `0.2.1-rc.2`），写入会话格式 v4；补丁基线为上游 `0.2.0`（提交 `7727f18`）。
- 文档字节被完整保留，但模型上下文里仍只有 DeepSeek 当时存下的文本——解析后的文档正文本来就不在历史负载里。
- 带 `file` 块的历史在续聊时需要模型适配器接受该块，建议用一条文档对话验证一次。
- 依赖 DeepSeek 非官方接口，`userToken` 过期后需要重新保存。

## 致谢

- 上游作者 [wpc0323](https://github.com/wpc0323) 提供了完整的导入实现与格式兼容层。
- 设置页与错误处理沿用了上游的约定，本补充只在其上做增量。

## License

[MIT](LICENSE)，继承自上游。
