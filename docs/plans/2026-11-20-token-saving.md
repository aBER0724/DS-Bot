# 省 token：rtk

- 日期：2026-11-20
- 相关：无（用户提出：Bot 默认用 rtk 省 token）
- 代码：`ds-bot/rtk.js`、`ds-bot/src/host/rtk/`、`ds-bot/cordis.patch.yml`

## 为什么

Bot 干活的 token 很大一部分花在命令输出上：`git log`、测试报告、构建日志原样进上下文。[RTK](https://github.com/rtk-ai/rtk) 把一条命令的输出压成同一条命令的紧凑形式，官方说常见开发命令省 60–90%，退出码不变。

DSH 没有可以改写命令的钩子（`rtk init` 也没有 `--agent dsh`），所以 rtk 只能接在**组合层**：DS Bot 的 bundle patch。这样凡装了 ds-bot 的 profile（桌面应用、Docker 镜像、用户自己的 DSH）都默认生效，不需要改用户的 profile。

## 已定的行为

- `cordis.patch.yml` 挂一行 `ds-bot/rtk`。它在 `ctx.shell` 上包一层 `resolve`：只换命令文本，工作目录、超时、环境变量、退出码、后台作业和沙箱约束都还是执行器自己的。
- 只接一个简单命令：带管道、列表、重定向、命令替换、变量或换行的命令原样执行（这些在 rtk 下会被重新解释）。
- 只接 rtk 真有过滤器的工具（git、gh、cargo、npm/pnpm、pytest、ruff、docker、kubectl、ls、grep、rg、find 等，见 `src/host/rtk/wrap.js`）。命令名的拼写要一模一样：`GIT status` 不接，免得把一条命令改写成另一条。
- 二进制从哪来：先看 `$DSH_HOME/bot/tools/rtk/<版本>/rtk`，再看 PATH 上的 `rtk`；都没有就在后台装一次。装的是 **`rtk-oss-*`（只有 Apache-2.0 的那份）**，从 GitHub release 下载，按 `checksums.txt` 校验 sha256，用系统 `tar` 解包，拒绝绝对路径和 `..`。解包在 `/tmp`、目标在数据卷时先复制再改名（跨文件系统，`rename` 会报 EXDEV）。装不上就什么都不做，命令原样执行——没有网络、没有权限都不影响干活。
- 关掉：`DS_BOT_RTK=0`，或那一行 `config.enabled: false`。

## 不做

- 不改 DSH，也不依赖 DSH 安装目录里的文件。
- 不包装多命令、管道和重定向：那是改语义，不是省 token。
- 不用 BUSL 版的 rtk：默认那份带 BUSL-1.1 的 engine，DS Bot 用不到，也不该分发。
- **不内置 billion-context（上下文压缩代理）**。曾经试过随 ds-bot 发布：它要接管 DSH 的压缩（`compaction-basic` 与各 preset 的 compaction 行），和 DS Bot 的上下文管家冲突（管家只能换段、写不了检查点），把 `globalThis.fetch` 换成访问器导致 `experimental-inspector` 起不来，还要给桌面应用多带 47 MB 依赖。想要的人按 billion-context 自己的说明装成 profile 的 bundle 即可，DS Bot 不替用户做这个决定。
- 不给 rtk 做设置开关：它默认在，`DS_BOT_RTK=0` 就够了。

## 已知限制

- 包在 `ctx.shell.resolve` 上，是改运行中的服务对象（和 DS Bot 包压缩引擎的办法一样），不是 DSH 的正式扩展点。DSH 换执行器接口时要跟着改。
- Bot 跑在本地 Agent CLI（Claude Code、Codex 等）上时，命令由那个 CLI 自己执行，不经过 `ctx.shell`，rtk 那层不生效。
- 第一次启动要下载 rtk（约 5 MB）。离线环境下装不上，命令原样执行。
- Windows 上 Bot 用的是 pwsh，包的是同一个 `resolve`，所以一样生效；下载的是 `rtk-oss-x86_64-pc-windows-msvc.zip`。

## 变更

- 2026-11-20：初版，含 billion-context。
- 2026-11-21：去掉 billion-context，只保留 rtk（桌面应用打包缺依赖、CI 失败，加上与管家和 inspector 的冲突）。
