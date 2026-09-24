# Architecture

本文档详细说明 dsh-llm-failover 插件的架构设计。

## 概述

本插件挂在 DeepSeek Harness agent loop 的两个协作式 waterfall 扩展点上，以**最外层监听者**身份挂接，零改动核心循环：

1. `agent/request-error` — 请求失败恢复点
2. `agent/request` — 每次构建请求时的路由提议点

## agent/request-error（请求失败恢复点）

当一次 LLM 请求失败时，agent loop 会触发 `agent/request-error` 事件，waterfall 中的监听器依次有机会处理该错误。

### 处理流程

```
请求失败
  │
  ▼
错误分类
  ├── 永久错误 (AUTH/INVALID_REQUEST/UNKNOWN_MODEL/CONTEXT_WINDOW_EXCEEDED/ABORTED)
  │   └── 永不切换，让原始 LlmError 冒泡
  │
  └── 可恢复错误 —— 先分「墙」还是「抖动」（见下节判定表）
      │
      ├── 墙（配额/用量窗口/上游公布 ≥60s 的重置时间）
      │   ├── 不计数：第一次失败就接管（wall 是事实，不是抖动）
      │   ├── 停车：上游公布的重置时间原样使用；没公布则 quotaCooldownSeconds
      │   ├── 从优先级池选出下一个健康目标
      │   └── 返回 {kind:"retry"}
      │
      └── 抖动（5xx/超时/传输/流中断/短促 429）
          │
          ├── 该 provider 连续失败计数 +1（半开状态下不计数，直接按探针失败处理）
          │
          ├── 未达 maxConsecutiveFailures 阈值
          │   └── 返回 undefined → 交给下游栈处理（通常是 dsh-llm-retry 的有界指数退避重试）
          │       下游返回的任何决策（不限于 retry）都原样透传，不会被覆盖
          │       若没有任何下游策略认领失败，插件以 250ms 起步、上限 2s 的指数退避自行重试同一 provider
          │
          └── 达到阈值（或该 provider 正在半开探针中且这次又失败）
              ├── 停车：cooldownSeconds × 2^(连续停车次数-1)，封顶 maxCooldownSeconds
              ├── 从优先级池选出下一个健康目标
              └── 返回 {kind:"retry"}
```

### 墙 / 抖动判定表（`resolveResetPlan`）

| 信号 | 判定 | 停车 |
| --- | --- | --- |
| `failure.code === "QUOTA"` | 墙 | `quotaCooldownSeconds`，按连续停车翻倍 |
| 任何 ≥60s 的重置（`providerRetryAfterMs`、正文 `resets at <ISO>`、"retry again in N 单位"） | 墙 | **上游给的值原样**（≤30 天上界） |
| 账号级措辞（"usage limit for your plan"、"insufficient credits"、"premium credits exhausted"…） | 墙 | `quotaCooldownSeconds`，翻倍 |
| 其余（含 <60s 的重置） | 抖动 | `cooldownSeconds`，翻倍 |

两个刻意的取舍：
- **模糊措辞不算墙**。单独一句 "quota exceeded" 既可能是每分钟配额也可能是月度额度，只有上游同时公布了
  ≥60s 的重置时间它才算墙。宿主自己的 `isQuotaExceededError` 已把多数此类措辞映射成 `QUOTA` code，
  所以主路径通常由 code 命中，措辞表只做兜底（同样来自 Command Code 那套 issue #54 的教训：点名了
  窗口才算窗口用尽）。
- **信息不打折，只惩罚递增**。上游公布的重置时间永远按原样使用（不做翻倍），翻倍只作用于无法得知恢复
  时间的失败——那是惩罚，不是信息。

### 收手条件

- 没有任何健康目标（所有 provider 都在停车中）
- 本回合切换次数达到 `maxSwitchesPerTurn`

收手时让原始 LlmError 冒泡，而不是无限 A→B→C→A 循环。同时把**可诊断信息写进宿主日志**：

```
no healthy target left (last failure: "commandcode" QUOTA); failing this request.
  Earliest recovery: "bailian" in 42m (it is admitted as a probe then)
provider states: commandcode=parked(4h, wall), bailian=parked(42m, failures)
```

