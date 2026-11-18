# dsh-magpie-connector 开发与发布约束

## 上游与开发范围

- 修改前对照原仓库 `prgrmrwy/dsh-magpie-connector` 的实现。需要追溯上游开发时，查看 `prgrmrwy/ohmydsh` 中的 `packages/dsh-magpie-connector`。
- 为减少额度消耗，避免使用 ComposeUse。开发、测试、安装和发布优先通过 CLI、官方 API 或现有脚本完成。若桌面验收必须通过图形界面，说明哪些步骤需要手动操作，由维护者完成。

## 接入进度

- **已完成｜Magpie Web Search 与网页获取。** `0.8.1`（`c786edf`）已发布到 [npm](https://www.npmjs.com/package/@kongseek/dsh-magpie-connector/v/0.8.1) 和 [GitHub Release](https://github.com/kongshan4219/dsh-magpie-connector/releases/tag/v0.8.1)。本地 DSH 用自带 DeepSeek 模型实测了 `web_search` 搜索及 `web_fetch` 读取 GitHub 官方文档，并验证关闭开关会恢复两个原提供方。从 npm 重装后，已确认两个工具仍指向 Magpie。
- **已验证｜Magpie 生图。** DSH 生图沿用 `dsh-image-gen` 的 Magpie OpenAI 兼容渠道，维护者已确认实际出图。当前渠道可选 `codex/gpt-image-2` 和 `workbuddy/hunyuan-image-alpha`。生图相关的模型选择和调用由 `dsh-image-gen` 负责，从本 connector 的待办中移除这项生图集成。 [dsh-image-gen](https://github.com/shanliuling/dsh-image-gen)
- **已通过桌面验收｜Anthropic Messages。** `0.8.2` 从 `0.8.1` 继续，支持 DSH 通过 Magpie 调用 Anthropic Messages。实测记录见下节。

## Anthropic Messages

- DSH host adapter 作为客户端调用 Magpie 的 `POST /v1/messages`。Magpie 自己提供对外的兼容入口，并按模型原样转发或转换协议。两个上游插件均在 host adapter 内选择协议。插件沿用原有模型 ID、归属路由、线路凭据、Cloudflare Access 和故障切换。 [原仓库](https://github.com/prgrmrwy/dsh-magpie-connector/blob/main/src/host/adapter.ts) [ohmydsh](https://github.com/prgrmrwy/ohmydsh/tree/main/packages/dsh-magpie-connector) [Magpie 接入文档](https://github.com/yetone/magpie/blob/main/docs/integrating.md)
- 默认按当前线路目录的 `native_endpoints` 选择，优先 Responses，其次 Messages，其余走 Chat Completions，和 Magpie 自带的 DSH 集成一致。线路切换后，Messages 自动选择以新目录为准。可在 **设置 → Magpie → 线路 → 高级 → 模型协议** 显式选择 Anthropic Messages，交由 Magpie 为其他模型转换协议。该选项要求线路地址以 `/v1` 结尾，对这条线路上的新调用生效。选回「自动」即可恢复目录选择。 [Magpie 的 DSH 集成](https://github.com/yetone/magpie/blob/main/internal/agent/dsh.go)
- 当前使用现有 DSH 流式生成链路，支持工具调用与结果、相同模型和协议的思考签名回放、缓存用量和错误映射。显式 Messages 模式下，实际可用的转换能力由网关和上游模型决定，生成失败仍由 DSH 的原有重试策略处理。
- 2026-11-18 使用 DSH 自带 CLI 将 `0.8.2` 本地包安装到桌面 profile。已核对安装的 host 与 client 产物和打包产物一致。
- 同一构建通过 CLI 调用实际 Magpie 网关。当前目录没有声明原生 Messages 的模型。对 `workbuddy/deepseek-v4.1-flash` 显式使用 Messages 命中 `/v1/messages`，选回自动命中 `/v1/chat/completions`。两次均为 HTTP 200、完整流式结束并回复 `PONG`，分别记录 `anthropic-messages` 和 `openai-completions`，每次为 23 输入、2 输出 token。Messages 实测还完成了虚拟工具调用及 `tool_result` 往返，两次请求均为 HTTP 200，第二次收到 128 个缓存读取 token。
- 自动模式下 `codex/gpt-6-luna` 实测命中 `/v1/responses`，返回 HTTP 200 和 `PONG`，完整结束并记录 `openai-responses`。
- 2026-11-18 重启 DSH 桌面版并用同一 WorkBuddy 模型在两个新会话实测，推理等级均为 `none`。显式 Messages 会话 `session-cc1ce506-82a0-4589-af76-9c9c2d33bc89` 的回放元数据为 `anthropic-messages`，恢复自动后的会话 `session-5f9032a7-2d61-4047-a92f-c7d9554c94b6` 为 `openai-completions`。两轮均回复 `PONG`，持久化会话记录均为 `completed`。线路设置已恢复为自动，维护者已确认可以发布。
- 类型检查和构建通过。全量测试 576 项通过，Windows 上已有的 `host-wiring.test.ts` POSIX 文件模式断言失败（期望 `0600`，报告 `0666`）。维护者同意 `0.8.2` 发布时接受这项已知失败。协议测试覆盖前缀路径、系统消息、流式工具调用和结果、缓存用量、HTTP/SSE 错误、截断流、故障切换以及切回自动模式。

## 联网搜索与网页获取

- 在 DSH 的 **设置 → Magpie → 联网搜索** 提供启用 Magpie Web Search 的开关，并用另一个开关同时替换 DSH 内置 `web_search` 和 `web_fetch`。打开替换时，两个工具都走当前 Magpie 线路。关闭替换或停用 Magpie Web Search 时，分别恢复先前的提供方。
- 网关搜索设置参考额度卡片的读取方式，复用当前线路和凭据，通过接口自动获取。无需用户手动填写 Magpie 管理页地址。选择项参考 Magpie 管理页，按网关接口实际提供的能力与设置展示。
- `0.8.1` 通过当前线路的 Magpie MCP `tools/list` 读取搜索与网页获取能力、默认结果数和已公开的筛选项。代搜供应商、故障切换顺序和搜索 API 仍由 Magpie 管理端配置。

## 版本、验收与发布

- 沿用原仓库的 npm 分发方式。fork 固定使用 `@kongseek/dsh-magpie-connector`，优先支持从 DSH 插件市场安装。
- 主版本和次版本跟随上游。当前保留 `0.8` 系列，本 fork 的版本更新只递增补丁位。
- 发布顺序固定为 **修改 → 打包并安装到本地 DSH 桌面版 → 实际验证并由维护者验收 → 发布 npm → 创建 GitHub Release → 本地 DSH 从 npm 重装**。验证联网功能时，在桌面会话中查看内置工具是否实际执行，并检查关闭开关后能否恢复原提供方。
- GitHub Release 附上 npm 已发布的同一份安装包。本地重装时用 fork 的正式 npm 包替换验收用本地包或已安装的上游版本。
