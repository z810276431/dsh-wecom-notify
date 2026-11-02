# DeepSeek Harness Notify

基于 DeepSeek Harness 会话日志的通知程序。在检测到新的 `turn/end` 事件后，通过企业微信或个人微信推送服务发送状态通知。

## 功能

- 支持完成、取消、中断、错误、阻塞和输出上限等结束原因。
- 支持企业微信群机器人 Webhook、企业微信智能机器人、PushPlus 和 Server酱 Turbo。
- 支持普通 JSONL 与由多个独立 Zstandard 帧组成的压缩日志。
- 使用持久化游标和通知水位减少历史事件重复推送。
- 可在 Harness 未运行时暂停扫描；智能机器人连接也随之释放。
- 提供单次扫描、连通性测试、单实例保护和无凭证源码打包。

## 运行环境

- Node.js **24 或更高版本**，使用内置 Zstandard API。
- pnpm；依赖版本由 [锁文件](<pnpm-lock.yaml>) 固定。
- 能访问所选推送服务；智能机器人通道使用 `ws` 库。

Windows 启动辅助脚本仅适用于 Windows。Node 主程序可在其他系统运行；使用进程探测时，需要配置对应的进程名，或指定本地服务端口。

## 快速开始

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm init:config
```

初始化从 [空白示例配置](<dsh-wechat-config.example.json>) 创建本地配置。若本地配置已存在，命令会保留原文件，不覆盖凭证。

```text
dsh-wechat-config.example.json  公开模板：所有凭证为空
dsh-wechat-config.json          本地配置：不提交版本控制
```

填写所选通道的凭证后运行：

```sh
pnpm test:notify
pnpm start
```

修改本地配置后需要重启程序；当前不支持热加载。

### 使用 npm 代替 pnpm

`npm build:release` 不是有效命令：`build:release` 是脚本名，不是 npm 子命令。使用 npm 时，所有脚本都要加 `run`：

```sh
npm install
npm run init:config
npm run test:notify
npm run start
npm run test
npm run build:release
```

`npm install` 会按 [锁文件](<pnpm-lock.yaml>) 之外的 `package.json` 解析依赖；需要严格复现锁定版本时，仍建议使用 pnpm。`npm run start` 与 `npm run test` 是 npm 内置脚本名，可省略 `run`，但统一加 `run` 更清晰。

## 推送通道

| `transport` | 发送方式 | 必需配置 |
|---|---|---|
| `webhook` | 企业微信群机器人，HTTP POST | `wecomWebhook` |
| `aibot` | 企业微信智能机器人，WebSocket | `aibot.botId`、`aibot.secret` |
| `pushplus` | PushPlus 微信渠道，HTTP POST | `pushplus.token` |
| `serverchan` | Server酱 Turbo，HTTP POST | `serverchan.sendKey` |

企业微信通道面向企业微信会话，不保证消息同步到个人微信。需要个人微信通知时，可选择 PushPlus 或 Server酱，并按服务商要求绑定接收渠道。

### 企业微信群机器人

```http
POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<WEBHOOK_KEY>
Content-Type: application/json

{"msgtype":"markdown","markdown":{"content":"通知正文"}}
```

HTTP 状态必须为 2xx，且响应为 JSON 对象并包含 `errcode: 0`，才视为接口调用成功。

### 企业微信智能机器人

连接地址：`wss://openws.work.weixin.qq.com`。

1. 使用 `aibot_subscribe` 提交 BotID 和 Secret。
2. 收到匹配请求的成功响应后进入就绪状态，不把 WebSocket 打开视为鉴权成功。
3. 每 30 秒发送 `ping` 保活。
4. 从 `aibot_msg_callback` 获取会话目标，使用 `aibot_send_msg` 发送 Markdown。
5. 连接断开后采用指数退避重连，最大间隔 30 秒；明确的鉴权拒绝需要修正配置后重启。

首次绑定时，在期望接收通知的会话里给机器人发消息；群聊通常需要 `@机器人`。绑定后，其他会话的消息不会覆盖已保存的目标。重新绑定应先停止程序，再移除保存的绑定文件并重新发送消息。

