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
  ├── 可恢复错误 (RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/STREAM_CLOSED/EMPTY_RESPONSE/QUOTA)
  │   │
  │   ├── 该 provider 连续失败计数 +1
  │   │
  │   ├── 未达 maxConsecutiveFailures 阈值
  │   │   └── 返回 undefined → 交给下游栈处理（通常是 dsh-llm-retry 的有界指数退避重试）
  │   │       下游返回的任何决策（不限于 retry）都原样透传，不会被覆盖
  │   │       若没有任何下游策略认领失败，插件以 250ms 起步、上限 2s 的指数退避自行重试同一 provider
  │   │
  │   └── 达到 maxConsecutiveFailures 阈值
  │       ├── 把该 provider 标记为不可用
  │       ├── 进入冷却（cooldownSeconds）
  │       ├── 从优先级池选出下一个健康目标
  │       └── 返回 {kind:"retry"} → 绕过同模型继续重试
  │
  └── 永久错误 (AUTH/INVALID_REQUEST/UNKNOWN_MODEL/CONTEXT_WINDOW_EXCEEDED/ABORTED)
      └── 永不切换，让原始 LlmError 冒泡
```

### 收手条件

- 没有任何健康目标（所有 provider 都在冷却中）
- 本回合切换次数达到 `maxSwitchesPerTurn`

收手时让原始 LlmError 冒泡，明确报"所有模型不可用"，而不是无限 A→B→C→A 循环。

## agent/request（路由提议点）

每次 agent loop 构建 LLM 请求时触发。插件检查目标 provider 是否处于冷却期：

```
构建请求
  │
  ▼
目标 provider 处于冷却期？
  ├── 否 → 不做任何修改，原样通过
  └── 是 → 自动改写到当前最优健康条目
      └── 改写时丢弃继承的 reasoningEffort
          （属于失败路由的每模型设置，目标可能不支持）
```

后续 step 无缝继续跑在新模型上。

## 双通道恢复

### 通道一：冷却到期惰性恢复

冷却到期后，任意一次健康检查（下一次请求路由时）将该 provider 放回池中。

### 通道二：assistant message 主动恢复

任何 assistant 消息证明某 provider 成功出活时，立即主动恢复并清零连续失败计数。

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
