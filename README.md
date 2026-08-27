# @deepseek-ai/dsh-llm-failover

DeepSeek Harness 的模型自动故障切换（Retry + Failover + 模型健康）插件。

## 工作原理

挂在 agent loop 的两个协作式 waterfall 扩展点上（均为最外层监听器），零改动核心循环：

1. `agent/request-error`（请求失败恢复点）：
   - 可恢复错误（429 / 5xx / 超时 / 网络断连 / SSE 中断）逐次计数；
   - 未达阈值：交给下游既有栈处理（通常是 `dsh-llm-retry` 的有界指数退避重试），行为与现状完全一致；下游返回的任何决策（不限于 `retry`）都原样透传，不会被覆盖。若没有任何下游策略认领失败（如未安装 llm-retry），插件以 250ms 起步、上限 2s 的指数退避自行重试同一 provider——既不因首个瞬时错误即死，也不对限流中的 provider 零延迟热循环；
   - 达到 `maxConsecutiveFailures`（默认 5）：把该 provider 标记为不可用并进入冷却，从优先级池选出下一个健康目标，直接返回 `{kind:"retry"}` 绕过同模型继续重试；
   - 没有任何健康目标（或本回合切换次数达到 `maxSwitchesPerTurn`）：立即收手，让原始 LlmError 冒泡 —— 明确报"所有模型不可用"，而不是无限 A→B→C→A 循环。
2. `agent/request`（每次构建请求时的路由提议点）：
   - 目标 provider 处于冷却期时自动改写到当前最优健康条目；后续 step 无缝继续跑在新模型上；
   - 改写时丢弃继承的 `reasoningEffort`（属于失败路由的每模型设置，目标可能不支持）。

恢复是双通道的：冷却到期后任意一次健康检查惰性放回池中；任何 assistant 消息证明某 provider 成功出活时立即主动恢复并清零计数。

上下文/任务连续性：失败尝试按既有语义闭合其 step、不物化半截消息（与 llm-retry 相同保证），会话历史、工具状态、任务进度全部保存在持久会话里，不依赖具体哪个 provider 服务某个 step。用户无感知、无需重新输入任务。

## 错误分类

| 错误码 | 含义 | 默认 |
|--------|------|------|
| RATE_LIMIT | HTTP 429 | ✅ 切换 |
| SERVER | HTTP 5xx（含 502/503/504 网关超时） | ✅ 切换 |
| TIMEOUT | 请求/连接/空闲看门狗超时 | ✅ 切换 |
| TRANSPORT | fetch failed：DNS、连接重置/拒绝、代理链路异常 | ✅ 切换 |
| STREAM_CLOSED | SSE 流中途中断 | ✅ 切换 |
| EMPTY_RESPONSE | 退化空补全（可安全重复） | ❌ 仅重试 |
| QUOTA | 该 provider 配额耗尽 | ❌ 仅重试 |
| AUTH / INVALID_CREDENTIAL | API Key 无效、认证失败 | 永不切换 |
| INVALID_REQUEST / UNKNOWN_MODEL / UNSUPPORTED_* | 参数错误、模型不存在等 | 永不切换 |
| CONTEXT_WINDOW_EXCEEDED | 交给 compaction-basic 的溢出压缩恢复 | 永不切换 |
| ABORTED | 用户主动取消 | 永不切换 |

## 配置（cordis.patch.yml 插件行 config）

```yaml
- insert:
    - id: llm-failover
      name: '@deepseek-ai/dsh-llm-failover'
      config:
        enabled: true                  # 总开关；false 时行为与未安装本插件完全一致
        models:                        # 故障切换池，数组顺序 = 优先级
          - provider: deepseek-official
            model: deepseek-v4-flash
          - provider: my-siliconflow  # 例：llm-pi-ai settings 里的 profile 名
            model: deepseek-ai/DeepSeek-V3
        maxConsecutiveFailures: 5      # 同一 provider 连续失败多少次后切换
        cooldownSeconds: 60            # 标记不可用的冷却时长（必须 > 0；为 0 会导致路由抖动，校验会拒绝并回退默认值）
        autoRecover: true              # 冷却到期是否自动回到池中（false=直到重启或主动成功）
        maxSwitchesPerTurn: 8          # 单回合最大切换次数（防死循环保险）
        failoverOnRateLimit: true
        failoverOnTimeout: true
        failoverOnServerError: true
        failoverOnTransportError: true
        failoverOnStreamInterrupted: true
        failoverOnEmptyResponse: false
        failoverOnQuota: false
```

未配置键取默认值；未知键不会导致报错，只记录一条警告然后被忽略（配置错误一律降级，不阻断启动）。`models` 为空时插件保持惰性（仅日志提示），配置池后才实际切换。

## 可观测性