同一机器人应只运行一个客户端。智能机器人模式的测试也参与单实例锁，防止测试连接顶掉常驻连接。

### PushPlus

```http
POST https://www.pushplus.plus/send
Content-Type: application/json

{"token":"<TOKEN>","title":"通知标题","content":"通知正文","template":"markdown","channel":"wechat"}
```

`code: 200` 表示服务端已接受请求，**不代表最终送达**。默认模板为 `markdown`，默认渠道为 `wechat`。账号状态、实名认证、发送频率及每日额度以服务商当前规则为准。

### Server酱 Turbo

```http
POST https://sctapi.ftqq.com/<SENDKEY>.send
Content-Type: application/json

{"title":"通知标题","desp":"通知正文"}
```

使用 Turbo 接口对应的 SendKey。本程序识别 `code: 0`，也兼容 `errno: 0` 响应；其他 Server酱产品的接口不自动兼容。标题最多发送 32 个字符。

## 配置参数

完整配置结构见 [示例配置](<dsh-wechat-config.example.json>)。

| 参数 | 默认值 | 含义 |
|---|---|---|
| `transport` | `webhook` | 推送通道 |
| `wecomWebhook` | 空 | 群机器人完整地址；仅 Webhook 模式使用 |
| `pushplus.token` | 空 | PushPlus 令牌 |
| `pushplus.template` | `markdown` | PushPlus 消息模板 |
| `pushplus.channel` | `wechat` | PushPlus 接收渠道 |
| `serverchan.sendKey` | 空 | Server酱 Turbo SendKey |
| `aibot.botId`、`aibot.secret` | 空 | 智能机器人鉴权凭证 |
| `aibot.chatFile` | 空 | 为空时使用默认绑定文件 |
| `sessionsRoot` | 空 | 为空时自动选择用户的 Harness 会话归档根 |
| `pollMs` | `2000` | 扫描间隔，单位毫秒 |
| `notifyOn` | 常用六种结束原因 | 允许发送的结束原因列表 |
| `mention` | 空 | 可选的提及文本；效果取决于所选通道 |
| `maxTextChars` | `220` | 中断进度摘要的最大长度；`0` 不附带摘要 |
| `lockPort` | `39271` | 本地单实例锁端口 |
| `requireHarness` | `true` | 是否仅在 Harness 运行时扫描 |
| `harnessPort` | `0` | 大于零时探测指定本地端口 |
| `harnessProcess` | `DeepSeek Harness.exe` | 端口探测未确认时使用的进程名 |
| `harnessExecutable` | 空 | 可选包装启动器使用的程序位置；仅保存在本地配置 |

`pollMs` 必须为 `100–3600000` 的整数，`maxTextChars` 为 `0–10000` 的整数，锁端口为 `1–65535`，探测端口为 `0–65535`。配置不存在、JSON 损坏、类型不符或当前通道凭证为空时，程序会报错，而不是静默使用默认值。

### 文件覆盖变量

以下环境变量可覆盖默认运行文件的位置：

- `DSH_WECHAT_CONFIG`：本地配置。
- `DSH_WECHAT_STATE`：扫描状态。
- `DSH_WECHAT_LOG`：运行日志。

**覆盖路径不会自动添加 Git 忽略规则。** 将自定义配置和状态放在仓库之外，或先为其添加明确的忽略规则；默认规则只覆盖默认文件名和已列出的生成产物。

Windows 辅助脚本还支持：

- `DSH_NOTIFY_NODE`：指定 Node 可执行文件；未指定时优先使用可用的 Harness 运行时，然后使用 PATH 中的 Node。
- `DSH_HARNESS_EXE`：指定包装启动器启动的 Harness 程序，优先于本地配置的 `harnessExecutable`。

## 检测与状态模型

### 事件分类

| `reason.kind` | 状态 |
|---|---|
| `completed` | 正常完成 |
| `aborted` | 用户取消 |
| `interrupted` | 会话中断或恢复后补写 |
| `error` | 执行错误 |
| `blocked` | 阻塞 |
| `max-tokens` | 输出上限 |
| `forked` | 派生会话，默认不通知 |

