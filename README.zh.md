# deepseek-web-import · DLC 补丁层

[English](README.md)

本仓库是 **[wpc0323/deepseek-web-import](https://github.com/wpc0323/deepseek-web-import) 的薄补丁层**：
跟随上游 `0.2.0`，只增加一项能力——**导入对话里用户上传的图片**。

对话目录、token 存储、会话格式兼容、设置页双语与诊断都来自上游，请直接看
[上游 README](https://github.com/wpc0323/deepseek-web-import/blob/main/README.zh.md)。
本页只说明补丁层。

## 本层新增

- 导入后的人话轮保留图片：下载 → 存为 DSH 附件 → 在提问文本之后内联显示。
- 同时保留**文档附件**（PDF / Word / 文本等），原名原字节。
- 结果行报告保留数量（`含图片 N 张`、`含附件 N 个`）；找到但一个都没存下时显示 `0/N`。
- 单个附件下载或解码失败只跳过它，文本导入照常完成。

## 实现

DeepSeek 把上传物挂在用户消息的 `FILE` fragment 上：

```json
{ "type": "FILE", "files": [{ "id": "file-…", "file_name": "image.png",
  "is_image": true, "width": 2559, "height": 1440,
  "status": "SUCCESS", "signed_path": "/file?file_id=…&state=…" }] }
```

字节不在 `history_messages` 里，而在带签名的 CDN 路径后面。写会话前多做三步：

1. `GET /api/v0/file/fetch_files?file_ids=…` 刷新描述（历史里的 `signed_path` 可能过期）；
2. 从 `https://files.deepseeksvc.com/api<path>` 下载，走与其他请求相同的
   `subprocess` 通道，按条目类型选版本：图片 `?ty=p`（`&fmt=jpeg` 转码，省略可能是 WebP）；
   文档 `?ty=r`（原件）；
3. 交给 DSH `attachments` 服务落盘，并在提问文本之后写入
   `{ "type": "image" | "file", "attachment": … }`。

**不设人为大小上限。** 网页端默认允许**单个 100 MB**（`0x6400000`）、最多 50 个，
且模型可通过 `file_feature.max_upload_file_size` 放宽；如果这里卡一个更小的值，
就会丢掉用户在浏览器里明明能上传的文件。这里唯一的边界是 1 GiB 的失控保护。
文档采用**流式**处理：子进程直接写入临时文件，宿主再交给
`attachments.saveFileStream`，不走 base64、不整文件进内存，所以 100 MB 的文件
消耗的是磁盘 I/O 而不是几倍堆内存。

| 文件 | 作用 |
|---|---|
| `lib/images.js` | 图片发现、下载、嗅探（新增文件） |
| `lib/files.js` | 文档发现、流式下载、保存（新增文件） |
| `lib/events.js` | `messageBlocks(message, role, images, files)`、`buildSessionEvents(…, imagesByMessage, filesByMessage)` |
| `lib/index.js` | 写会话前跑两趟流程，返回 `imageFiles`/`imageCount`、`fileFiles`/`fileCount` |
| `lib/client.js` | 结果行显示图片/附件数量（中英双语） |
| `test/images.test.mjs`、`test/files.test.mjs` | 共 18 项：解析、URL、事件拼装、下载/保存流水线、大小保护 |

## 安装与更新

插件市场只会更新它能重新解析的来源（`npm:`、`github:`、固定归档 URL）；用 `file:`
装的本地 tgz 市场看不见。所以让市场托管基线，再把补丁层贴上去：

```sh
# 基线：与市场同源的归档 URL
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/refs/heads/main.tar.gz

# 补丁层
node tools/apply-dlc.mjs
```

**市场每次更新基线后，重新执行一次 `node tools/apply-dlc.mjs`。** 更新会还原上游原始文件，
补丁层随之消失。脚本可重复执行、写入换新 inode（不会破坏 pnpm 的 store 硬链接），
锚点对不上会直接报错——那表示补丁层需要 rebase。

仓库公开后可以一步安装（同名同 Cordis row，会替换基线）：

```sh
dsh plugin add LingSuiYA/deepseek-web-import-f
```

## 跟随上游

```sh
git fetch upstream
git rebase upstream/main     # 重放补丁提交
npm test
```

rebase 后把版本后缀加一（`0.2.0-dlc.1` → `0.2.1-dlc.1`）。补丁提交保持小而独立，
rebase 才是「重放」而不是「合并」。

## 兼容性

- 基线：上游 `0.2.0`，写 DSH 会话格式 v4。
- `lib/images.js`、`lib/files.js` 是纯新增；被改的三个文件由 `apply-dlc` 做锚点校验。
- 文档字节被完整恢复，但模型上下文里仍只有 DeepSeek 当时存下的文本——解析后的文档正文
  本来就不在历史负载里。
- 带 `file` 块的历史在续聊时需要目标模型适配器接受该块，建议用一条文档对话验证一次。

## 许可证

MIT，继承自上游。
