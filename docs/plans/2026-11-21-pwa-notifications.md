# 浏览器和 PWA 的消息通知

- 日期：2026-11-21
- 相关：用户提出「能不能给 PWA 加上消息通知」；一起改：[手机 App](2026-10-24-mobile-app.md)（另一条推送路）
- 代码：`ds-bot/src/host/push.js`、`push-crypto.js`、`push-sw.js`、`ds-bot/src/client/push.js`、`notifications.js`、`mobile.js`、`channel.js`

## 为什么

Bot 回答完、或者有卡片在等用户，只有两条路通知到人：

- 桌面应用：走 Electron 壳的 `window.dsBotApp.notify`，系统通知。
- 手机 App：自己那套（扫码配对、端到端加密）。

浏览器里（包括把 DSH Web 装成 PWA）两条都用不上：页面没有壳的桥，`NotificationWatcher` 算出了「该通知」却无处可说。唯一例外是「有审批在等你」，它直接用了浏览器的 `new Notification`，但从不主动要权限。

## 已定的行为

### 两级

- **页面级**：没有 Electron 桥、也没有 Web Push 订阅时，`NotificationWatcher` 用浏览器的 `new Notification` 说一句。页面开着（后台标签页、桌面 PWA 窗口）就能收到；关掉页面就没了。
- **Web Push**：订阅了推送的设备由宿主直接唤醒，页面关着也能收，iOS 16.4+ 装到主屏幕也能收。

两者不会重复：订阅了推送的设备，页面不再自己弹通知——推送那条会到，页面再弹一次就是两条。

### 事件

和桌面应用同一套规则，外加群里 @ 用户：

| 通知 | 什么时候 |
|---|---|
| reply | 私聊里 Bot 发了一条消息（`message`） |
| question | 卡片在等用户（`question`）、有审批在等（`approval`） |
| mention | 群里的消息 @ 了用户（`@user` / `@you`，代码块和地址不算） |

群里的普通回复、`done`、`view` 都不推。

### 什么时候不推

- 设备的通知开关关着（`enabled: false`）。
- 这个会话被静音（设备上报的静音列表）。
- 这台设备正在看那个会话：`push-presence` 报告「可见 + 有焦点 + 就是这个会话」，且不超过 90 秒。
- 浏览器里没有权限：开关打开时会请求权限，被拒绝就只留未读标记（和桌面应用一样，设置里有一行红字说明）。

### 存放与密钥

- `<团队数据>/push.json`（0600）：一对 VAPID 密钥（P-256）+ 每台设备的订阅。
- 每台设备记 endpoint、`p256dh`、`auth`、开关、静音列表、最后一次 presence、创建时间；最多 32 台，新的在前。
- VAPID 密钥第一次用到时生成。**换了这对密钥，所有订阅都失效**，所以它和订阅放在同一个文件里、一起写。
- 推送服务回 404/410 = 订阅作废，记录删掉。

### 消息体

通知只带会话名和事件类型（`{ title, kind, sessionId, roomId }`），**不带消息正文**——它会出现在锁屏上。文案在 Service Worker 里按 `navigator.language` 选中文或英文。

### 加密与身份

- RFC 8291 `aes128gcm`，单记录；实现按 RFC 8291 附录 A 的测试向量校验（`test/push.test.js` 逐字节比对）。
- VAPID（RFC 8292）用 ES256 签，签名走 `ieee-p1363`（r‖s），`sub` 是 `mailto:`，`exp` 12 小时。
- 只用 Node 的 `crypto`，没有新增依赖。

### 页面与宿主之间

| 端点 | 作用 |
|---|---|
| `push-state` | 取 VAPID 公钥（客户端订阅时要用） |
| `push-subscribe` | 交订阅和这台设备的开关 |
| `push-unsubscribe` | 删订阅 |
| `push-prefs` | 开关和静音列表变了 |
| `push-presence` | 这个窗口现在在看哪个会话、可见不可见、有没有焦点 |

Service Worker 由宿主在 `/sw.js` 提供（`ctx.connection.fetch.register`），客户端用 `navigator.serviceWorker.register('sw.js', { scope: './' })` 注册。

## 不做什么

- 不做账号、配对、端到端加密：那是手机 App 那条路。
- 不推消息正文，也不推工具输出。
- 不做「点通知直接跳到那条消息」：点开只把页面带到前台，会话还在原来的位置（后续可以加 `?dsBotSession=` 深链）。
- 不替用户要权限：只有打开设置里的通知开关才会请求。

## 已知限制

- 需要 HTTPS（`isSecureContext`）：纯 http 的局域网地址只能用页面级通知。
- iOS 必须「添加到主屏幕」后才有 Web Push，且系统版本 16.4+。
- 部署在子路径（`https://host/team/`）时，`/sw.js` 按根路径注册会失败，此时只剩页面级通知。
- presence 只在页面活着时上报；页面一关，宿主最多 90 秒后按「没在看」处理，正常。
- `push.json` 里的 endpoint 就是这台设备的推送地址，拿到它的人可以给这台设备推消息；它和 VAPID 私钥一样按团队数据对待。

## 变更

- 2026-11-21：初版。
