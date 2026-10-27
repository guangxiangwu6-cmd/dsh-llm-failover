# dsh-llm-failover v0.2.0-rc.2 Implementation Plan

> **状态：已执行完毕（2026-10-27，v0.2.0-rc.2）。** 本文保留为当时的工单快照：Task 1–7 全部落地，`node --test test/failover.test.mjs` 34/34、`node test/smoke.test.mjs` 46/46。文中「22 项 / 68 项 / rc.1」是**写入时**的基线，不再是当前数字；`docs/superpowers/` 于同日提交进仓库。

> **For agentic workers:** 使用 `test-driven-development` 技能，按本文复选框逐项执行。先让新增回归测试在当前代码上失败，再做最小修复；不要一次性重写整个文件。

## 可复制给执行 agent 的交接提示词

```text
你是 dsh-llm-failover 的执行 agent。仓库位于 C:/Users/35100/OneDrive/桌面/PROJECT/dsh-llm-failover，基线为 main@da5980395006fdd18584efbdc8612df289a350f0。先完整阅读 docs/superpowers/plans/2026-10-27-failover-rc2-handoff.md，并严格按其中的顺序和验收判据执行。

本工单允许你修改文档列出的代码、测试和 README/docs 文件；不要提交、推送、创建 issue、修改远端或顺手重构。每项修复都先补能在旧代码上稳定失败的回归测试，再做最小实现，最后运行相关测试。范围是 v0.2.0-rc.2 的状态机正确性、退避和文档纠偏，不实现真正的同 provider 多账号 routeKey 重构，也不新增主动健康检查或状态持久化。

开始时先运行 node --test test/failover.test.mjs 和 node test/smoke.test.mjs，确认 22/22、46/46 基线；随后逐项完成 P1，再完成 P2 和文档任务。交付时必须列出修改文件、每项缺陷的测试结果、最终完整测试结果、git diff --check 与 git status，并明确任何未完成项。若实际 Harness seam 无法支持某个设计，不要伪造通过：保留失败测试证据，说明阻塞并停止该项。
```

---

**Goal:** 修复已复现的停车、冷却恢复、half-open 和退避缺陷，使下一版行为与 README 一致，并明确多账号号池的真实边界。

**Architecture:** 保留当前 Cordis waterfall 插件结构和 provider 级健康模型，不重写核心循环。通过小型状态记录、明确的状态迁移和有界回归测试修正现有实现；同 provider 多账号所需的 `accountKey/routeKey` 不在本工单内。

**Tech Stack:** Node.js >=18、原生 ESM、`node:test`、离线 smoke 测试、DeepSeek Harness Cordis 插件扩展点。

## 1. 已测基线与约束

- 本地与 GitHub `main` 均为 `da5980395006fdd18584efbdc8612df289a350f0`，release 为 `v0.2.0-rc.1`。
- GitHub 侧撰写时未观察到开放或已关闭 issue，也没有 PR（此条为撰写时快照，执行时不必复核）；无论如何不要创建任何远端对象。
- 2026-10-27 实测：`node --test test/failover.test.mjs` 为 22/22，`node test/smoke.test.mjs` 为 46/46。
- 当前测试是 listener/mock 测试，不是 Harness 端到端证据；不得把“68 项通过”写成“真实多账号/SSE 已验收”。
- 工作区开始时干净。只允许本工单列出的文件发生变化。

### 不可破坏的现有行为

1. `apply` 和监听器内部故障必须安全降级，不能拖垮 Host 启动或请求链。
2. 阈值以下继续尊重下游 `llm-retry` 的任何决策，下游最多调用一次。
3. AUTH、INVALID_REQUEST、UNKNOWN_MODEL、CONTEXT_WINDOW_EXCEEDED、ABORTED 等永久错误仍不 failover。
4. 不写自定义 session event，不记录明文凭据。
5. 不新增运行时依赖，不改变插件安装方式。

### 明确不做

- 不实现同 provider 内真正的多账号轮换；这需要宿主贯通 `accountKey/routeKey`。
- 不把 AUTH 全局改成可切换。
- 不新增定时主动健康探测、探针并发上限、健康状态持久化。
- 不提交、不推送、不打 tag、不改 release、不创建 issue。

## 2. 文件地图

| 文件 | 本工单职责 |
|---|---|
| `lib/index.js` | 最小修复状态迁移、重置信号、退避、预算和健康日志 |
| `test/failover.test.mjs` | 为主要缺陷添加确定性 node:test 回归 |
| `test/smoke.test.mjs` | 只补充能提升离线覆盖且不重复堆砌的断言 |
| `README.md` | 修正池优先级表述，说明 provider-profile 多账号边界 |
| `docs/architecture.md` | 同步 parked、half-open、重置和账号故障域语义 |
| `docs/troubleshooting.md` | 修正 QUOTA、无效 provider 和无效验收方法 |
| `INSTALL.md` | 修正测试数量、无效模型验收和 provider 跳过说法 |

