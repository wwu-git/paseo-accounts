# Cursor CLI 多账户管理接入可行性调研

- 日期：2026-11-13
- 项目：[Paseo Accounts（wwu-git/paseo-accounts）](https://github.com/wwu-git/paseo-accounts)
- 代码基线：`b7e043fdb7c92087c70727a1d7b0155e0b6d6ac3`
- 范围：Paseo 内启动的 Cursor CLI 会话，不涉及 Cursor IDE 或普通终端启动包装命令。
- 状态：调研与实现建议，尚未实现或批准；未进行真实账户集成测试。

## 结论与范围

基础接入采用 **Cursor 用户 API Key + 现有账户适配器 + Paseo Cursor/ACP provider**。账户管理与切换有现成框架可复用；用量查询另需验证对应账户的查询凭据，不能假定 API Key 与登录 access token 通用。账户可用性及计费方式仍需实测。

复用现有功能与设置；依赖 Cursor 行为的能力先验证，缺少接口依据的能力暂缓。仅做必要局部适配，不新增通用迁移、错误分类、凭据服务或能力注册框架。

| 功能 | 接入边界 |
| --- | --- |
| 添加、命名、删除账户 | 复用 OpenCode 密钥输入、RPC 和原子写入；区分保存成功与认证有效。 |
| 默认账户、单会话选择、Follow default、优先级、文件夹绑定、启用/禁用 | 复用现有路由；默认变更、禁用和删除后的会话协调遵守下述便携性规则。 |
| CLI 原有登录 | 用官方状态命令只读检测，按现有 main 账户语义处理；只解析已验证字段，无法识别时显示说明。 |
| 手动、批量及自动切换 | 纳入适配，具体路径见下文；沿用“移动打开会话”、忙碌会话与跳过原因规则。 |
| 跨供应商继续、时间线和通知 | 沿用现有可选开关、权限档位匹配及渠道，不改变默认开关和其他供应商顺序。 |
| 用量百分比、余额、重置时间 | 条件支持：参考 Paseo 用量源，验证查询凭据、账户归属和套餐字段；不承诺所有账户都返回完整数据。 |
| 用量排序、趋势与耗尽预测 | 可复用 `routing.ts`、`history.ts`；可靠用量用于排序，连续样本用于预测。数据不足时显示未知，沿用优先级与默认账户兜底。 |
| 已有会话提前切换 | 条件支持：可靠用量、额度池语义及跨账户恢复均验证后，复用 `switchEarly`；未知用量或 `portable=false` 时不启用。 |
| 套餐名称、付费额外用量展示 | 待验证字段及含义；与套餐额度分开，不从余额推断套餐或额外消费。 |
| 主动重置额度、修改付费额外用量设置 | 暂缓，未找到可复用接口依据；本地“标记可用”不等于服务端额度重置，团队 Admin API 不作为必选依赖。 |
| 多账户浏览器登录 | 条件支持：可参考 Linux 独立 `XDG_CONFIG_HOME`，验证登录、刷新、退出隔离；复用 `agent login` 与 `NO_OPEN_BROWSER=1`，不以修改 `HOME` 或共享整套配置替代验证。 |

## 用量依据与优先验证项

Paseo 用登录 access token 调用 `DashboardService/GetCurrentPeriodUsage`（`api2.cursor.sh`），将 `totalPercentUsed`、`autoPercentUsed`、`apiPercentUsed` 映射为 Total、Cursor、Third Party；无百分比时回退到金额余额。应保留接口报告的百分比，不能用含赠送额度的花费除以套餐金额重算。

这是开源实现依据，尚未找到公开稳定的个人查询 API 契约。优先验证：

1. **API Key 查询**：Paseo 会话用量发现明确跳过 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`。验证 Key 能否查询；若不能，须使用与目标账户匹配的登录凭据，缺失时显示未知，禁止回退到全局其他账户数据。
2. **Linux 双登录隔离**：参考会话 `XDG_CONFIG_HOME/cursor/auth.json`，验证两账户并行、刷新、退出及查询归属。通过后再开放浏览器多账户路线，不阻塞基础 API Key 接入。
3. **同账户与跨账户恢复**：分别验证，决定下节的会话路径及提前切换能力。

用量接入还需核对额度池与模型的关系、字段缺失、数据时效和重置周期。Paseo 当前使用 `billingCycleEnd`；官方资料区分旧套餐月度额度与新订阅周度额度，不能将账期结束一律当作额度重置时间。

现有 `UsageSchema` 缺少普通套餐余额，`extra` 专指付费额外用量，`usageReport` 在无百分比窗口时直接报错。须局部扩展模型及展示以支持仅金额响应，不将套餐余额塞入 `extra`，也不为驱动排序强行换算百分比。

明确用量有效期并按采样时间判断；查询失败、查询凭据失效或超过有效期时，旧值仅作带失效说明的展示，排序退回未知用量规则，不触发提前切换或生成新的耗尽预测。现有 `mergeUsage` 会保留旧窗口，`switchEarly` 未检查错误或时效，接入时须补齐判断，不能只复用百分比读取。

## 会话与自动切换

官方提供 `--resume` 和 ACP `session/load`，但未确认跨账户恢复保证。`portable` 是适配器级开关，按验证结果选择路径，不新增逐次失败后的动态回退机制：

- **跨账户恢复实测通过**：设置 `portable = true`，变更账户环境后重开原会话；忙碌会话在回合结束后处理。
- **未验证或不支持跨账户恢复**：采用非便携路径，已有历史会话保留原账户绑定；手动切换通过 `continueInNewAgent` 新建会话并交接历史，批量和默认值联动遵守现有非便携规则。
- **同账户恢复**也需独立验证；新建会话不算恢复成功。

泛化非便携路径中写死的 ChatGPT/Codex 提示及历史来源标签。交接会向目标账户或供应商发送对话，沿用现有操作说明与隐私边界。

自动切换沿用 OpenCode、Pi 等无用量展示适配的模式，接入 `autoSwitch`、`autoContinue`、选账户和频次保护：

- 只响应已验证的额度耗尽或认证失效信号；区分短期限流、网络故障及未知错误。优先结构化错误，文本规则须有脱敏真实样本。
- 重置时间未知时，复用或局部适配不可用标记与“标记可用”操作，避免立即选回耗尽账户；不虚构重置时间或新增定时探测。
- 继续操作遵守现有设置，只在目标会话成功启动后发送消息。

## 改动位置

| 位置 | 改动 |
| --- | --- |
| `shared/model.ts`、`server/families.ts` | 增加 `cursor`、名称、认证覆盖识别和穷举映射，按现有顺序加入回退目标；局部扩展普通套餐余额模型，与 `extra` 分开。 |
| `server/adapter.ts`、新增 `server/cursor.ts` | 实现认证、密钥保存、环境注入、条件用量查询与未知状态、错误识别。 |
| `server/usage.ts`、`server/usage-source.ts`、`server/history.ts`、`server/routing.ts` | 支持仅金额展示；将保留展示的旧值与可用于排序、预测的数据区分，复用现有算法并补齐有效性判断。 |
| `server/opencode.ts`、`server/json-file.ts` | 复用密钥登录和 `writeJsonAtomic`，补齐遮蔽输入与防回显。 |
| `server/binaries.ts`、`index.server.ts` | 注册适配器并解析命令、前缀参数；区分 provider ID `cursor` 与通常名为 `agent` 的可执行文件。 |
| `server/service.ts`、`server/handoff.ts` 与账户界面 | 接入现有路由、切换及交接，提前切换前检查用量有效性，泛化供应商文案并显示失效状态。 |

先确认目标 Paseo 的 Cursor provider 或自定义 ACP 配置可运行 `agent acp`。已有入口可用时只补配置；验收发现必须修改 Paseo 核心的兼容性缺口时，单独报告并确定范围。

## 凭据与端点

- 管理的密钥及登录凭据保存在插件账户目录，目录 `0700`、文件 `0600`，原子写入；删除本地账户不等于服务端撤销。输入遮蔽，秘密值不进入账户状态、日志、通知、错误文本或命令行参数；仅供对应 CLI 进程及经核验的官方查询接口使用。
- 注入前检查 **daemon 继承环境、provider 环境、完整启动命令参数**，覆盖 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、`--api-key`、`--auth-token`，以及端点 `CURSOR_API_ENDPOINT`、`--endpoint`、`-e` 和目标 CLI 支持的参数形式；验证与本地登录的优先级。
- 当前 `bringsOwnAuth` 只检查 provider `env`；`spawnEnv` 对 `EnvPatch` 的 `null` 保留父进程变量，`applyEnv` 也只删除会话覆盖值。因此必须验证实际子进程最终环境，不能以覆盖映射删键代表已清除继承变量。局部适配须保留其他供应商语义，不修改 daemon 全局环境。
- 插件密钥仅用于经核验的官方端点。自带认证或自定义端点的 provider 不接管；冲突认证无法隔离，或包装器及其他配置使实际认证、端点无法确认时，拒绝注入并提供不含秘密值的说明，不静默覆盖用户配置。
- 用量查询可在服务端读取所选账户的 CLI 登录凭据；原有登录只读使用、不复制或修改，新增登录写入独立目录。不读取其他供应商凭据、不共享整个 Cursor 目录、不接触 IDE 数据库。进程环境仍可被同用户或后代进程读取，不构成强安全隔离。

## 验收

| 验收组 | 必要证据 |
| --- | --- |
| 基础接入 | 目标账户 Key 可用、认证及计费方式已确认；目标版本支持消息、工具权限、结束会话。 |
| ACP 阻塞交互 | 分别触发 `cursor/ask_question`、`cursor/create_plan`，验证展示、用户回答或批准/拒绝、对应 JSON-RPC 响应和后续会话状态。这些请求会等待响应，普通消息测试不能替代；缺失支持须记录为核心兼容性缺口。 |
| 账户与会话 | 覆盖范围表中的账户管理和路由，两个账户并行不串号；独立验证同账户及跨账户恢复，再验证选定路径下的手动、批量、自动切换与默认变更、删除/禁用协调，交接来源正确。 |
| 用量与提前切换 | 完成查询和隔离验证，核对百分比、金额单位、额度池和重置周期；仅金额响应可展示且不冒充额外用量或百分比。覆盖首次未知及“曾成功、随后失败/凭据失效/过期”：旧值有失效说明、排序退回未知、不触发提前切换或新预测；恢复有效读数后再按门槛启用。 |
| 自动与回退 | 真实脱敏样本验证限额/认证失效识别及误触发防护；检查限次、耗尽账户排除、继续开关、跨供应商交接和权限匹配。 |
| 凭据与端点 | 三处配置来源分别及组合测试，核对实际子进程环境、正常账户选择和拒绝注入；覆盖参数形式与无法确认目标的包装器。拒绝路径使用占位密钥，不向自定义端点发送真实密钥。 |
| 安全与回归 | 文件权限、防回显符合要求；执行类型检查和受影响测试，其他供应商行为不回归。 |

缺少凭据或难以复现真实错误时，可继续静态、模拟和样本回放验证，但须标明证据类型并保留真实集成待办，不能宣称实测通过。记录实际测试的平台与版本，不要求先完成全平台矩阵；真实请求可能消耗账户额度。

## 调研证据与参考

本次核对本项目及 Paseo `7c35ad90`、CC Switch `3c76d3bd`。Paseo 有 Cursor 用量实现；CC Switch 当前未列出 Cursor 原生支持，仅参考其查询、缓存与故障转移机制，代理请求切换不能证明 CLI 会话可跨账户恢复。

原调研记录 Linux CLI `2026.10.16-e3cb207` 的版本和帮助检查；未测试真实登录、查询、模型请求、耗尽或恢复。上游实现不代表目标 Paseo/CLI 版本已兼容。

以下官方资料及上游 main 可能继续变化：

1. [Cursor CLI 认证](https://cursor.com/docs/cli/reference/authentication)
2. [Cursor CLI 参数](https://cursor.com/docs/cli/reference/parameters)
3. [Cursor CLI 配置](https://prod.cursor.com/docs/cli/reference/configuration)
4. [Cursor CLI ACP](https://cursor.com/docs/cli/acp)
5. [Cursor 团队 Admin API](https://prod.cursor.com/docs/account/teams/admin-api)
6. [Paseo 自定义 provider 配置](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)
7. [Paseo provider 开发说明](https://github.com/getpaseo/paseo/blob/main/docs/providers.md)
8. [Paseo Cursor 用量源](https://github.com/getpaseo/paseo/blob/7c35ad90b91b07ed469b1e29dc70cc17f78a90e7/plugins/cursor-usage-source/server/usage.ts)及[账户隔离测试](https://github.com/getpaseo/paseo/blob/7c35ad90b91b07ed469b1e29dc70cc17f78a90e7/plugins/cursor-usage-source/server/usage.test.ts)
9. [Cursor 重置周期说明](https://cursor.com/help/account-and-billing/billing)
10. [CC Switch 用量查询](https://github.com/farion1231/cc-switch/blob/3c76d3bda670297dd8c27d7d9be9b18a4c9143f5/docs/user-manual/zh/2-providers/2.5-usage-query.md)及[故障转移边界](https://github.com/farion1231/cc-switch/blob/3c76d3bda670297dd8c27d7d9be9b18a4c9143f5/docs/user-manual/zh/4-proxy/4.3-failover.md)
