# 从零安装（功能补充完全体）

目标：一台**没有装过** `deepseek-web-import`、也没有本补丁层的 DSH 客户端，装到「文本 + 图片 + 文档 + Markdown 清洗 + 批量刷新 + 标题」全功能可用。

先选一条路线，三条互斥：

| 路线 | 适用 | 能享受市场更新 | 需要 |
|---|---|---|---|
| **A. 整包安装（推荐，仓库公开后）** | 装完即用，一条命令 | ✅ 市场按仓库 HEAD 检测 | 仓库公开 |
| **B. 市场基线 + 补丁层（当前私有仓库）** | 想保留市场更新 | ✅ 基线更新；补丁需重贴 | clone 本仓库 + Node |
| **C. 本地 tgz（离线/一次性）** | 内网、无 Git、给别人试用 | ❌ 市场看不见 `file:` 来源 | 一个 tgz 文件 |

> 三条路最终都是 `deepseek-web-import` 一个包，**同名同 Cordis row，装一个会替换另一个**。

---

## A. 整包安装（仓库公开后）

```sh
dsh plugin add LingSuiYA/deepseek-web-import-f
```

- 如果宿主进程的 PATH 里没有 `git`，`dsh plugin add` 的 `github:` 解析会失败；改用路线 B 的归档 URL。
- 装完**重启 DSH**，设置 → DeepSeek 对话导入。
- 之后市场会对比「锁定 commit」与仓库 HEAD，推送即提示更新。

---

## B. 市场基线 + 补丁层（当前方式）

### 1. 装上游基线（与市场同源）

```sh
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/refs/heads/main.tar.gz
```

也可以在插件市场里直接装上游。**不要**用 `file:` 装本仓库的 tgz——那会让市场失去更新能力。

### 2. 取本仓库（补丁层与脚本都在里面）

```sh
git clone git@github.com:LingSuiYA/deepseek-web-import-f.git
cd deepseek-web-import-f
```

私有仓库需要先配好 SSH 密钥（或改用 HTTPS + Personal Access Token）。

### 3. 贴补丁

```sh
node tools/apply-dlc.mjs
```

默认目标是 `~/.dsh/profiles/desktop/node_modules/deepseek-web-import`；其他 profile 用参数或环境变量指定：

```sh
node tools/apply-dlc.mjs /path/to/node_modules/deepseek-web-import
DSH_PLUGIN_DIR=/path/to/pkg node tools/apply-dlc.mjs
```

脚本是**分阶段的**，可重复执行：

| stage | 内容 |
|---|---|
| 1 | 图片导入 |
| 2 | 文档附件（流式、无 20MB 限制） |
| 3 | Markdown 清洗（`[reference:N]`、`<br>`） |
| 4 | 导入后自动刷新（可关） |
| 5 | 批量导入 + 客户端预热 |
| 6 | 宿主端投影缓存 checkpoint（标题立即显示） |

### 4. 重启或 toggle 插件

宿主半部的改动需要重新加载：重启 DSH，或在插件管理里关一次再开。纯客户端改动（stage 4/5）刷新页面即可。

### 5. 之后每次市场更新

市场更新会还原上游原始文件，补丁层消失。重新执行一次：

```sh
node tools/apply-dlc.mjs
```

---

## C. 本地 tgz（离线/一次性）

在有 Node 的机器上：

```sh
cd deepseek-web-import-f
npm pack          # 产出 deepseek-web-import-0.2.0-dlc.N.tgz
```

把 tgz 拷到目标机：

```sh
dsh plugin add file:/absolute/path/deepseek-web-import-0.2.0-dlc.N.tgz
```

- 这条路线**没有市场更新**：市场只更新能重新解析的来源（`npm:` / `github:` / 固定归档 URL）。
- 升级时重复「打包 → 卸载旧的 → 装新的」。

---

## 装完的验收清单

1. **设置 → DeepSeek 对话导入** 页面出现
2. 粘贴 `userToken` → 保存，状态变为「已配置」
3. 「获取对话目录」能列出会话
4. 导入一条**带图片**的对话：结果行出现「含图片 N 张」，会话里图片正常显示
5. 导入一条**带文档**的对话：结果行出现「含附件 N 个」，附件可打开
6. 导入后**不点开**，侧边栏直接显示 DeepSeek 标题（而不是「未命名」）
7. 勾「批量导入」，连续导入 2 条，点「完成导入并刷新」，侧边栏一次出现两条

---

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `web boot: 1 entry did not activate` / `import failed` | 启动期客户端模块加载失败（偶发，重建 bundle 时容易撞上） | 重启；仍失败时用对话框「禁用第三方插件」先拉起，再回滚客户端（见下） |
| `dsh plugin add github:...` 报 `git ls-remote failed` | 宿主 PATH 没有 `git` | 改用归档 URL（路线 B 第 1 步） |
| 市场更新后图片/文档功能消失 | 补丁层被还原 | 重跑 `node tools/apply-dlc.mjs` |
| 导入结果 `images 0/N` | 图片下载失败 | 看 DSH 日志；确认 `userToken` 未过期 |
| 侧边栏「未命名」 | 投影缓存无该会话的行 | 导入结果里的 `titleCached` 字段可判断：`written` 正常，`error`/`no_cache` 表示宿主缺少对应服务 |
| 补丁脚本报 anchor 不匹配 | 上游改了被 patch 的文件 | 需要 rebase 本仓库，而不是强行重试 |

### 只回滚客户端（保留导入功能）

```bash
git -C deepseek-web-import-f show upstream/main:lib/client.js \
  > ~/.dsh/profiles/desktop/node_modules/deepseek-web-import/lib/client.js
```

### 完全回滚到上游

```bash
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/refs/heads/main.tar.gz
```

同名替换，补丁层随之消失。