- Host 日志（ctx.logger）：每次可恢复失败一行 warn（含连续计数 n/N 与错误文本；错误文本截断至 200 字符，并主动掩码 URL 内嵌凭据、Bearer token 与 key/token 参数——不依赖"适配器绝不带凭据"的假设）；标记/切换/恢复各有一行。
- 本插件**不追加任何会话事件**，决策轨迹只存在于宿主日志。原因（S0 实验，2026-08-26，脚本 `scripts/qa-s0-session-compat.mjs` 可复现）：用彩排树真实加载栈实测，含未知类型 `llm/failover` 的持久化日志会被 `assertEventsSupported` 拒绝（prepare 与 readFrom 增量路径均抛 `SessionFormatUnsupportedError`），会话重启后打不开；而公开 API `session.append()` 的信封字段固定为 type/seq/time/data/sourceEventSeqs/surfaceOp，**没有写入 `ignorable` 豁免标记的途径**，@deepseek-ai 包内也不存在面向插件的事件类型注册扩展点。因此任何会话事件写入都会埋下重载地雷（该事件本来也不会在 Web 会话流中产生可见提示，见下方调研结论）。

## 已知限制

- 以 provider 为健康管理粒度（与 llm-retry 一致）；同一 provider 下多个模型共享健康状态。
- 多个并发 agent 的每回合切换预算相互独立（按 agent.id 计数）；只有实际发生的切换才计入预算，达到阈值但收手的决策不消耗预算。长期未进入 idle 状态的 agent，其预算条目会在 1 小时后被惰性清除，provider 健康条目在完全恢复后即删除——两张状态表均有界。
- 切换目标必须显式列在 `models` 里；不会从适配器目录自动推导（避免猜测每个适配器的默认模型）。
- 直接消费 `ctx.llm.stream()` 的旁路调用（如标题生成、compaction 摘要）不在 agent loop 重试边界内，不受本插件保护。

## 会话内可见切换提示 —— 调研结论（2026-08-26，descoped）

目标是在切换发生时于 Web 会话流中给出可见提示。对 DSH 当前构建（app.asar.unpacked 内置包，只读调研）的结论：**插件侧不存在受支持的实现通道**，本项 descope，可观测性暂以 Host 日志为准。证据链：

1. **可见性由 surface 投影层决定**：只有带合法 `surfaceOp` 的既登记类型才投影进人类可见 transcript；`llm/failover` 作为非表层事件追加（与官方 `llm/retry` 同类），设计上就不进对话流。给未登记类型强加 `surfaceOp` 会在 append 时被拒（`is not surface-eligible and cannot carry surfaceOp`）。
2. **客户端渲染按类型硬编码**：官方 `llm/retry` 的可见重试指示依赖核心客户端 bundle 中逐类型精确匹配的状态机（`dsh-client-ui-conversation` 13 处、`dsh-client-ui-trajectory` 2 处、`dsh-client-connection` 3 处 `event.type === "llm/retry"` 分支），不存在面向任意插件事件类型的通用渲染回退；修改这些 bundle 即修改 DSH 本体，超出插件边界。
3. **事件词汇表封闭**：`KNOWN_SESSION_EVENT_TYPES` 为生成清单（实测 48 个成员：含 `llm/retry`，不含 `llm/failover`）；其生成头注明「仓库外（out-of-repo）插件事件按构造在此清单之外；为它们提供注册面的工作被推迟，直到出现这样的消费者」。GUI 插件的 `dsh.client` 客户端模块机制（webPlugins）提供的是布局级扩展面，并非会话行渲染 seam。

### 附带发现处置记录：自定义会话事件类型的重载风险（已裁决并缓解，2026-08-26）

调研中发现一个超出本任务范围的正确性风险：持久化读取闸门 `assertEventsSupported`（`dsh-session-persistence`，覆盖 prepareCore / 全量读 / 增量 suffix 读 / adoptLivePrefix(HMR) 全部四条加载路径）遇到「不在 `KNOWN_SESSION_EVENT_TYPES` 且未标 `ignorable: true`」的事件会抛 `SessionFormatUnsupportedError`，拒绝解释整个日志；而公开 API `session.append()` 的信封字段固定为 type/seq/time/data/surfaceOp/sourceEventSeqs，**没有写入 `ignorable` 标记的途径**。这意味着本插件当前在真实故障时追加的每一条 `llm/failover` 事件，都可能使其所在会话在重启/重载后无法打开（SessionFormatUnsupportedError）。处置（队长裁决 = 方案 a，2026-08-26）：移除会话事件追加、只留宿主日志，已在 rc.3 实施——`appendEvent` 及其全部调用点删除；测试以「插件永不写任何会话事件」不变量覆盖（Test 2/4/5/7/7b/8/16）；S0 决定性实验脚本固化为 `scripts/qa-s0-session-compat.mjs`（对照：干净日志与官方同类 `llm/retry` 均正常加载）。若未来 DSH 提供词汇注册面或 `ignorable` 公开写入口，可重新评估恢复事件记录。

## 与本地 AI 网关的分工

本插件负责模型级故障转移；若未来流量经本地 AI 网关（key 级转移），两层阈值应错开避免双重切换。

