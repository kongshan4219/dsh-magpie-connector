# dsh-magpie-connector 开发与发布约束

## 上游与开发范围

- 修改前对照原仓库 `prgrmrwy/dsh-magpie-connector` 的实现。需要追溯上游开发时，查看 `prgrmrwy/ohmydsh` 中的 `packages/dsh-magpie-connector`。
- 为减少额度消耗，避免使用 ComposeUse。开发、测试、安装和发布优先通过 CLI、官方 API 或现有脚本完成。若桌面验收必须通过图形界面，说明哪些步骤需要手动操作，由维护者完成。

## 接入进度

- **已完成｜Magpie Web Search 与网页获取。** `0.8.1`（`c786edf`）已发布到 [npm](https://www.npmjs.com/package/@kongseek/dsh-magpie-connector/v/0.8.1) 和 [GitHub Release](https://github.com/kongshan4219/dsh-magpie-connector/releases/tag/v0.8.1)。本地 DSH 用自带 DeepSeek 模型实测了 `web_search` 搜索及 `web_fetch` 读取 GitHub 官方文档，并验证关闭开关会恢复两个原提供方。从 npm 重装后，已确认两个工具仍指向 Magpie。后续接手时以此版本为基线，可以直接继续待实现项。
- **待实现｜获取文本对话以外的模型。**
- **待实现｜支持 Anthropic API 格式。**

## 联网搜索与网页获取

- 在 DSH 的 **设置 → Magpie → 联网搜索** 提供启用 Magpie Web Search 的开关，并用另一个开关同时替换 DSH 内置 `web_search` 和 `web_fetch`。打开替换时，两个工具都走当前 Magpie 线路。关闭替换或停用 Magpie Web Search 时，分别恢复先前的提供方。
- 网关搜索设置参考额度卡片的读取方式，复用当前线路和凭据，通过接口自动获取。无需用户手动填写 Magpie 管理页地址。选择项参考 Magpie 管理页，按网关接口实际提供的能力与设置展示。
- `0.8.1` 通过当前线路的 Magpie MCP `tools/list` 读取搜索与网页获取能力、默认结果数和已公开的筛选项。代搜供应商、故障切换顺序和搜索 API 仍由 Magpie 管理端配置。

## 版本、验收与发布

- 沿用原仓库的 npm 分发方式。fork 固定使用 `@kongseek/dsh-magpie-connector`，优先支持从 DSH 插件市场安装。
- 主版本和次版本跟随上游。当前保留 `0.8` 系列，本 fork 的版本更新只递增补丁位。
- 发布顺序固定为 **修改 → 打包并安装到本地 DSH 桌面版 → 实际验证并由维护者验收 → 发布 npm → 创建 GitHub Release → 本地 DSH 从 npm 重装**。验证联网功能时，在桌面会话中查看内置工具是否实际执行，并检查关闭开关后能否恢复原提供方。
- GitHub Release 附上 npm 已发布的同一份安装包。本地重装时用 fork 的正式 npm 包替换验收用本地包或已安装的上游版本。
