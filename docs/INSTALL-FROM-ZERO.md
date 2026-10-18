# 从零安装（功能补充完全体）

目标：一台**没有装过** `deepseek-web-import`、也没有本补丁层的 DSH 客户端，装到「文本 + 图片 + 文档 + Markdown 清洗 + 批量刷新 + 标题」全功能可用。

先选一条路线，三条互斥：

| 路线 | 适用 | 能享受市场更新 | 需要 |
|---|---|---|---|
| **A. 从 Git 仓库安装（推荐）** | 装完即用，一条命令 | ✅ 市场按仓库 HEAD 检测 | 能访问仓库 |
| **B. 固定上游基线 + 补丁层** | 想自己控制上游版本 | —（固定提交，升级需换 URL） | clone 本仓库 + Node |
| **C. 本地 tgz（离线/一次性）** | 内网、无 Git、给别人试用 | ❌ 市场看不见 `file:` 来源 | 一个 tgz 文件 |

> 三条路最终都是 `deepseek-web-import` 一个包，**同名同 Cordis row，装一个会替换另一个**。

## 前置条件

- DSH 0.2.x（实测 `0.2.1-rc.2`），会话格式 v4
- Node.js ≥ 18：路线 B/C 跑补丁脚本与打包
- git：路线 A/B 需要；宿主 PATH 无 `git` 时路线 A 会失败
- 能访问 GitHub：路线 A/B 依赖
- 一个 DeepSeek 网页账号：获取 `userToken`

---

## A. 从 Git 仓库安装

```sh
dsh plugin add LingSuiYA/deepseek-web-import-f
```

等价写法：`dsh plugin add github:LingSuiYA/deepseek-web-import-f`。

- 需要能访问本仓库；无权限时会直接报鉴权失败。
- 如果宿主进程的 PATH 里没有 `git`，`dsh plugin add` 的 `github:` 解析会失败；改用路线 B 的归档 URL。
- 装完**重启 DSH**，设置 → DeepSeek 对话导入。
- 之后市场会对比「锁定 commit」与仓库 HEAD，推送即提示更新。

---

## B. 固定上游基线 + 补丁层

### 1. 装上游基线（钉在 0.2.0）

```sh
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/7727f18e3996713dec1b7046d07897c19efed5ae.tar.gz
```

固定提交而不是 `main`，这样补丁锚点不会因为上游推送而漂移。这条基线**不会自动升级**：跟进上游时换新的提交归档并重跑补丁。也**不要**用 `file:` 装本仓库的 tgz——那会放弃市场管理。

### 2. 取本仓库（补丁层与脚本都在里面）

```sh
git clone https://github.com/LingSuiYA/deepseek-web-import-f.git
cd deepseek-web-import-f
```

如果仓库不可匿名访问，需要 Personal Access Token（或配好 SSH 密钥后改用 `git@github.com:` 地址）。

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
| 2 | 文档附件（流式下载） |
| 3 | Markdown 清洗（`[reference:N]`、`<br>`） |
| 4 | 导入后自动刷新（可关） |
| 5 | 批量导入 + 客户端预热 |
| 6 | 宿主端投影缓存预热（用于标题显示） |

### 4. 重启或重新加载插件

宿主半部的改动需要重新加载：重启 DSH，或在「设置 → 插件」里把 `deepseek-web-import` 关闭再启用。纯客户端改动（stage 4/5）刷新页面即可。

### 5. 之后升级上游

基线是固定提交的归档，市场不会自动升级。要跟进上游时，把第 1 步的 URL 换成新的上游提交归档，然后重新执行一次：

```sh
node tools/apply-dlc.mjs
```

如果脚本报「anchor 不匹配」，说明上游改了被 patch 的文件，需要先 rebase 本仓库，而不是继续重试。

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
# Windows: dsh plugin add file:C:/path/to/deepseek-web-import-0.2.0-dlc.N.tgz
```

- 这条路线**没有市场更新**：市场只更新能重新解析的来源（`npm:` / `github:` / 固定归档 URL）。
- 包内包含 `lib/`、`docs/`、`tools/`、`cordis.patch.yml` 和两个 README；Windows 的 cmd/PowerShell 不展开 `*`，请写实际文件名。
- 升级时重复「打包 → 卸载旧的 → 装新的」。

---

## 装完的验收清单

1. **设置 → DeepSeek 对话导入** 页面出现
2. 粘贴 `userToken` → 保存，状态变为「已配置」
3. 「获取对话目录」能列出会话
4. 导入一条**带图片**的对话：结果行出现「含图片 N 张」，会话里图片正常显示
5. 导入一条**带文档**的对话：结果行出现「含附件 N 个」，附件可打开
6. 导入后**不点开**，侧边栏尽量直接显示 DeepSeek 标题；若仍是「未命名」，按故障表检查 `titleCached`
7. 勾「批量导入」，连续导入 2 条，点「完成导入并刷新」，侧边栏一次出现两条

---

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `web boot: 1 entry did not activate` / `import failed` | 启动期客户端模块加载失败（偶发，重建 bundle 时容易撞上） | 重启；仍失败时用对话框「禁用第三方插件」先拉起，再回滚客户端（见下） |
| 路线 A 报 `git ls-remote failed` | 宿主 PATH 没有 `git` | 改用路线 B 的归档 URL |
| 换基线或重装后图片/文档功能消失 | 补丁层被还原 | 重跑 `node tools/apply-dlc.mjs` |
| 导入结果 `images 0/N` | 图片下载失败 | 看 DSH 日志；确认 `userToken` 未过期 |
| 侧边栏「未命名」 | 投影缓存无该会话的行 | 导入结果里的 `titleCached` 字段可判断：`written` 正常，`error`/`no_cache` 表示宿主缺少对应服务 |
| 补丁脚本报 anchor 不匹配 | 上游改了被 patch 的文件 | 需要 rebase 本仓库，而不是强行重试 |

### 只回滚客户端（保留导入功能）

`git clone` 只带来 `origin`，先补上 `upstream`：

```bash
cd deepseek-web-import-f
git remote add upstream https://github.com/wpc0323/deepseek-web-import.git
git fetch upstream
git show upstream/main:lib/client.js \
  > ~/.dsh/profiles/desktop/node_modules/deepseek-web-import/lib/client.js
```

在 Windows 上请用 **Git Bash**：cmd 不展开 `~`，PowerShell 5.1 的 `>` 默认写 UTF-16，会把 `client.js` 写坏、插件加载失败。profile 目录通常是 `%USERPROFILE%\.dsh\profiles\desktop`，profile 名不是 `desktop` 时请替换。

### 完全回滚到上游

```bash
dsh plugin add https://github.com/wpc0323/deepseek-web-import/archive/7727f18e3996713dec1b7046d07897c19efed5ae.tar.gz
```

同名替换，补丁层随之消失。