不要修改 `patches/`、`tools/`、`scripts/`，除非完整测试明确证明本工单导致其失效；若确实需要，先在交付报告中说明原因。

## 3. 执行顺序

### Task 1 — 已 parked 的迟到失败不得重复停车

**位置：** `lib/index.js:571-580`、`lib/index.js:609-628`。

- [ ] 在 `test/failover.test.mjs` 添加“parked provider late failures do not extend cooldown”测试：第一次 QUOTA 停 A 4h；在原期限内再次报告 A 的 QUOTA/SERVER；断言没有变成 8h、没有重新计算恢复期限。
- [ ] 再覆盖无健康目标的情形：已 parked 的 A 再次失败应 stand down，不得靠反复停车推迟恢复。
- [ ] 运行 `node --test test/failover.test.mjs`，确认新增测试在旧实现上失败，并保存失败摘要。
- [ ] 在 `decideRecovery` 的普通失败计数之前识别“`unavailableUntil` 仍在未来且非 half-open”的状态。该分支不得调用 `markUnavailable`，可选择健康目标或直接 stand down。
- [ ] 保留 half-open 失败立即回停车和正常首次达到阈值停车的原路径。
- [ ] 重跑测试，确认新测试及原 22 项全部通过。

**验收：** 重复失败不改变首次停车期限、不增加 `parks`；原期限到达后仍能进入 half-open。

### Task 2 — 改道歧义保护覆盖整个实际停车期

**位置：** `lib/index.js:345-346`、`lib/index.js:463-497`。

- [ ] 添加 4h quota wall 回归：A 停车并改道 B，假时钟前进 61s 和 1h，分别注入仍归属 A 的 assistant message；两次都不得清除 A 的停车状态。
- [ ] 添加 `autoRecover=false` 对照：改道后超过 60s 的歧义成功不得解除无限停车。
- [ ] 保留“从未改道、来源可信的成功可以恢复”的现有对照测试。
- [ ] 先运行并确认新测试在旧代码上失败。
- [ ] 最简实现优先把“本次停车期间发生过改道”作为 provider 健康状态的一部分，由 `noteReroute` 设置；`noteSuccess` 在仍 parked 时看到该标记就拒收。成功恢复后随账本清除，新停车周期重新建立。
- [ ] 删除被替代的 `reroutedAt` 时间窗逻辑，避免留下两套互相矛盾的真相来源。
- [ ] 重跑两套测试。

**验收：** 4h 墙和无限停车都不能被基础 60s 窗口之后的歧义成功绕过；half-open 后的真实探针成功仍能清空账本。

### Task 3 — 同代 half-open 探针成功后，迟到失败仍按探针失败处理

**位置：** `lib/index.js:391-405`、`lib/index.js:473-495`、`lib/index.js:571-597`。

- [ ] 添加确定性回归：阈值 5，A 停车并进入 half-open；放行两个同代探针；第一个成功清空账本，第二个随后失败。
- [ ] 断言第二个失败立即恢复原停车/升级冷却并改道，而不是从 `1/5` 重新计数、下一路由继续留在 A。
- [ ] 先确认该测试在旧实现上失败。
- [ ] 用最小的 generation/attempt 记录关联“ half-open 放行、成功、失败 ”。允许当前 seam 的并发探针，但必须正确处理同代迟到结果；不要借本任务实现单探针并发上限。
- [ ] 成功清理健康账本时，不得同时丢掉仍需判定迟到失败的探针代际证据；记录必须有界，并在同代结果结清或新代替换时清理。
- [ ] 增加“成功后再发起全新的普通请求失败”对照，确保旧代记录不会污染新健康周期。
- [ ] 重跑两套测试。

**验收：** 同代“先成功、后失败”立即按 probe failed 处理；后续新周期从干净状态开始。

**阻塞判据：** 若现有 payload/event 完全没有可关联的尝试身份，且无法以有界 provider 级代际记录正确判定，不得用猜测性的全局 Map 冒充完成。保留复现测试和 seam 证据，在报告中停止该项。

### Task 4 — 统一重置信号，分离上游等待与本地惩罚上限

**位置：** `lib/index.js:106-129`、`lib/index.js:417-426`、`lib/index.js:609-610`。

- [ ] 添加组合信号测试：短 `providerRetryAfterMs` 与正文长 `resets at <ISO>` 同时出现，必须采用最晚的可信恢复时间，不能被第一个短信号遮蔽。
- [ ] 添加上限测试：上游重置 5h、`maxCooldownSeconds=60`，61s 时仍 parked，5h 后才 half-open。
- [ ] 添加短重置日志测试：1.5s Retry-After 达阈值后实际使用普通 60s 冷却，日志不得写 `the provider's own reset`。
- [ ] 先运行并确认这些测试在旧实现上失败。
- [ ] 在 `resolveResetPlan` 分别解析、验证 published/stamped/prose 信号，选择最晚可信值并保留对应 source；保留现有 30 天可信上界和 60s 墙/抖动分界。
- [ ] `markUnavailable` 对已验证的上游 `parkMs` 不再套用 `maxCooldownSeconds`；该上限只约束内部惩罚性退避。
- [ ] `parkedFor` 仅在 `plan.wall && plan.parkMs !== undefined` 时标记为上游重置。
- [ ] 重跑两套测试。

