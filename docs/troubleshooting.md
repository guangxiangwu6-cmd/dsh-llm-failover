# Troubleshooting

本文档覆盖 dsh-llm-failover 插件的常见问题排查。

## 插件没有加载

**症状**：启动后日志中没有任何 `llm-failover` 相关内容。

**排查步骤**：
1. 确认插件目录已复制到正确位置：`<DSH安装目录>\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh-llm-failover\lib\index.js`
2. 确认 `cordis.patch.yml` 中的 `id: llm-failover` insert 块格式正确
3. 确认重启了 DeepSeek Harness Desktop（仅关闭窗口不够，需完全退出后重启）
4. 检查启动日志中是否有 cordis 加载错误

## models 没有配置

**症状**：插件加载成功（日志有 `llm-failover active`），但从不切换。

**原因**：`models` 为空时插件保持惰性，仅日志提示，不执行切换。

**解决**：在 `cordis.patch.yml` 的 config 块中填写至少两个 provider/model 条目。

## provider 名称配置错误

**症状**：日志显示切换目标被跳过。

**原因**：`models` 池里写了不存在的 provider 名时，选目标会跳过它（不影响原请求）。

**解决**：确认 provider 名称与 llm-pi-ai settings 里的 profile 名完全一致。

## 模型切换没有发生

**症状**：Provider 出现 429/5xx 错误，但没有切换。

**排查步骤**：
1. 检查 `maxConsecutiveFailures` 是否达到（默认需要连续 5 次失败）
2. 检查对应错误类型的 per-class 开关是否开启
3. 检查 `models` 池中是否有其他健康目标
4. 注意：AUTH/INVALID_REQUEST/UNKNOWN_MODEL/CONTEXT_WINDOW_EXCEEDED/ABORTED 错误**永不切换**（设计行为）

## 为什么 429 会切换

HTTP 429 (RATE_LIMIT) 表示 Provider 限流。切换到另一个 Provider 可能绕过限流，因为限流通常是 per-provider 的。`failoverOnRateLimit` 默认开启。

## 为什么 AUTH 不切换

AUTH / INVALID_CREDENTIAL 表示 API Key 无效。这是凭证问题，切换到另一个 Provider 无法解决（每个 Provider 都有自己的 Key）。设计行为是**永不切换**，让错误冒泡提示用户检查配置。

## 为什么某些错误只 retry

EMPTY_RESPONSE 和 QUOTA 默认只 retry 不切换：
- EMPTY_RESPONSE：退化空补全，可以安全重复，不一定需要切模型
- QUOTA：配额问题，切模型不一定解决（同一 Provider 的不同模型通常共享配额）

可通过 `failoverOnEmptyResponse: true` 和 `failoverOnQuota: true` 开启切换。

## 为什么 session 中看不到 failover 消息

插件**不追加任何会话事件**，决策轨迹只存在于宿主日志。这是设计决策，原因是 DSH 当前未暴露注册自定义会话事件类型的扩展点，写入自定义事件会导致会话重载兼容问题。

查看切换日志：Host 日志面板过滤 `llm-failover`。

详见 [session-compatibility.md](session-compatibility.md)。

## 如何查看日志

在 DeepSeek Harness Desktop 的 Host 日志面板中搜索 `llm-failover`。每次可恢复失败、标记不可用、切换、恢复都有对应的日志行。

## 如何关闭插件

两种方式（效果相同）：
1. `config.enabled: false`（与 config 平级）
2. patch 行块加 `disabled: true`

重启后生效。行为等同未安装本插件。

## 安装后验收清单

安装并重启后按顺序逐项勾选：

- [ ] **重启成功** — DeepSeek Harness Desktop 能正常进入主界面，无报错弹窗
- [ ] **插件激活** — 宿主日志面板出现 `llm-failover active` 行
- [ ] **正常对话一轮** — 发起一次普通对话并收到完整回复
- [ ] **模拟故障观察切换日志** — 临时把 models 池首位改成无效模型名触发失败，日志出现切换记录且会话仍能拿到回复；验证完还原配置
- [ ] **恢复后确认回池说明** — 故障源恢复后（冷却到期或一次成功出活），日志出现该 provider 恢复/回池记录

## 墙（wall）与探针（probe）：0.2.0 的新日志怎么读

```
provider "commandcode" request failed (QUOTA, a wall (quota-code)); consecutive failure 1/5: insufficient credits
provider "commandcode" parked for 4h (quota-code); temporarily switching to "deepseek-official" (deepseek-flash)
```

- 第二行的括号就是**判定来源**：`quota-code`（harness 分类为 QUOTA）、`message-marker`（账号级措辞）、
  `provider-retry-after` / `reset-stamp` / `retry-after-prose`（上游公布的重置时间）。有公布时间时括号里写
  `(the provider's own reset)`，停车时长按上游原样，不做翻倍。
- 第一次失败就切是**设计行为**：配额/用量窗口是事实不是抖动。模糊措辞（单独一句 "quota exceeded"）不会
  被当成墙——只有 ≥60 秒的公布重置时间，或明确指向账号级的措辞才算。

```
provider "bailian" cooldown elapsed; admitting it back as a probe (2 park(s) so far, so the next failure parks it for 2m)
provider "bailian" parked for 2m after a failed probe; temporarily switching to "deepseek-official" (deepseek-flash)
```

- 冷却到期不再等于"恢复"，而是**放一次探针**。探针失败立刻回停车（不用重新攒阈值），下一次冷却翻倍。
- 只有真的出活（`probe succeeded after N park(s); back in the pool with a clean slate`）才清空惩罚。

```
no healthy target left (last failure: "commandcode" QUOTA); failing this request.
  Earliest recovery: "bailian" in 42m (it is admitted as a probe then)
provider states: commandcode=parked(4h, wall), bailian=parked(42m, failures)
```

- 四个 provider 全停时出现这三行。注意：**这些信息进不了客户端看到的错误**（`RequestErrorAction` 只有
  `{ kind: 'retry' } | undefined`，这个 seam 改不了文案），所以排查请以宿主日志为准。
- `autoRecover: false` 时不会自动入场探针，只有重启或一次成功出活能恢复。
