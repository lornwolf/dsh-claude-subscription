# dsh-claude-subscription

在 DeepSeek Harness 里直接使用 **Claude Pro / Max 订阅**。

## 它做什么

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 订阅 OAuth 登录 | ✅ | Claude Code 同一条授权通道（PKCE，`claude.ai/oauth/authorize`），不读 `~/.claude` |
| 模型直接可选 | ✅ | 注册 `anthropic` 路由，模型目录来自 pi-ai 的 anthropic 目录（17 个 chat 模型） |
| 多账号 | ✅ | 一个凭据记录存数组；刷新和切换/增删/清空共用 vault 事务队列，切换会等待刷新结束 |
| 客户端伪装 | ✅ | UA / `x-app` / `anthropic-beta` / `system[0]` 身份句 / 去掉浏览器专属头 |
| 额度 | ⚠️ 实验 | 调 Claude Code `/usage` 用的 `api/oauth/usage`，字段以服务端返回为准 |
| 系统提示与工具 | ✅ 修补 | pi-ai 1.1.0 的 anthropic 分支不读 `context.systemPrompt`/`context.tools`，本插件把两者物化进首条 system 消息，否则请求里既没 system 也没 tools |
| 设置页 | ✅ | 左侧「Claude 订阅」分区：登录、粘贴授权码、真实账号名与计划、额度卡片、切账号、看模型与指纹 |

## 安装

```sh
dsh plugin --profile desktop add file:./vendor/dsh-claude-subscription-0.2.1.tgz
```

或在 profile 的 `package.json` 里加依赖与 bundle 后重启宿主。

