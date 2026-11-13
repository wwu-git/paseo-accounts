# Cursor CLI 本机交付记录

- 任务：CURSOR-CLI-01
- 主机 / Agent：dev-ubuntu / `/root`；独立只读评审 `/root/cursor_review`
- 仓库：`wwu-git/paseo-accounts`
- Worktree：`/home/dev/.paseo/worktrees/0zd6lzrd/panicky-porcupine`
- 分支：`panicky-porcupine`
- 开发基线：`391145bd4c8256fa213c3208f134e51fd0c82be0`
- 有序代码提交：`cc4ebb4433a3a356d12ed70f67f0cc060e4d900e` → `74223f6`；文档提交以本文件的 Git 历史为准。
- 本次未 push、创建 PR 或合并主分支。

## 已接入

Cursor 账户类型、原有 CLI 登录只读识别、新增用户 API Key、默认账户、显式绑定、优先级、文件夹规则，以及现有启用/禁用、非便携会话协调、历史交接、切换记录和通知机制。

新增 Key 使用 CLI 内存凭据库，不读取或覆盖主登录令牌。启动时保存不含密钥的会话指纹；可信认证失败会持久标记对应 Key 失效，插件重载后仍有效，替换 Key 后不会继承旧 Key 的失效标记。普通限流和网络错误不触发额度切换。额度重置时间未知时使用原框架的本地冷却，不声称代表官方重置周期。

Linux 原有 CLI 文件登录可查询官方用量。保留接口百分比；账期不冒充额度重置时间。独立额度池仅展示，不限制整账户、不参与排序、提前切换或预测。金额余额与付费额外用量分开；过期或失败数据在 Accounts 和 Paseo Usage 中显示说明。API Key 账户不借用全局登录查询。

数据兼容变更：会话新增可选 `credentialIdentity`；用量新增可选 `routingEligible`、`validUntil`、`balances`，现有记录与其他供应商默认语义保持兼容。

## 验证证据

环境：Linux x86_64，Node.js 24.22.0，npm 11.19.1，Paseo 0.15.4，Cursor CLI 2026.10.16-e3cb207。

| 验证 | 结果 |
| --- | --- |
| 基线 `npm test` | 27 文件、191 项通过 |
| 最终 `npm test` | 30 文件、219 项通过 |
| `npm run typecheck` | 通过，客户端与服务端均检查 |
| `npm run audit:mobile` | 通过 |
| Key 保存、取消、冲突环境/命令、端点隔离 | 自动测试通过；占位凭据，未向自定义端点发送真实 Key |
| 路由、非便携交接、认证失效、插件重载、Key 替换 | 服务集成测试通过；恢复与交接使用模拟 Paseo transport |
| 原有 CLI `agent status --format json` | 本机已认证；未输出秘密值 |
| 固定官方用量接口 | 使用本机 CLI 登录，HTTP 200；返回两项百分比窗口 |
| 安装后插件状态 RPC | Cursor provider 已识别、main 账户 ready、两项用量窗口，无用量错误 |
| 插件安装与重载 | 本机 directory 插件；状态 running；未重启整个 daemon |

只读评审发现并修复了内存凭据隔离、认证失效确认和 Usage 失效说明三项问题，并为重载与 Key 替换补充回归。

## 未覆盖与条件能力

- 没有第二个真实 Cursor 账户；新增 Key 的实际账户归属、订阅计费、真实双账户并行与切换、额度耗尽仍未实测。保存 Key 成功不等于认证有效。
- 未发送真实模型提示词，未验证实际工具执行。ACP 初始化与一次空会话创建成功；空会话跨进程 `session/load` 返回 -32602，后一次创建超时。不能据此宣称持久对话恢复成功或完全不可用。
- 不启用 `portable=true`；跨账户原地恢复未验证，采用既有新建会话交接方案。
- 本机 Paseo 核心没有直接实现 `cursor/ask_question`、`cursor/create_plan` 扩展处理。CLI 静态代码具备标准 permission / 本地计划文件回退，但完整提问、用户回答、计划批准/拒绝尚未实测。这是核心兼容性待办，本插件未修改 Paseo 核心。
- 浏览器多登录隔离、API Key 用量查询、个人套餐查询、独立额度池的路由含义与周期未确认，相关条件功能未开放。macOS、Windows 未测试。

## 使用与维护

在 dev-ubuntu 的 Paseo 打开 **Accounts**，可看到原有 Cursor CLI 登录。通过 **Add account → Cursor** 添加 Cursor 用户 API Key，然后沿用默认账户或会话账户选择。已有历史的会话换账户会新建接续会话，并传递历史；原会话保留。

安装来源是上述 worktree。不要在插件仍从此目录运行时删除该 worktree；编辑后用 `paseo plugin reload paseo-accounts` 重载。若需停用，执行 `paseo plugin disable paseo-accounts`，保留本地账户数据以便恢复。不要盲目恢复整个 daemon 配置或删除用户账户目录。
