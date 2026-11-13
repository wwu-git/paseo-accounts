# Cursor CLI 多账户管理接入可行性调研

- 日期：2026-11-13
- 项目：Paseo Accounts（`@jgreys/paseo-accounts`）
- 代码基线：`b7e043fdb7c92087c70727a1d7b0155e0b6d6ac3`
- 范围：Paseo 内启动的 Cursor CLI 会话，不涉及 Cursor IDE 或普通终端启动包装命令。
- 状态：调研与实现建议，尚未实现或批准；未进行真实账户集成测试。

## 结论与范围

推荐采用 **Cursor 用户 API Key + 现有账户适配器 + Paseo Cursor/ACP provider**。用户 API Key 是 Cursor 自身凭据，账户可用性及计费方式仍需实测。

复用现有功能与设置；依赖 Cursor 行为的能力先验证，缺少接口依据的能力暂缓。仅做必要局部适配，不新增通用迁移、错误分类、凭据服务或能力注册框架。

| 功能 | 接入边界 |
| --- | --- |
| 添加、命名、删除账户 | 复用 OpenCode 密钥输入、RPC 和原子写入；区分保存成功与认证有效。 |
| 默认账户、单会话选择、Follow default、优先级、文件夹绑定、启用/禁用 | 复用现有路由；默认变更、禁用和删除后的会话协调遵守下述便携性规则。 |
| CLI 原有登录 | 用官方状态命令只读检测，按现有 main 账户语义处理；只解析已验证字段，无法识别时显示说明。 |
| 手动、批量及自动切换 | 纳入适配，具体路径见下文；沿用“移动打开会话”、忙碌会话与跳过原因规则。 |
| 跨供应商继续、时间线和通知 | 沿用现有可选开关、权限档位匹配及渠道，不改变默认开关和其他供应商顺序。 |
| 未知用量排序 | 复用未知用量评分、优先级和默认账户兜底，不显示为“剩余最多”。 |
| 个人额度/套餐查询、预测、提前切换、Cursor 专用额度重置和付费额外用量 | 缺少已确认接口，暂不支持；未知用量不触发阈值切换，团队 Admin API 不作为必选依赖。 |
| 多账户浏览器登录 | 条件支持：先证明配置目录可隔离登录、刷新及退出；不阻塞 API Key 路线。可复用 `agent login` 与 `NO_OPEN_BROWSER=1`，不以修改 `HOME` 或共享整套配置替代验证。 |

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
| `shared/model.ts`、`server/families.ts` | 增加 `cursor`、名称、认证覆盖识别和穷举映射，按现有顺序加入回退目标。 |
| `server/adapter.ts`、新增 `server/cursor.ts` | 实现 `FamilyAdapter` 的认证、密钥保存、环境注入、用量不支持说明及错误识别；安全约束见下节。 |
| `server/opencode.ts`、`server/json-file.ts` | 复用密钥登录和 `writeJsonAtomic`，补齐遮蔽输入与防回显。 |
| `server/binaries.ts`、`index.server.ts` | 注册适配器并解析命令、前缀参数；区分 provider ID `cursor` 与通常名为 `agent` 的可执行文件。 |
| `server/service.ts`、`server/handoff.ts` 与账户界面 | 接入现有路由、切换及交接，泛化供应商文案。 |

先确认目标 Paseo 的 Cursor provider 或自定义 ACP 配置可运行 `agent acp`。已有入口可用时只补配置；验收发现必须修改 Paseo 核心的兼容性缺口时，单独报告并确定范围。

## 凭据与端点

- 密钥保存在插件账户目录，目录 `0700`、文件 `0600`，原子写入；删除本地账户不等于撤销服务端密钥。输入遮蔽，密钥不进入账户状态、日志、通知、错误文本或命令行参数，只注入对应 CLI 进程。
- 注入前检查 **daemon 继承环境、provider 环境、完整启动命令参数**，覆盖 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、`--api-key`、`--auth-token`，以及端点 `CURSOR_API_ENDPOINT`、`--endpoint`、`-e` 和目标 CLI 支持的参数形式；验证与本地登录的优先级。
- 当前 `bringsOwnAuth` 只检查 provider `env`；`spawnEnv` 对 `EnvPatch` 的 `null` 保留父进程变量，`applyEnv` 也只删除会话覆盖值。因此必须验证实际子进程最终环境，不能以覆盖映射删键代表已清除继承变量。局部适配须保留其他供应商语义，不修改 daemon 全局环境。
- 插件密钥仅用于经核验的官方端点。自带认证或自定义端点的 provider 不接管；冲突认证无法隔离，或包装器及其他配置使实际认证、端点无法确认时，拒绝注入并提供不含秘密值的说明，不静默覆盖用户配置。
- 不复制 CLI 原有登录或其他供应商凭据，不强制修改全局登录，不默认共享整个 Cursor 目录，不接触 IDE 数据库。进程环境仍可被同用户或后代进程读取，不构成强安全隔离。

## 验收

| 验收组 | 必要证据 |
| --- | --- |
| 基础接入 | 目标账户 Key 可用、认证及计费方式已确认；目标版本支持消息、工具权限、结束会话。 |
| ACP 阻塞交互 | 分别触发 `cursor/ask_question`、`cursor/create_plan`，验证展示、用户回答或批准/拒绝、对应 JSON-RPC 响应和后续会话状态。这些请求会等待响应，普通消息测试不能替代；缺失支持须记录为核心兼容性缺口。 |
| 账户与会话 | 覆盖范围表中的账户管理和路由，两个账户并行不串号；独立验证同账户及跨账户恢复，再验证选定路径下的手动、批量、自动切换与默认变更、删除/禁用协调，交接来源正确。 |
| 自动与回退 | 真实脱敏样本验证限额/认证失效识别及误触发防护；检查限次、耗尽账户排除、继续开关、跨供应商交接和权限匹配。 |
| 凭据与端点 | 三处配置来源分别及组合测试，核对实际子进程环境、正常账户选择和拒绝注入；覆盖参数形式与无法确认目标的包装器。拒绝路径使用占位密钥，不向自定义端点发送真实密钥。 |
| 安全与回归 | 文件权限、防回显符合要求；执行类型检查和受影响测试，其他供应商行为不回归。 |

缺少凭据或难以复现真实错误时，可继续静态、模拟和样本回放验证，但须标明证据类型并保留真实集成待办，不能宣称实测通过。记录实际测试的平台与版本，不要求先完成全平台矩阵；真实请求可能消耗账户额度。

## 调研证据与参考

已阅读适配器、路由、账户、会话协调及交接代码，确认未知用量排序和非便携交接已有实现。原调研执行过 Linux 本机 `agent --version`、`agent --help`，版本为 `2026.10.16-e3cb207`；尚未测试真实登录、密钥、模型请求、额度耗尽或恢复。目标版本仍需核验，Paseo 上游 main 不代表所有受支持历史版本。

以下官方资料及上游 main 可能继续变化：

1. [Cursor CLI 认证](https://cursor.com/docs/cli/reference/authentication)
2. [Cursor CLI 参数](https://cursor.com/docs/cli/reference/parameters)
3. [Cursor CLI 配置](https://prod.cursor.com/docs/cli/reference/configuration)
4. [Cursor CLI ACP](https://cursor.com/docs/cli/acp)
5. [Cursor 团队 Admin API](https://prod.cursor.com/docs/account/teams/admin-api)
6. [Paseo 自定义 provider 配置](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)
7. [Paseo provider 开发说明](https://github.com/getpaseo/paseo/blob/main/docs/providers.md)