预构建安装包也会随 [GitHub Release](https://github.com/lornwolf/dsh-claude-subscription/releases) 发布。Web profile 可直接安装固定版本的发布资产：

```sh
dsh plugin --profile web add https://github.com/lornwolf/dsh-claude-subscription/releases/download/v0.2.1/dsh-claude-subscription-0.2.1.tgz
```

桌面版请使用应用自带的插件管理入口；部分全局 `dsh` CLI 会拒绝操作 `desktop` 保留配置。更新后完全退出并重新打开 DSH。

## Claude 5 及以上：精简系统提示

`~/.dsh/prompt-inject.md` 如果存在，宿主会把它拼进系统提示最前面。实测：

| 模型 | 带注入段的请求 |
| --- | --- |
| `claude-fable-5-1` / `claude-opus-5` / `claude-sonnet-5` 等 **5+** | 被 Anthropic 生成前拦截：`violative cyber content` |
| `claude-sonnet-4-6` / `claude-opus-4-8` 等 **4.x 及更早** | 正常 |
| DeepSeek / GPT 路线 | 不受影响（不过那道分类器） |

所以插件对 **Claude 5+** 的请求改用**精简系统提示**：只发「Claude Code 身份句 + 一段中性工程助手设定 + `~/.dsh/AGENTS.md`（截断 4KB）」，不再发送 DSH 的整段系统提示（其中可能夹着注入段）。工具表由 `tools` 字段单独发送，不受影响。

为什么不是"剔除注入段"：实测 DSH 拼装时会重写注入的首行（`<|im_start|>system:<project_instructions>` 被拆成两行），注入内容也不是文件原文的逐字拷贝，且它与 harness 提示拼成同一段文本 —— 按原文做子串切分既容易失配、也可能误删整段系统提示。精简模式是确定性的。

- 4.x 及更早的 Claude、DeepSeek、ChatGPT：**完全不受影响**，系统提示原样发送
- 开关：`config.modernClaudeMode`（`"minimal"` 默认 / `"strip-inject"` 只剔除注入段）、`config.sanitizeModernClaude: false` 关闭、`config.injectFile` 指定注入文件
- 诊断：默认把每次 5+ 请求的 system 摘要写入 `~/.dsh/state/claude-subscription/last-request.json`（可用 `config.diagnostics: false` 关闭）
- 正文过滤：`lib/text-filter.js` 在流式文本里删掉模型手写的 `<invoke …>…</invoke>` 工具语法（`config.filterNarration: false` 可关闭），工具结果卡片不受影响；完整的 `<invoke>` 调用块会转成真正的工具调用执行，**调用之后的正文整块丢弃**（那是模型在拿到工具结果前凭空写的结论，例如「联网工具全都没返回，没法下结论」）
- 空回复兜底：`lib/empty-response.js`。Claude 5+ 偶发返回「只有 thinking、没有正文和工具调用」的 end_turn，DSH 的判空只看 `content.length === 0`，会把它当成正常完成、界面停在白屏。这里先缓冲首轮事件，确认产出再放行；确实为空就原样重发一次，两次都空则抛出明确的 `PI_AI_ERROR`
- thinking 签名：`lib/fingerprint.js` 的 `stripReasoning` 在出站前丢掉 assistant 历史里的 reasoning 块。签名绑定的是模型**原始**内容，而我们会剥掉 `<invoke>`、追加合成 tool_use，签名必然失效；实测服务端对失效前缀的回应就是那条空回复，而**不带 thinking 块的请求被正常接受**（服务端对 `thinking.type.disabled` 与 `thinking.adaptive.block_binding` 都回 400，前者不支持、后者是未知字段）

## 设置页（左侧「Claude 订阅」）

`lib/client.js` 往设置面板的 `settings.section` 槽注册一个分区：登录按钮、授权链接与授权码输入、账号列表（切换/移除）、额度、模型清单、当前指纹。浏览器只拿到状态与授权链接，凭据与网络请求都留在宿主进程。

宿主侧由 `lib/rpc.js` 在 `connection.fetch` 上挂 `/api/claude-subscription/*` 十个端点（status / login / login/submit / login/cancel / logout / quota / accounts/select / accounts/remove / models/refresh / routing/set），信封走 DSH 既有的 `{rpcId, method, payload}` → `{type: "server-response", rpcId, result}`。

> 需要 `ui-settings` 处于启用状态才有设置面板可挂；有的部署把它关掉了，那时用下面的工具同样能完成登录。

## 工具（会话里直接说人话即可）

| 工具 | 用途 |
| --- | --- |
| `claude_subscription_status` | 登录状态、账号列表、可用模型、当前指纹 |
| `claude_subscription_login` | 取授权链接（`copy_code` 默认，或 `browser` 起 53692 回调） |
| `claude_subscription_login_submit` | 提交授权页给出的 `code#state` |
| `claude_subscription_account_select` / `_remove` | 多账号切换 / 移除 |
| `claude_subscription_logout` | 清空本地账号 |
| `claude_subscription_quota` | 查额度窗口与重置时间 |

## 伪装层怎么工作

`lib/context.js` + `lib/fingerprint.js`，全部在请求离开本机前完成，**不依赖宿主文件补丁**——即使宿主里的 pi-ai 被改写或升级，这里在运行期仍会重新补回。

1. **请求头**：`user-agent: claude-cli/2.1.280 (external, cli)`、`x-app: cli`、`anthropic-beta` 补齐 `claude-code-20250219` + `oauth-2025-04-20`；删掉 `anthropic-dangerous-direct-browser-access`（浏览器 SDK 才会带，官方 CLI 不发）与残留 `x-api-key`（订阅只认 Bearer）。
2. **请求体**：`system[0]` 固定为 `You are Claude Code, Anthropic's official CLI for Claude.`，宿主自己的提示词接在后面；幂等，不会重复插。
3. **工具表**：关掉 `supportsMidConvoSystemMessages` / `supportsMidConvoToolChanges` 两条 compat，避免 pi-ai 在请求里塞 `__pi_deferred_placeholder__` 占位工具，让每个请求只带一份固定工具表（与 Claude Code 一致）。

刻意**没有**做的指纹项：工具名按 Claude Code 的大小写重命名（要在流里反解回来，容易把工具调用搞坏）、`metadata.user_id`（格式拿不准，默认关闭，可在 config 里打开）。

## 配置

`apply(ctx, config)` 接受：

```yaml
- id: claude-subscription
  name: 'dsh-claude-subscription'
  config:
    displayName: Claude 订阅
    autoSwitch: off              # off / priority / quota-aware；省略时使用设置页保存的选择
    catalogRefresh: true         # 启动、登录/切换账号后和每小时后台刷新目录
    identity:
      userAgent: claude-cli/2.1.280 (external, cli)
      appHeader: cli
      dropBrowserHeaders: true
      dropSdkHeaders: false      # 打开后连 x-stainless-* 也删
      metadataUserId: null       # 填字符串则带上 metadata.user_id
```

## 0.2.1 修复在线目录的思考参数回归

0.2.0 用在线 effort 档位替换 `thinkingLevelMap` 时丢失了 SDK 的 `off: null` 协议标记，导致 Claude 5+ 在关闭思考时发送不支持的 `thinking: { type: "disabled" }`，收到 HTTP 400 / `INVALID_REQUEST`。现在保留已知模型的 off 映射，并为仅支持 adaptive thinking 的模型设置 `off: null`。现有磁盘目录缓存重新读取时也会自动修复，无需删除缓存或重新登录。新增真实 SDK 出站测试，覆盖已知/新发现模型及 off、low、high 三种档位。

## 0.2.0 额度、模型目录与账号路由

- **额度格式**：兼容 `five_hour` / `seven_day*` 及 `limits[]`，保留模型范围、重置时间和超过 100% 的已用值；数组有效时优先使用，否则回退旧字段。
- **共享额度缓存**：设置页、会话入口与工具共用按账号隔离的 5 分钟缓存；同账号并发查询合并。过期可先显示旧值并后台更新，失败仍显示上次成功值和更新时间。429 遵守 `Retry-After`，手动查询也不绕过冷却；没有该头时失败冷却 1 分钟。不发送额外推理请求探测额度。
- **模型目录**：登录后及后台每小时读取官方 `/v1/models`，支持分页。按账号缓存到 `~/.dsh/state/claude-subscription/catalogs/`（或 `DSH_HOME` 下），重启和网络故障时继续使用上次成功结果；没有结果时用 pi-ai 内置目录。设置页可手动刷新，输入/输出上限与 thinking/effort 能力随发现结果更新。SDK 未收录的新模型复用 Messages 协议；缺失能力信息时采用保守限制和文本输入，需要实际接口支持才能使用。
- **授权续期**：提前 5 分钟刷新，保存真实到期时间。临时错误按冷却时间重试；400/401/403 或无效令牌响应会暂停自动续期并提示重新登录。旧 access token 未到期时继续使用。切换账号不会清除续期失败状态，新凭据会使旧状态失效。
- **进程间协调**：用 `@deepseek-ai/dsh-atomic-write` 的文件锁覆盖账号库整个读改写/续期事务；刷新期间发现凭据已被外部替换，保留新凭据。锁等待最多 45 秒，取消的等待者不会执行修改。异常退出可能遗留 `accounts.lock`；只有确认所有使用该账号库的 DSH 进程都已停止，才可移除遗留锁，插件不会按文件年龄强行解锁。
- **会话额度入口**：支持 `conversation.composer.dock` 和 `modelDirectories` 的宿主会在 Claude 会话输入框附近显示剩余额度；点击可看账号、重置时间和数据更新时间。故障转移后显示该会话实际使用的账号，切到其他提供商时隐藏。挂载期间每 15 秒检查会话状态，额度网络请求仍受共享缓存限制。
- **可选自动切换**：设置页提供关闭、故障时切换、按额度选择三种策略，选择保存在 `routing.json`，重启后生效。配置中的 `autoSwitch` 指定初始策略；显式 `false` 或 `off` 表示关闭。按额度选择会避开已用 ≥95% 的有效窗口，优先使用临近重置且有剩余额度的账号；已建立的会话尽量固定账号。不会改变手动选择的默认账号。只有尚未输出任何内容时，才对认证、限流或临时服务故障尝试其他账号；请求取消、参数错误和上下文超限不切换。自动切换开启时模型选择器合并各账号目录。历史回放元数据绑定账号与模型，换账号时降级为普通历史；运行中的请求使用独立凭据快照。

会话账号绑定和故障冷却仅存内存，重启后重新选择账号。现有凭据格式无需迁移；旧版保存的保守到期时间可能触发一次提前续期。新增功能已通过离线测试，真实订阅的模型可用性和额度字段仍以服务端为准。

验证命令：

```powershell
npm install --ignore-scripts --legacy-peer-deps
npm test
# 以下路径指向独立测试依赖，不修改运行中的 DSH：
$env:PI_AI_PACKAGE_ROOT = '<测试依赖目录>/node_modules/@earendil-works/pi-ai'
npm test
$env:DSH_TEST_HOST_ROOT = '<测试依赖目录>'
node --loader ./test/host-loader.mjs ./test/plugin-smoke.mjs
npm pack
```

## 0.1.4 设置页额度 RPC 修复

- 设置页 `quota` 端点原来调用了两个根本没导入的标识符（`readResolvedSubscriptionUsage`、`summarizeUsage`，只有 `export … from` 的再导出，不产生本地绑定），每次点击都抛 `ReferenceError`。改为走 `readAccountSubscriptionUsage()`：带 `accountId`、窗口、额外用量与抓取时间，上游原始 payload 不回传浏览器。
- RPC 失败信封补上 `error.details: {}`。宿主客户端 `parseConnectionResponse` 要求 `details` 是对象，缺了会抛 `connection: invalid server-response failure`，把真实错误吞掉——面板只剩一句看不懂的连接错误，这正是「点查询额度没反应」的观感来源。
- 新增两条测试：宿主冒烟里跑一次真实 `quota` RPC（断言 `accountId`、两个窗口、无 `raw`），以及 RPC 失败信封形状测试。

## 0.1.3 设置面板：真实账号名、额度卡片、字体统一

- 账号名来自 `api/oauth/profile`（displayName / email / plan / organization），由 status RPC 在缓存过期时刷新并写回 vault；默认占位名（`Claude 1`）会被真实名字替换，用户自己起的备注名不动。
- 面板不再显示 vault 内部 id（`claude-mv…`）；账号行只显示名字、邮箱与计划。
- 额度改成卡片式：窗口名、剩余百分比、进度条、剩余与重置时间；面板打开时自动读一次额度（每个账号一次）。不再输出 `pre` 纯文本。
- 面板所有文字（含客户端指纹区）统一沿用宿主默认字体；只有百分比数字用 `font-variant-numeric: tabular-nums` 保证对齐。
- 账号资料刷新失败时显示缓存并给出一行提示，不会让面板空掉。
- 新增/更新设置面板测试，覆盖自动读额度、账号切换丢弃旧额度、无内部 id 与字体断言。

## 0.1.2 修复宿主归一化后的工具与思考历史

- 实际 DSH 会先调用 `Models.normalizeContext`，将工具表放进首条 system 的 `toolsAdded`。精简模式现仅替换该消息的文字，保留工具增删与其他元数据，避免出站 `tools: []`。
- `stripReasoning` 同时移除 Harness 的 `reasoning` 和 pi-ai 的 `thinking` 历史块（包括携带签名或 redacted 标记的 thinking），而非只匹配一种字段名；不伪造或改写签名。
- 新增真实 `Models.streamSimple → normalizeContext → minimal → provider` 整链路离线测试，覆盖 Fable 5 工具表、原生/XML 调用后的结果回放及思考签名清理。
- 用真实订阅和隔离工具夹具跑过两轮：首轮调用 `read`，第二轮收到夹具结果并正常输出标记。

## 0.1.1 认证与可靠性修复

- OAuth 使用插件自己的 `lib/oauth.js`，独立生成 state 与 PKCE verifier，保留 browser / copy_code 两种方式及现有凭据格式；结构化授权结果严格校验唯一 code/state。裸授权码保留兼容支持。
- 账号刷新与切换/新增/删除/清空共用同一 vault 的事务队列；多个 store 共享同一 vault 时有效，不是跨进程锁。损坏的存储报错并保留原值。
- 登录默认 10 分钟总期限；提交默认 120 秒，超时会取消后台任务；取消旧登录不会清掉新登录。设置页取消按钮现在实际调用宿主取消接口。
- 额度请求先解析/刷新授权，30 秒网络超时并禁止重定向；RPC、工具错误不回显服务端正文或未知异常详情。
- 订阅请求仅接受 OAuth token 和官方 API origin，最终 Authorization 由插件持有；出站日志不再记录 HTTP 错误正文。
- 新增离线并发、OAuth、登录、RPC/额度和真实 SDK 请求契约测试。`npm test` 运行测试；真实 SDK 契约测试需能解析 pi-ai，或设置 `PI_AI_PACKAGE_ROOT` 为只读包根目录。指定包根却加载失败会使测试失败；没有可解析 SDK 时明确显示跳过。
- 保留 `anthropic` 路由名、既有请求身份与正文过滤行为；此次不迁移已有会话、不扩展模型计费能力。

## 已知边界

- 额度接口未在真实订阅上验证过；失败只影响额度工具，不影响对话。
- 请求体结构与 Claude Code 不完全一致（工具定义、thinking 配置来自 DSH 与 pi-ai），这是第三方接入的固有差异；本插件只保证**客户端身份**这一层可辨别特征与官方一致。
- 订阅走的是计划额度，不是 API 计费；账号能否用、能用多少由 Anthropic 侧决定。