**验收：** 文档中的“原样采用”与行为一致；多个时间窗口不会导致提前恢复；短重置日志不再误导。

### Task 5 — 自回退尊重上游 Retry-After

**位置：** `lib/index.js:585-597`。

- [ ] 添加 sleep spy 测试：阈值以下、下游返回 undefined、`providerRetryAfterMs=30000`，断言自回退等待至少 30000ms。
- [ ] 添加无上游等待对照，保持现有 250ms 起步、2s 封顶的指数退避。
- [ ] 先确认 30s 用例在旧实现上只记录 250ms。
- [ ] 将自回退等待改为本指数退避与 `plan.parkMs ?? 0` 的较大值；不改变下游已认领决策的透传路径。
- [ ] 重跑两套测试。

### Task 6 — 修复长回合预算和手动停车日志

**位置：** `lib/index.js:527-544`、`lib/index.js:430-452`。

- [ ] 添加假时钟测试：`maxSwitchesPerTurn=2`，同一 agent/turn 跨 1h 后仍不得发生第三次切换。
- [ ] 调整 TTL 清扫，当前 `agentId+turn` 的匹配记录不得被当作陈旧条目删除；TTL 只清理其他陈旧 agent。
- [ ] 添加 `autoRecover=false` 且所有 provider 无限停车的终止测试，日志必须列出 manual/indefinite parked，不得输出 `every configured provider is healthy`。
- [ ] 为 `Number.POSITIVE_INFINITY` 增加明确健康描述分支；不改变有限冷却的最早恢复计算。
- [ ] 重跑两套测试。

### Task 7 — 文档纠偏与多账号边界

- [ ] `README.md:90`：把“池首是主模型”改为“健康请求保持当前路由；models 决定故障时的备份选择顺序”。
- [ ] `README.md` 快速配置附近明确：同 provider 多模型/多账号不是独立故障域；一个账号一个独立 provider profile 才能利用当前 provider 级隔离。
- [ ] 增加 profile-per-account 的 A1/A2 配置示例，只描述当前架构可支持的路径，不宣称已实现同 provider 账号轮换。
- [ ] 删除或改写 `README.md:224`、`docs/troubleshooting.md:23-29`、`INSTALL.md:86-89` 的“不存在 provider 会自动跳过”；当前代码只检查失败和停车状态。
- [ ] 修正 `docs/troubleshooting.md:50-54` 的 QUOTA 旧默认（第 50 行“QUOTA 默认只 retry 不切换”到第 54 行“可通过 failoverOnQuota 开启”）：当前 `failoverOnQuota=true`，墙首次失败即切换。
- [ ] 替换 `INSTALL.md:99`、`docs/troubleshooting.md:84` 的“用无效模型触发切换”：UNKNOWN_MODEL 不 failover，改用可控 mock 429/5xx 或既有故障注入方法。
- [ ] 修正 `INSTALL.md:17` 的 19 项旧数量；优先写成不绑定数量的两条测试命令，避免再次漂移。
- [ ] 同步 `docs/architecture.md` 中本工单实际改变的状态语义；不要提前描述未实现的 routeKey。

### Task 8 — 最终验收与交付

- [ ] 运行 `node --test test/failover.test.mjs`。
- [ ] 运行 `node test/smoke.test.mjs`。
- [ ] 运行 `git diff --check`。
- [ ] 运行 `git status --short --branch` 和 `git diff --stat`，确认只有本工单文件变化。
- [ ] 检查没有提交、tag、issue 或远端写入。
- [ ] 交付报告列出：每项缺陷的根因与最小修复、修改文件、红绿测试证据、最终实测通过数、文档修正、未完成的 Harness E2E 范围。
- [ ] 若任何一项未完成，明确写“未完成”，不得以现有 68 项通过代替新增回归的验收。

## 4. 完成定义

只有同时满足以下条件才可称为本工单完成：

1. Task 1–6 的新增回归均先在旧代码上复现失败，再在修复后通过。
2. 原有两套测试保持全部通过，新增测试也全部通过。
3. 重复 parked 失败不延长冷却；长冷却不被歧义成功绕过；同代 half-open 迟到失败立即回停车。
4. 上游重置、Retry-After、长回合预算和手动停车日志符合上述判据。
5. 文档不再宣称不存在的 provider 跳过、QUOTA 旧默认或同 provider 多账号能力。
6. `git diff --check` 通过，工作区只含本工单修改，且没有提交或远端写入。