为什么进日志而不是进错误：这个 seam 的返回值只有 `{ kind: 'retry' } | undefined`，替换不了客户端看到的
错误文案。详见 [session-compatibility.md](session-compatibility.md)。

## agent/request（路由提议点）

每次 agent loop 构建 LLM 请求时触发。插件检查目标 provider 是否处于停车期：

```
构建请求
  │
  ▼
目标 provider 处于停车期？
  ├── 否 → 不做任何修改，原样通过
  │        （半开状态的 provider 会被放行 —— 这一次就是它的探针）
  └── 是 → 自动改写到当前最优健康条目
      ├── 优先级：完全健康的 provider 优先于半开的
      │   （未证明恢复的 provider 不抢占健康的）
      └── 改写时丢弃继承的 reasoningEffort
          （属于失败路由的每模型设置，目标可能不支持）
```

后续 step 无缝继续跑在新模型上。

## 双通道恢复（半开探针）

### 通道一：冷却到期 → 半开探针

冷却到期**不等于恢复**。该 provider 变成 *half-open*：下一次解析到它的请求被放行，这一次请求就是探针。

- 出活（assistant message 证明）→ 记录连同惩罚一起清空（`probe succeeded after N park(s)`）
- 又失败 → **立刻回停车**，不重新攒阈值，下一次冷却翻倍（`parked for 2m after a failed probe`）

这是熔断器 half-open 语义在"观察者"位置的适配：本插件不代理调用、只看失败，所以做不到 opossum 那种
"半开只放一个并发探针"；改为用"探针失败立刻回停车 + 冷却递增"限制影响面。

### 通道二：assistant message 主动恢复

任何 assistant 消息证明某 provider 成功出活时，立即主动恢复并清零连续失败计数。**歧义保护**：若窗口内
刚发生过"由本插件发起的改道"，这条归属证据会被判为歧义并拒收（`ignoring a success attributed to …`），
否则下一次请求会被弹回一个仍然失败的 provider。

## 上下文/任务连续性

失败尝试按既有语义闭合其 step、不物化半截消息（与 llm-retry 相同保证）。会话历史、工具状态、任务进度全部保存在持久会话里，不依赖具体哪个 provider 服务某个 step。用户无感知、无需重新输入任务。

## 与 llm-retry 共存

- 阈值以下：决策权归 llm-retry（行为与未安装本插件完全一致）
- 达到阈值：由本插件接管并切换 provider
- 下游返回的任何决策（不限于 retry）都原样透传，不会被覆盖

## 健康管理粒度

- 以 provider 为健康管理粒度（与 llm-retry 一致）
- 同一 provider 下多个模型共享健康状态
- 多个并发 agent 的每回合切换预算相互独立（按 agent.id 计数）
- 只有实际发生的切换才计入预算
- 长期未进入 idle 状态的 agent，其预算条目会在 1 小时后惰性清除
- provider 健康条目在完全恢复后即删除——两张状态表均有界

## 已知限制

- 切换目标必须显式列在 `models` 里；不会从适配器目录自动推导
- 直接消费 `ctx.llm.stream()` 的旁路调用（如标题生成、compaction 摘要）不在 agent loop 重试边界内
- 半开探针没有并发上限（见「双通道恢复」一节的说明）
- 健康状态只在内存里：重启后从头开始（乐观），第一次失败重新学习

## 借鉴来源

上面这套判定的每一处都能指出来源，不是从零设计的（README 里有完整的对照表）：

- **墙/抖动分开、按上游公布的重置时间停车、终止时报最早恢复时间** ← LiteLLM Router（429 立即冷却、
  retry-after 作最短等待、每类阈值、fallback 路径也要冷却）
- **half-open 探针 + 冷却递增封顶** ← opossum（Node 熔断器）
- **"点名了窗口才算窗口用尽"、账号级措辞标记表、`resets at <ISO>` 记法** ←
  @mars-sea/dsh-commandcode-provider（issue #54 / #51 后续）
- **`providerRetryAfterMs` 作为唯一结构化重置信号、阈值以下让权** ← 宿主自带的 dsh-llm-retry 的分工