扫描器读取归档根下的两级分组，识别 `session.v4.jsonl` 和 `session.v4.jsonl.zstd`。`sessionsRoot` 应指向完整归档根，而不是单个会话。

### 增量解析与去重

- 首次发现日志时建立基线，不补发该文件已有的历史事件。
- 后续使用字节偏移、事件序号和通知水位处理新记录。
- 普通 JSONL 的尾部半行、未完整写入的 Zstandard 帧会留待后续扫描。
- 压缩日志按独立帧解析，不假定一次解压能够处理全部拼接帧。
- 对整体重写的日志，通过前缀指纹和长度变化重新读取，并保留已处理水位。
- 运行状态采用临时文件加重命名保存。不要将其提交到仓库，或在迁移时随意清空。

本地生成的运行文件：

```text
dsh-wechat-state.json  扫描游标、通知水位及缓存元数据
dsh-wecom-chat.json    智能机器人绑定目标
dsh-wechat-notify.log  运行诊断日志
```

### Harness 生命周期门控

默认开启 `requireHarness`：

1. 优先使用明确配置的本地端口。
2. 未配置端口时，可从有效的本地 `DSH_WEB_URL` 提取端口；不会猜测固定 GUI 端口。
3. 未通过端口确认时，按进程名探测。
4. 初始等待和持续暂停期间不扫描会话日志。
5. 从运行转为停止时尝试最后扫描一次；随后释放机器人连接并等待下一次启动。

端口检测仅证明对应本地端口可连接，不校验服务身份。请指定 Harness 使用的端口，避免使用其他服务的端口。将 `requireHarness` 改为 `false` 可持续扫描。

## 命令与 Windows 辅助入口

```sh
pnpm start          # 常驻运行
pnpm test:notify    # 发送一条测试消息后退出
pnpm scan:once      # 扫描一轮后释放锁和连接
pnpm test          # 隔离测试，不使用真实凭证
pnpm build:release # 生成无凭证源码 ZIP
```

使用 npm 时改为 `npm run <脚本名>`，例如 `npm run build:release`。

`--test` 和 `--once` 是显式单次操作，不受生命周期门控限制。HTTP 通道的测试可与常驻实例并存；单次扫描和智能机器人测试需要先停止已有实例。参数或发送测试失败时返回非零退出码。

Windows 可直接使用 [通知启动入口](<run-wechat-notify.cmd>)。可选的 [Harness 包装启动器](<start-harness.cmd>) 先启动 Harness，再启动通知进程；它不会自动修改系统自启动。若要使用包装启动器，应在本地配置或环境变量中指定可执行程序。

将通知入口注册到当前用户的登录启动项时，使用隐藏窗口执行它即可。该方式属于**用户登录自启动**，不是登录前运行的系统服务。辅助脚本不会创建其他 Web 服务器，也不会替换已有 GUI。


## 限制与安全边界

- 只能观察已经落盘的 `turn/end`。强制关闭、崩溃或未完成持久化时，不能保证即时通知。
- 当前为单次尝试的尽力发送模型，**没有持久化发送队列或自动补偿重试**。接口失败后扫描游标仍会前进；日志用于诊断，不保证最终送达或跨网络故障的严格一次投递。
- 智能机器人连接未就绪时，会先等待订阅，避免将连接打开误认为可发送。
- 推送服务具有频率、长度、账号权限和每日额度限制；具体规则以官方说明为准。
- 通知可能包含任务标题及中断摘要。只应绑定可信的接收会话，必要时关闭或缩短摘要。
- Webhook 地址、Token、SendKey、Bot Secret 都属于敏感信息；Git 忽略规则不是加密措施。

## 协议参考

- [企业微信群机器人](<https://developer.work.weixin.qq.com/document/path/91770>)
- [企业微信智能机器人](<https://developer.work.weixin.qq.com/document/path/101463>)
- [PushPlus API](<https://www.pushplus.plus/doc/guide/api.html>) 与 [接口限制](<https://www.pushplus.plus/doc/help/limit.html>)
- [Server酱 Turbo](<https://sct.ftqq.com/>)
