# 省 token：RTK 和 billion-context

- 日期：2026-11-20
- 相关：无（用户提出：Bot 默认用 RTK 和 billion-context 省 token）
- 代码：`ds-bot/rtk.js`、`ds-bot/bili.js`、`ds-bot/bili-gate.js`、`ds-bot/src/host/rtk/`、`ds-bot/cordis.patch.yml`、`ds-bot/src/host/parts.js`

## 为什么

Bot 干活的 token 花在两处：命令输出（`git log`、测试报告、构建日志）原样进上下文，和长会话本身越滚越大。两处都有现成的工具：

- [RTK](https://github.com/rtk-ai/rtk) 把一条命令的输出压成同一条命令的紧凑形式，官方说常见开发命令省 60–90%，命令的退出码不变。
- [billion-context](https://github.com/ranxianglei/billion-context)（`bili`，MIT）在模型流量上做增量压缩，一个会话可以跑很久而窗口不涨。

DSH 本身没有可以改写命令的钩子（`rtk init` 也没有 `--agent dsh`），也不能在插件里改模型请求（DSH 的请求是深冻结的）。所以两者都只能接在**组合层**：DS Bot 的 bundle patch（`cordis.patch.yml`）。这样凡装了 ds-bot 的 profile（桌面应用、Docker 镜像、用户自己的 DSH）都默认生效，不需要改用户的 profile。

## 已定的行为

### RTK

- `cordis.patch.yml` 挂一行 `ds-bot/rtk`。它在 `ctx.shell` 上包一层 `resolve`：只换命令文本，工作目录、超时、环境变量、退出码、后台作业和沙箱约束都还是执行器自己的。
- 只接一个简单命令：带管道、列表、重定向、命令替换、变量或换行的命令原样执行（这些在 rtk 下会被重新解释）。
- 只接 rtk 真有过滤器的工具（git、gh、cargo、npm/pnpm、pytest、ruff、docker、kubectl、ls、grep、rg、find 等，见 `src/host/rtk/wrap.js`）。命令名的拼写要一模一样：`GIT status` 不接，免得把一条命令改写成另一条。
- 二进制从哪来：先看 `$DSH_HOME/bot/tools/rtk/<版本>/rtk`，再看 PATH 上的 `rtk`；都没有就在后台装一次。装的是 **`rtk-oss-*`（只有 Apache-2.0 的那份）**，从 GitHub release 下载，按 `checksums.txt` 校验 sha256，用系统 `tar` 解包，拒绝绝对路径和 `..`。装不上就什么都不做，命令原样执行——没有网络、没有权限都不影响干活。
- 关掉：`DS_BOT_RTK=0`，或那一行 `config.enabled: false`。

### billion-context

- `cordis.patch.yml` 挂 `ds-bot/bili` 和 `ds-bot/bili-gate` 两行，指向 ds-bot 自己的再导出（`bili.js`、`bili-gate.js`）：profile 只按名字加载插件，而 ds-bot 是每个 profile 都已经有的那个包。bili 本身不改。
- bili 接管压缩，所以 DSH 自己的压缩整体停下：`compaction-basic` 的 `auto` 关掉，四个 preset 的 compaction 行由 bili 的 gate 在加载时禁用。它的 gate 行**一直挂着**：preset 要等它提供的服务才能起来，关掉压缩插件也得留着它。
- DS Bot 的上下文管家照旧判断「压缩还是换段」，但压缩引擎已经不在：按已有逻辑退成**只换段**（`parts.js` 的 `engineOf` 在没有压缩引擎时就是 `undefined`）。检查点不再写：DSH 的检查点会盖住 bili 用来压缩的原始历史。
- 交接笔记和管家的判断请求原本声明成 `purpose: 'compaction'`，bili 会按这个声明拒绝（它把任何 dsh 压缩调用当成会破坏压缩基底的检查点）。这两个请求都不写进会话，所以 bili 在的时候声明成 `ds-bot-note`。
- 关掉：`DS_BOT_BILLION_CONTEXT=0`。gate 行还在，但它拿不到 bili 的宣告，就把每一行留成原样，DSH 自己的压缩回来，DS Bot 的检查点也回来。mock 测试台（`dev/bench.sh`）默认这样跑：脚本化的 mock 模型要看到原样的提示词。

## 不做什么

- 不改 DSH，也不依赖 DSH 安装目录里的文件。
- 不自动把 bili 装进用户的 profile：它是 ds-bot 的依赖，跟着 ds-bot 走。
- 不包装多命令、管道和重定向：那是改语义，不是省 token。
- 不用 BUSL 版的 rtk：默认那份带 BUSL-1.1 的 engine，DS Bot 用不到，也不该分发。
- 不给 rtk 做设置开关：它默认在，`DS_BOT_RTK=0` 就够了。

## 已知限制

- 包在 `ctx.shell.resolve` 上，是改运行中的服务对象（和 DS Bot 包压缩引擎的办法一样），不是 DSH 的正式扩展点。DSH 换执行器接口时要跟着改。
- Bot 跑在本地 Agent CLI（Claude Code、Codex 等）上时，命令由那个 CLI 自己执行，不经过 `ctx.shell`，rtk 那层不生效；bili 走的是模型流量，照样生效。
- bili 接管压缩后，DS Bot 不能再原地压缩：会话满了只能换段，交接笔记的质量比压缩过的检查点略差。
- bili 会重写发给模型的提示词（它压缩消息），所以脚本化的 mock 测试台看不到原样输入；测试台用 `DS_BOT_BILLION_CONTEXT=0` 跑。
- bili 的浏览器半边（设置页里的入口）不加载：profile 认的是 ds-bot 这个包的 client。
- 第一次启动要下载 rtk（约 5 MB）。离线环境下装不上，命令原样执行。
- Windows 上 Bot 用的是 pwsh，包的是同一个 `resolve`，所以一样生效；下载的是 `rtk-oss-x86_64-pc-windows-msvc.zip`。

## 变更

- 2026-11-20：初版。
