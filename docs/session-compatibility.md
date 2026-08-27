# Session Compatibility

本文档记录 dsh-llm-failover 插件在会话兼容性方面的研究发现和设计决策。

## 问题背景

插件最初设计了在故障切换时向会话追加 `llm/failover` 自定义事件类型，用于在 Web 会话流中显示切换提示。后续研究发现这会导致严重的会话重载兼容问题。

## 研究发现（S0 实验，2026-08-26）

### 实验方法

使用彩排树（隔离的完整 DSH 环境）真实加载栈，对比测试：
- 干净日志 → 正常加载 ✅
- 含官方 `llm/retry` 事件的日志 → 正常加载 ✅
- 含自定义 `llm/failover` 事件的日志 → 加载失败 ❌

### 失败原因

持久化读取闸门 `assertEventsSupported`（`dsh-session-persistence`）遇到「不在 `KNOWN_SESSION_EVENT_TYPES` 且未标 `ignorable: true`」的事件时，会抛 `SessionFormatUnsupportedError`，拒绝解释整个日志。

该闸门覆盖全部四条加载路径：
- prepareCore
- 全量读
- 增量 suffix 读
- adoptLivePrefix (HMR)

### 关键约束

公开 API `session.append()` 的信封字段固定为 `type/seq/time/data/surfaceOp/sourceEventSeqs`，**没有写入 `ignorable` 标记的途径**。

### 结论

任何自定义会话事件写入都会埋下重载地雷——该事件所在会话在重启/重载后将无法打开。

## 处置决策（队长裁决，2026-08-26）

**方案 a：移除会话事件追加，只留宿主日志**

已在 rc.3 实施：
- `appendEvent` 及其全部调用点删除
- 测试以「插件永不写任何会话事件」不变量覆盖（Test 2/4/5/7/7b/8/16）
- S0 决定性实验脚本固化为 `scripts/qa-s0-session-compat.mjs`

## 会话内可见切换提示 — descoped

目标是在切换发生时于 Web 会话流中给出可见提示。对 DSH 当前构建的结论：**插件侧不存在受支持的实现通道**。

### 证据链

1. **可见性由 surface 投影层决定**：只有带合法 `surfaceOp` 的既登记类型才投影进人类可见 transcript；`llm/failover` 作为非表层事件追加，设计上就不进对话流。给未登记类型强加 `surfaceOp` 会在 append 时被拒。

2. **客户端渲染按类型硬编码**：官方 `llm/retry` 的可见重试指示依赖核心客户端 bundle 中逐类型精确匹配的状态机（`dsh-client-ui-conversation` 13 处、`dsh-client-ui-trajectory` 2 处、`dsh-client-connection` 3 处 `event.type === "llm/retry"` 分支），不存在面向任意插件事件类型的通用渲染回退。

3. **事件词汇表封闭**：`KNOWN_SESSION_EVENT_TYPES` 为生成清单（实测 48 个成员：含 `llm/retry`，不含 `llm/failover`）；其生成头注明「仓库外（out-of-repo）插件事件按构造在此清单之外；为它们提供注册面的工作被推迟，直到出现这样的消费者」。

## 当前状态

- 插件不追加任何会话事件
- 决策轨迹只存在于宿主日志（Host 日志面板过滤 `llm-failover`）
- 若未来 DSH 提供词汇注册面或 `ignorable` 公开写入口，可重新评估恢复事件记录
