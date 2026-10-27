# dsh-llm-failover

> When your model goes down, your task doesn't.

DeepSeek Harness 的社区模型自动故障切换插件。当 Provider 出现 429 / 5xx / 超时 / 网络错误 / SSE 中断时，自动切换到健康模型继续执行，而不是让整个任务失败。

⚠️ Community plugin for DeepSeek Harness. Not affiliated with or endorsed by DeepSeek.

[![version](https://img.shields.io/badge/version-0.2.0--rc.2-green)](https://github.com/guangxiangwu6-cmd/dsh-llm-failover/releases)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-80%2F80%20passing-brightgreen)](test/failover.test.mjs)
[![boot-safe](https://img.shields.io/badge/boot--safe-rehearsal%20proven-informational)](INSTALL.md)

## What & Why

你在用 DeepSeek Harness 跑任务，突然当前模型挂了——429 限流、5xx 服务端错误、超时、网络断连、SSE 流中断。没有 failover 插件时，整个任务直接失败，你得手动重试。

本插件在 Provider 级别实现自动故障转移：

```
Provider A (DeepSeek V4)
  │
  ├── 5xx / Timeout / Transport / 短促 429 ──► 阈值（默认 5 次，抖动交给 retry 层吸收）
  │                                              │
  │                                              ▼
  │                                        A 停车（60s 起，连续停车翻倍）
  │
  └── 配额用尽 / 用量窗口 / 上游公布长时间重置 ──► 墙：第一次就切
                                                 │
                                                 ▼
                                           A 停车到上游说的重置时间
                                                 │
        ┌────────────────────────────────────────┘
        ▼
Switch to Provider B (next healthy model in priority pool) — 半开的不抢健康 provider
  │
  ▼
Task continues seamlessly — same session, same context
  │
  ▼
Cooldown expires → A 以「探针」身份入场，一次请求定生死
  │
  ├── 出活（assistant message 证明）→ 记录清空、惩罚归零
  └── 又失败 → 立刻回停车（不用重攒阈值），冷却翻倍（封顶 maxCooldownSeconds）
```

「墙」不靠猜：上游公布的重置时间（`providerRetryAfterMs`、正文里的 `resets at <ISO>`、"retry again in N 单位"）**原样采用**；账号级措辞（"usage limit for your plan"、"insufficient credits"…）按无公布时间的墙处理；模糊说法（单独一句 "quota exceeded"）不算墙。判定表与取舍见 [docs/architecture.md](docs/architecture.md)。

## Features

- **自动 Retry + Failover** — 基于 agent loop 的两个公开 waterfall 扩展点，零修改核心循环
- **墙与抖动分开** — 配额/用量窗口这类"确定要等到重置"的失败第一次就切，并按上游公布的时间停车（上界 30 天）；5xx、超时、传输、流中断、短促 429 仍走阈值
- **half-open 探针** — 冷却到期不直接放行，而是放一次探针请求：成功才恢复，失败立刻回停车且冷却翻倍（封顶）；上游公布的时间永远原样使用（信息不打折，只惩罚递增）
- **Provider 健康管理** — 按 provider 粒度跟踪连续失败次数、停车原因与累计停车次数
- **优先级池切换** — `models` 数组顺序即优先级；半开状态的 provider 不抢占健康 provider
- **双通道恢复** — 冷却到期惰性入场探针 + assistant message 主动证明恢复（停车期内只要改道过，此后归属该 provider 的"成功"一律拒收：歧义覆盖**整段停车期**，不只是切过去那一分钟，避免冷却被自己发起的切换绕过）
- **最大切换保护** — 单回合切换上限防止死循环
- **错误分类** — 7 种可恢复错误 + 多种永久错误，精确决定是否切换；每类一个开关
- **终止时说得清** — 所有 provider 都停车时，日志给出最早恢复的是谁、还有多久，并附全 provider 状态快照
- **两套本地测试** — `node --test test/failover.test.mjs`（34 项，node:test 风格）+ `node test/smoke.test.mjs`（46 项，纯离线、不需要 harness）
- **敏感信息日志脱敏** — URL 凭据 / Bearer token / key 参数自动掩码
- **Session 安全设计** — 不写自定义事件类型，避免会话重载兼容问题
- **与 llm-retry 共存** — 阈值以下决策权归 llm-retry，达到阈值才由本插件接管；下游任何决定都原样尊重

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

> **更省事的部署方式（推荐）**：不要拷进 harness 本体（升级会覆盖），而是放在 harness 之外的覆盖目录里，用 profile 的 `link:` 依赖指过去；改了代码用 `node tools/sync-to-dsh.mjs --dest <覆盖目录>` 同步（先备份再覆盖）。见 [INSTALL.md](INSTALL.md)。

## Quick Configuration

健康的时候插件不碰路由：请求仍然打在宿主自己选定的 provider 上。`models` 只决定**故障时**的备份选择顺序——当前 provider 不可用了，就取池里第一个健康的条目顶上。

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
        maxConsecutiveFailures: 5      # 「抖动」类失败：同一 provider 连续失败多少次后切换
        cooldownSeconds: 60            # 抖动类的停车时长（必须 > 0）
        quotaCooldownSeconds: 14400    # 「墙」类（配额/用量窗口，且上游没给重置时间）的停车时长
        maxCooldownSeconds: 86400      # 本地惩罚性退避的翻倍上限（上游公布的重置不受它截断）
        autoRecover: true              # 冷却到期是否自动入场探针
        maxSwitchesPerTurn: 8          # 单回合最大切换次数
```

未配置键取默认值；未知键不会导致报错，只记录警告后忽略。`models` 为空时插件保持惰性。

### 多账号：一个账号一个 provider profile

健康状态按 **provider 粒度**管理：同一 provider 下的多个模型、同一把 key 的多个账号，共享一套失败计数和停车状态。

- 因此**同 provider 多账号不是独立故障域**——账号 A 的配额用尽时，同一个 profile 下的账号 B 一起停。
- 想让两个账号轮流上，就把每个账号各配成一个独立的 llm-pi-ai profile，再把它们当成两个 provider 放进池里：

```yaml
        models:
          - provider: deepseek-official        # 账号 A（profile 1）
            model: deepseek-v4-flash
          - provider: deepseek-official-b      # 账号 B（profile 2，另一把 key）
            model: deepseek-v4-flash
```

当前版本**没有**宿主贯通的 `accountKey/routeKey`，所以做不到"同一个 profile 内多账号轮换"；上面这种 profile-per-account 是唯一能吃到 provider 级隔离的写法。

### Per-class failover switches

| Switch | Default | Controls |
|--------|---------|----------|
| failoverOnRateLimit | ✅ true | HTTP 429 |
| failoverOnTimeout | ✅ true | 请求/连接/空闲超时 |
| failoverOnServerError | ✅ true | HTTP 5xx |
| failoverOnTransportError | ✅ true | 网络/代理链路异常 |
| failoverOnStreamInterrupted | ✅ true | SSE 流中断 |
| failoverOnEmptyResponse | ❌ false | 退化空补全 |
| failoverOnQuota | ✅ true | 配额/余额/用量窗口（第一次就切，停到上游说的重置时间） |

## Error Classification

| Error | Default Behavior | Why |
|-------|-----------------|-----|
| RATE_LIMIT (429) | Failover（抖动走阈值；点明重置时间/账号级措辞的按墙立即切） | 限流可能是瞬时，也可能是计量窗口，用措辞区分 |
| SERVER (5xx) | Failover | 服务端瞬时故障 |
| TIMEOUT | Failover | 请求/连接超时 |
| TRANSPORT | Failover | DNS、连接重置/拒绝、代理异常 |
| STREAM_CLOSED | Failover | SSE 流中途中断 |
| EMPTY_RESPONSE | Retry only | 可安全重复，不一定需要切模型 |
| QUOTA | **Failover（墙：第一次就切，停到重置）** | 配额是事实不是抖动；同 provider 重试必然再失败 |
| AUTH / INVALID_CREDENTIAL | Never failover | 凭证问题，切换无用 |
| INVALID_REQUEST / UNKNOWN_MODEL | Never failover | 请求本身有误 |
| CONTEXT_WINDOW_EXCEEDED | Never failover | 交给 compaction 处理 |
| ABORTED | Never failover | 用户主动取消 |

## Architecture

```
agent/request-error (请求失败恢复点) —— 本插件是最外层
  │
  ├── 永久错误 → 永不切换，让错误冒泡
  │
  ├── 「墙」（配额/用量窗口/长时间重置）→ 第一次就切：停车到重置时间
  │
  └── 「抖动」→ 计数
      ├── 未达阈值 → 交给下游栈（通常是 llm-retry），任何下游决定都原样尊重
      └── 达到阈值 → 停车（冷却翻倍，封顶）→ 切换到下一个健康目标

agent/request (每次构建请求时)
  │
  └── 目标 provider 处于停车期 → 自动改写到最优健康条目
      （健康 > 半开：半开的不抢占健康的）
      └── 改写时丢弃继承的 reasoningEffort（属于失败路由的每模型设置）

session/event (assistant/message)
  └── 出活 = 证明恢复：清空该 provider 的记录与惩罚
      （冷却期内、且刚被改道过的"成功"判为歧义并拒收 —— 否则冷却会被自己发起的切换绕过）
```

恢复是双通道的：冷却到期后以**探针**身份惰性入场（一次请求定生死）；任何 assistant
消息证明某 provider 成功出活时立即恢复。冷却中的 provider 不会被当作切换目标，除非所有
provider 都在停车；那时日志会给出最早恢复的那个是谁、还有多久。

详见 [docs/architecture.md](docs/architecture.md)（状态机、判定表、与 retry 层的分工）。

## Project Status

> **Release Candidate** — 版本 0.2.0-rc.2

- ✅ 核心 failover 功能已实现并通过两套本地回归测试（`node --test test/failover.test.mjs` 34 项 + `node test/smoke.test.mjs` 46 项，合计 80 项，都不需要 harness 在场）
- ✅ 启动安全设计经真实加载器验证（见 [INSTALL.md](INSTALL.md) 的安装前冒烟彩排）
- ✅ 已安装进真实 DSH Desktop 环境（2026-08-27）
- ✅ 冷却保护（2026-09-21）：切换后返回的"成功"证据若与插件自己发起的改道冲突，会被判为歧义并拒收，避免冷却被提前取消
- ✅ **墙/抖动分开 + half-open 探针（2026-09-25）**：配额与用量窗口第一次就切并按上游公布的重置时间停车；冷却到期改为放一次探针，探针失败立刻回停车且冷却翻倍封顶；终止日志给出最早恢复时间与全 provider 状态。判定表与取舍见 [docs/architecture.md](docs/architecture.md)，借鉴来源见下
- ✅ **rc.2 状态机修复（2026-10-27）**：已停车 provider 的迟到失败不再重复停车、不再延长冷却；歧义成功的拒收覆盖整段停车期（4h 墙与无限停车都绕不过去）；同代 half-open 探针的迟到失败按探针失败处理，而不是从 1/5 重新计数；一次失败里的多个重置信号取**最晚**；上游公布的重置不再被 `maxCooldownSeconds` 截断；自回退等待尊重 Retry-After；长回合的切换预算不再被 TTL 清扫掉；`autoRecover: false` 的无限停车在终止日志里如实写 `parked(indefinitely …)`
- ✅ QA 彩排脚本 6 个（smoke / badconfig / disabled / doc-crosscheck / s0-session-compat / final-round）
- 🔄 当前生产配置：3 个目标 —— bailian/qwen3.8-flash、commandcode/deepseek/deepseek-v4.1-flash、deepseek-official/deepseek-flash（付费的 deepseek-official 排最后，只在其它目标都不可用时才切过去）

### Intentionally descoped

- **会话内可见切换提示** — DSH 当前未暴露注册自定义会话事件类型的扩展点，插件侧不存在受支持的实现通道。详见 [docs/session-compatibility.md](docs/session-compatibility.md)。
- **自动推导备份模型** — 切换目标必须显式列在 `models` 里，不会从适配器目录自动推导。
- **旁路调用保护** — 直接消费 `ctx.llm.stream()` 的调用（标题生成、compaction 摘要）不在保护范围内。
- **终止错误的文案改写** — `RequestErrorAction` 只有 `{ kind: 'retry' } | undefined`，改不了客户端看到的错误；有用的信息（最早恢复时间、各 provider 状态）写进宿主日志。
- **探针并发上限** — 本插件观察失败而不是代理调用，做不到 opossum 那种"半开只放一个并发探针"；靠"探针失败立刻回停车 + 冷却递增"限制影响面。
- **健康状态持久化** — 重启后从头开始（乐观），第一次失败重新学习。

### 未来可能的扩展

- 若 DSH 提供事件词汇注册面或 `ignorable` 公开写入口，可重新评估恢复会话事件记录
- 若 `RequestErrorAction` 扩展出携带文案/原因的形状，把"最早何时恢复"放进用户可见的错误里

## Prior art（借鉴来源）

这个插件的关键设计是**照着现成实现改的**，不重复造轮子；下面逐条记清借了什么、为什么不能直接当依赖。

| 来源 | 借了什么 | 为什么不能直接用 |
| --- | --- | --- |
| [LiteLLM Router](https://github.com/BerriAI/litellm/blob/main/litellm/router.py) | 429 类失败**立刻**进冷却而非等阈值；`retry-after` 作为最短等待；每类错误各自的失败阈值（`allowed_fails_policy`）；所有部署都在冷却时把"最早恢复时间"说清楚；**fallback 路径上的失败也要触发冷却**（他们 issue #31876）；以及"重试会相乘"的教训（他们把 provider SDK 自己的重试钉成 0） | 语言与形态不同（Python 服务 vs 宿主内插件）；安装路径是文件拷贝、不能 `npm install`，所以只借设计 |
| [opossum](https://github.com/nodeshift/opossum) | **half-open** 语义：冷却到期先放探针，成功才恢复、失败立刻回打开；冷却递增 + 上限 | 插件不能引三方依赖（宿主 `node_modules` 由 harness 拥有）；且它代理调用、我们只观察失败，探针并发上限做不到 |
| [@mars-sea/dsh-commandcode-provider](https://github.com/Mars-Sea/dsh-commandcode-provider) | "点名了用量窗口才算窗口用尽"（issue #54）、"两个窗口都读、解禁取最晚"（issue #51 后续）、账号级措辞的标记列表、`resets at <ISO>` 记法 | 它管同一 provider 的多个账号（换密钥），本插件管多 provider 之间的切换（换路由），层次不同 |
| `dsh-llm-retry`（宿主自带） | 分工与字段：它消费 `failure.providerRetryAfterMs` 做同 provider 退避，本插件把它作为**唯一的结构化重置信号**；阈值以下决策权交给它 | 它不切 provider，本插件不抢它的活 |
| `dsh-llm` 的 `isQuotaExceededError`（宿主自带分类器） | 措辞 → `QUOTA` 的映射：本插件主路径直接吃这个 code，措辞列表只做兜底 | 宿主内部实现，插件只读 `failure.code` |

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
| provider 名称配置错误 | 插件**不校验** provider 是否存在：写错的名字会被当作切换目标用，请求随后以该 provider 的解析/鉴权错误结束。逐字对照 llm-pi-ai settings 里的 profile 名 |
| 模型切换没有发生 | 检查 `maxConsecutiveFailures` 是否达到；检查 per-class 开关 |
| 为什么 AUTH 不切换 | 凭证问题切换无用，设计行为 |
| 为什么某些错误只 retry | 参考 Error Classification 表 |
| 为什么这次 429 立刻切了 | 那是「墙」：上游公布了 ≥60s 的重置时间，或正文带账号级措辞（如 `usage limit for your plan`）。日志里会写明来源（`quota-code` / `message-marker` / `provider-retry-after` / `reset-stamp` / `retry-after-prose`） |
| 刚切过去又被切回来 / provider 一直反复失败 | half-open 探针在工作：每次失败会翻倍延长停车（封顶 `maxCooldownSeconds`）。日志里找 `parked ... after a failed probe` |
| 所有 provider 都停了，怎么办 | 日志的 `no healthy target left` 会给出 `Earliest recovery: "X" in …`；等它，或往 `models` 里加一个 provider，或解决那个配额用尽的账号 |
| 为什么 session 中看不到 failover 消息 | 插件不写会话事件，见 [docs/session-compatibility.md](docs/session-compatibility.md) |
| 如何查看日志 | Host 日志面板过滤 `llm-failover` |
| 如何关闭插件 | `config.enabled: false` 或 patch 行块加 `disabled: true` |

详见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## Demo

<!-- Add a short GIF/video showing a failed provider being replaced by another provider. -->

## License

[MIT](LICENSE)
