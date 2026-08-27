# dsh-llm-failover

> When your model goes down, your task doesn't.

DeepSeek Harness 的社区模型自动故障切换插件。当 Provider 出现 429 / 5xx / 超时 / 网络错误 / SSE 中断时，自动切换到健康模型继续执行，而不是让整个任务失败。

⚠️ Community plugin for DeepSeek Harness. Not affiliated with or endorsed by DeepSeek.

[![version](https://img.shields.io/badge/version-0.1.1--rc.4-green)](https://github.com/guangxiangwu6-cmd/dsh-llm-failover/releases)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-19%2F19%20passing-brightgreen)](test/failover.test.mjs)
[![boot-safe](https://img.shields.io/badge/boot--safe-rehearsal%20proven-informational)](INSTALL.md)

## What & Why

你在用 DeepSeek Harness 跑任务，突然当前模型挂了——429 限流、5xx 服务端错误、超时、网络断连、SSE 流中断。没有 failover 插件时，整个任务直接失败，你得手动重试。

本插件在 Provider 级别实现自动故障转移：

```
Provider A (DeepSeek V4)
  │
  ├── 429 / 5xx / Timeout / Network Error
  │
  ▼
Failure threshold reached (default: 5)
  │
  ▼
Provider A → marked unhealthy, enters cooldown
  │
  ▼
Switch to Provider B (next healthy model in priority pool)
  │
  ▼
Task continues seamlessly — same session, same context
  │
  ▼
Cooldown expires → Provider A automatically recovers
```

## Features

- **自动 Retry + Failover** — 基于 agent loop 的两个公开 waterfall 扩展点，零修改核心循环
- **Provider 健康管理** — 按 provider 粒度跟踪连续失败次数
- **优先级池切换** — `models` 数组顺序即优先级
- **双通道恢复** — 冷却到期惰性恢复 + assistant message 主动证明恢复
- **最大切换保护** — 单回合切换上限防止死循环
- **错误分类** — 7 种可恢复错误 + 多种永久错误，精确决定是否切换
- **敏感信息日志脱敏** — URL 凭据 / Bearer token / key 参数自动掩码
- **Session 安全设计** — 不写自定义事件类型，避免会话重载兼容问题
- **与 llm-retry 共存** — 阈值以下决策权归 llm-retry，达到阈值才由本插件接管

## Installation

三步手工操作，不联网、不 `npm install`：

```powershell
# 1. 复制插件到 Harness（排除 node_modules）
$dst = "<DSH安装目录>\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai\\dsh-llm-failover"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "<本仓库目录>\\*" $dst -Recurse -Force -Exclude node_modules

# 2. 把 patches/cordis.patch.snippet.yml 的内容追加到 DSH home 下的 profiles\\desktop\\cordis.patch.yml 末尾
#    DSH home 默认：Windows %USERPROFILE%\\.dsh / Linux·macOS ~/.dsh

# 3. 重启 DeepSeek Harness Desktop
```

启动日志出现 `llm-failover active` 即加载成功。详见 [INSTALL.md](INSTALL.md)。

完全可逆：删目录 + 删配置块 + 重启。

## Quick Configuration

`models` 数组的顺序就是故障切换优先级——排在第一位的是主模型，后面的依次作为备份。

```yaml
- insert:
    - id: llm-failover
      name: '@deepseek-ai/dsh-llm-failover'
      config:
        enabled: true                  # 总开关
        models:                        # 故障切换池（顺序 = 优先级）
          - provider: deepseek-official
            model: deepseek-v4-flash
          - provider: my-siliconflow   # llm-pi-ai settings 里的 profile 名
            model: deepseek-ai/DeepSeek-V3
        maxConsecutiveFailures: 5      # 同一 provider 连续失败多少次后切换
        cooldownSeconds: 60            # 冷却时长（必须 > 0）
        autoRecover: true              # 冷却到期是否自动回池
        maxSwitchesPerTurn: 8          # 单回合最大切换次数
```

未配置键取默认值；未知键不会导致报错，只记录警告后忽略。`models` 为空时插件保持惰性。

### Per-class failover switches

| Switch | Default | Controls |
|--------|---------|----------|
| failoverOnRateLimit | ✅ true | HTTP 429 |
| failoverOnTimeout | ✅ true | 请求/连接/空闲超时 |
| failoverOnServerError | ✅ true | HTTP 5xx |
| failoverOnTransportError | ✅ true | 网络/代理链路异常 |
| failoverOnStreamInterrupted | ✅ true | SSE 流中断 |
| failoverOnEmptyResponse | ❌ false | 退化空补全 |
| failoverOnQuota | ❌ false | 配额耗尽 |

## Error Classification

| Error | Default Behavior | Why |
|-------|-----------------|-----|
| RATE_LIMIT (429) | Failover | Provider 限流，切换可能绕过 |
| SERVER (5xx) | Failover | 服务端瞬时故障 |
| TIMEOUT | Failover | 请求/连接超时 |
| TRANSPORT | Failover | DNS、连接重置/拒绝、代理异常 |
| STREAM_CLOSED | Failover | SSE 流中途中断 |
| EMPTY_RESPONSE | Retry only | 可安全重复，不一定需要切模型 |
| QUOTA | Retry only | 配额问题，切模型不一定解决 |
| AUTH / INVALID_CREDENTIAL | Never failover | 凭证问题，切换无用 |
| INVALID_REQUEST / UNKNOWN_MODEL | Never failover | 请求本身有误 |
| CONTEXT_WINDOW_EXCEEDED | Never failover | 交给 compaction 处理 |
| ABORTED | Never failover | 用户主动取消 |

## Architecture

```
agent/request-error (请求失败恢复点)
  │
  ├── 可恢复错误 → 计数
  │   ├── 未达阈值 → 交给下游栈（通常是 llm-retry）
  │   └── 达到阈值 → 标记不可用 + 冷却 → 切换到下一健康目标
  │
  └── 永久错误 → 永不切换，让错误冒泡

agent/request (每次构建请求时)
  │
  └── 目标 provider 处于冷却期 → 自动改写到当前最优健康条目
      └── 改写时丢弃继承的 reasoningEffort（属于失败路由的每模型设置）
```

恢复是双通道的：冷却到期后惰性放回池中；任何 assistant 消息证明某 provider 成功出活时立即主动恢复。

详见 [docs/architecture.md](docs/architecture.md)。

## Project Status

> **Release Candidate** — 版本 0.1.1-rc.4

- ✅ 核心 failover 功能已实现并通过 19/19 测试
- ✅ 启动安全设计经真实加载器验证
- ✅ 已安装进真实 DSH Desktop 环境（2026-08-27）
- ✅ QA 彩排脚本 6 个（smoke / badconfig / disabled / doc-crosscheck / s0-session-compat / final-round）
- 🔄 当前生产配置：deepseek-official/deepseek-v4-flash，1 模型池（待扩展）

### Intentionally descoped

- **会话内可见切换提示** — DSH 当前未暴露注册自定义会话事件类型的扩展点，插件侧不存在受支持的实现通道。详见 [docs/session-compatibility.md](docs/session-compatibility.md)。
- **自动推导备份模型** — 切换目标必须显式列在 `models` 里，不会从适配器目录自动推导。
- **旁路调用保护** — 直接消费 `ctx.llm.stream()` 的调用（标题生成、compaction 摘要）不在保护范围内。

### 未来可能的扩展

- 若 DSH 提供事件词汇注册面或 `ignorable` 公开写入口，可重新评估恢复会话事件记录
- 与本地 AI 网关集成时的双层阈值错开策略

## Security

本插件在设计上避免敏感信息泄露：

- **URL 内嵌凭据掩码** — 日志中 URL 里的 `key=`、`token=` 参数自动替换为 `***`
- **Bearer token 掩码** — Authorization header 中的 token 不会明文出现在日志
- **错误文本截断** — 错误信息截断至 200 字符，减少意外泄露窗口
- **不写会话事件** — 决策轨迹只存在于宿主日志，不追加任何会话事件

## Troubleshooting

| Problem | Check |
|---------|-------|
| 插件没有加载 | 启动日志搜索 `llm-failover`，确认目录复制位置正确 |
| models 没有配置 | `models` 为空时插件仅日志提示，不执行切换 |
| provider 名称配置错误 | 切换目标会跳过不存在的 provider，不影响原请求 |
| 模型切换没有发生 | 检查 `maxConsecutiveFailures` 是否达到；检查 per-class 开关 |
| 为什么 AUTH 不切换 | 凭证问题切换无用，设计行为 |
| 为什么某些错误只 retry | 参考 Error Classification 表 |
| 为什么 session 中看不到 failover 消息 | 插件不写会话事件，见 [docs/session-compatibility.md](docs/session-compatibility.md) |
| 如何查看日志 | Host 日志面板过滤 `llm-failover` |
| 如何关闭插件 | `config.enabled: false` 或 patch 行块加 `disabled: true` |

详见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## Demo

<!-- Add a short GIF/video showing a failed provider being replaced by another provider. -->

## License

[MIT](LICENSE)
