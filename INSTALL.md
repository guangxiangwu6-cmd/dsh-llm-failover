# dsh-llm-failover 安装 / 卸载 / 启停指南

> 本插件无自动安装逻辑：全程两步手工操作，可完全逆反。建议先照文末做安装前彩排。

## 项目位置与文件

| 文件 | 作用 |
|------|------|
| package.json | 插件包描述（名称/入口/依赖声明） |
| lib/index.js | 插件全部运行时逻辑（单文件，无构建步骤） |
| test/failover.test.mjs | 场景测试（node --test；数量以运行输出为准） |
| README.md | 工作原理 / 错误分类 / 全部配置项 |
| patches/cordis.patch.snippet.yml | 未来安装时要追加的配置片段模板 |
| node_modules/ | 仅隔离测试用（schemastery/cosmokit/@standard-schema 副本），安装时不要复制 |

## 安装（两步，不联网、不 npm install）

1. 复制插件目录到 Harness（排除 node_modules）：
   ```powershell
   # <DSH安装目录>：Electron 应用资源目录，Windows 一般在 安装目录\resources\app.asar.unpacked
   $dst = "<DSH安装目录>\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh-llm-failover"
   New-Item -ItemType Directory -Force -Path $dst | Out-Null
   Copy-Item "<本仓库目录>\*" $dst -Recurse -Force -Exclude node_modules
   ```
2. 把 patches/cordis.patch.snippet.yml 的内容追加到你的 DSH home 下的 profiles\desktop\cordis.patch.yml 末尾（DSH home 默认：Windows `%USERPROFILE%\.dsh` / Linux·macOS `~/.dsh`；按需填写 models 池）。
3. 重启 DeepSeek Harness Desktop。启动日志出现 llm-failover 相关 info 行即加载成功。

## 卸载（完全可逆）
   1) 删除 ...node_modules\@deepseek-ai\dsh-llm-failover\ 目录；
   2) 从用户 cordis.patch.yml 中删除 id 为 llm-failover 的 insert 行块；
   3) 重启 DSH。
   安装前先备份 cordis.patch.yml（同目录拷一份 .bak 即可），两步删除即完全回退。

## 启用 / 禁用
- 临时禁用（保留配置）：patch 行块里加一行 disabled: true（与 config 平级），或把 config.enabled 改为 false —— 两者都使插件完全旁路，行为等同未安装。
- 重新启用：还原上述改动并重启。

## 依赖
- 运行时仅依赖 @deepseek-ai/schemastery（及其传递依赖 @deepseek-ai/cosmokit、@standard-schema/spec），三者均已存在于当前 Harness 的 node_modules 中 —— 安装不需要下载任何新包，无版本覆盖、无 lockfile 变更。
- 测试使用 Node.js 内置 test runner（Node >= 18），无第三方测试框架。

## 会修改 Harness 的哪些内容
| 位置 | 改动 | 可逆性 |
|------|------|--------|
| app.asar.unpacked\node_modules\@deepseek-ai\dsh-llm-failover\ | 新增一个独立目录 | 删目录即回退 |
| <DSH home>\profiles\desktop\cordis.patch.yml | 末尾追加一段 insert 块 | 删该块即回退 |
| 其他一切（核心代码/app.asar/现有插件/依赖/settings.yaml/sessions） | 零改动 | — |

## 启动安全设计（rc.3 加固，经真实加载器验证）

本插件按"最坏情况也不能拖垮 Host 启动"设计，并已在隔离的全栈冒烟环境中用真实 `dsh --profile headless` 加载链路验证：

1. **导出 Config 刻意宽松**：cordis 加载器会在激活前用插件导出的 schema 校验配置行，一旦拒绝会传播并导致整个插件树加载失败（实测复现）。因此导出 schema 为空对象模式（与官方 llm-retry 相同），真正的校验在运行时 sanitizeConfig 内完成——配置再错也只是警告+回退默认值。
2. **apply 永不抛错**：激活体整体包裹，内部故障降级为惰性插件并在错误通道留痕。
3. **监听器永不中断请求链**：恢复决策与路由改写内部异常时自动旁路放行（单元测试 Test 15 覆盖）。
4. **实测矩阵**（临时 home + 副本 node_modules，未触碰真实环境）：好配置→探针确认 apply 执行、启动健康到达凭据检查点；坏配置（未知键+错类型）→同样存活，仅内部降级；对照实验证明模块文件语法损坏仍会导致启动失败——这是 cordis 对所有插件的统一行为，无法从插件内部规避，防线是下述安装前彩排 + 备份回退。
5. 无头模式下 ctx.logger 输出不进控制台（激活证明靠探针）；桌面 profile 的宿主日志面板才是正式观察点，安装当天需实际确认 failover 日志可见。

## 安装前冒烟彩排（强烈建议每次执行）

> 注：`scripts/` 下 qa-*.ps1 是作者自用的 QA 彩排脚本，内部硬编码了作者的彩排目录路径；复用思路即可，直接运行前按自己的目录改路径。

彩排环境 = 一套与真实环境完全隔离的副本（node_modules 拷贝 + 临时 DSH_HOME）。任何一次修改插件或配置后、写入真实环境前，先在彩排目录跑一遍：

```powershell
# 同步最新源码到彩排环境
Copy-Item "<本仓库>\lib\index.js" "<彩排目录>\node_modules\@deepseek-ai\dsh-llm-failover\lib\index.js" -Force
# 用与生产相同的 patch 内容彩排（把彩排 home 的 profiles/headless/cordis.patch.yml 改成与未来生产行一致）
$env:DSH_HOME='<彩排目录>\home'
node '<彩排目录>\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile headless 'reply ok'
```

判定：输出以 MISSING_CREDENTIAL 类模型层错误收场 = 插件加载激活成功且未拖垮启动（无头环境无 API 凭据属预期）。若出现 failed to load / invalid config 则绝不可写入真实环境。彩排通过后即可安全安装；彩排目录用后可整体删除。

## 兼容性风险评估
- 低风险设计：不改 agent-loop/llm 核心任何一行；只以最外层监听者身份挂接两个公开 waterfall 扩展点（agent/request-error、agent/request），消费方式与官方 dsh-llm-retry 完全相同。
- 与 llm-retry 共存：阈值以下决策权仍归 llm-retry（行为不变）；达到阈值才由本插件接管并切换。
- 主要残余风险：
  1) 若上游大版本变更 waterfall 载荷字段名（provider/failure/code 等），插件需要同步更新；
  2) models 池里写了不存在的 provider 名时，选目标会跳过它（不影响原请求）；
  3) 极端情况下所有模型连续失败，任务将以清晰的最终错误终止（设计行为，替代无限卡死）。
- 插件自身抛错时由 cordis 以插件为单位隔离，不会拖垮 Host；最坏情况按上文「卸载」两步回退。

## 安装后验收清单

安装并重启后按顺序逐项勾选，全部通过才算安装完成；任何一项不过，先按「卸载（完全可逆）」回退再排查。

- [ ] **重启成功** —— 验证：重启 DeepSeek Harness Desktop 能正常进入主界面，无报错弹窗。
- [ ] **插件激活** —— 验证：桌面 profile 的宿主日志面板出现 `llm-failover active` 行（日志里过滤 llm-failover）。
- [ ] **正常对话一轮** —— 验证：发起一次普通对话并收到完整回复，体验与未装插件时无明显差异。
- [ ] **模拟故障观察切换日志** —— 验证：临时把 models 池首位改成无效模型名触发失败，日志出现切换记录且会话仍能拿到回复；验证完还原配置。
- [ ] **恢复后确认回池说明** —— 验证：故障源恢复后（冷却到期或一次成功出活），日志出现该 provider 恢复/回池记录，路由回到优先级池首位。

