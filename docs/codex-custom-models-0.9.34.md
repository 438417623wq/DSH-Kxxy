# Codex 自定义模型 · 0.9.34

2026-11-09：Codex 侧栏增加“设置 → 模型设置”，可添加、编辑、删除多个模型，并在输入框下方选择模型进行对话。

## 使用

填写显示名称、服务地址 URL、模型 ID、API 密钥及接口格式，点击“保存并使用”。默认接口为 Chat Completions，也支持 Responses。URL 支持基础地址或完整接口地址。编辑模型时可留空密钥，保留原密钥。

自定义模型对话直接请求用户配置的服务，支持流式回复、停止、文件引用和历史恢复，无需 Codex CLI 或 ChatGPT 登录。切换模型服务、模型 ID 或接口格式会新建对话；更新显示名称和密钥可以继续原对话。删除模型后仍可查看历史。

## 实现

- `plugins/dsh-codex-sidebar/lib/custom-models.mjs`：URL 与配置校验，私有密钥存储及公开元数据。
- `plugins/dsh-codex-sidebar/lib/custom-chat.mjs`：两种兼容接口、流式解析、超时和取消。
- `service.mjs` 与 `index.js`：同源鉴权、会话与工作区绑定、请求去重、历史及模型接口。
- `client.js` 与 `codex.css`：模型管理、选择、手机布局及删除后的历史展示。
- 原生安装器与运行时校验器加入新模块的存在检查；插件指纹随 APK 更新，旧引擎资产可识别并更新。

模型配置保存到应用私有 `codex-home/sidebar-models.json`，对话保存在同目录的 `sidebar-threads.json`。文件以 `0600` 权限原子写入；API 密钥不返回到前端，也不写入对话索引。仅发送消息时访问模型服务，保存配置不发起外部模型请求。

## 验证

`node --test tools/test-codex.mjs tools/test-codex-custom.mjs`：27 项全部通过；原有宿主插件冒烟测试通过。

新增 10 项测试使用本地 HTTP 服务验证配置持久化、空密钥编辑、没有 CLI 的请求发送、UTF-8/SSE 分片、Chat Completions 与 Responses、历史恢复、取消、超时、重复提交、模型服务切换、工作区和会话校验、错误密钥脱敏及接口鉴权。

实际 React 客户端在 Chrome 浏览器夹具中验证保存、密钥字段清空、发送、停止、历史恢复、改名、重复使用同一模型、删除后历史可读且发送禁用、设置页滚动及 390/320 像素手机布局。截图保存在 `.cache/custom-model-ui-settings.png` 与 `.cache/custom-model-ui-chat.png`。

APK 使用现有固定签名，版本号为 `0.9.34`，版本码为 `934000`。运行时保留原有扩展、Unix 权限和 LINK 注释，替换 Codex 插件并更新指纹和构建元数据。原有安装包与运行时备份保留。

产物为 `dist/Kxxy-0.9.34.apk`（1,846,199,384 字节），SHA-256 为 `a197db290dbda9e15ee098cb4867ff5d0199e2ea0060d708d0ac823bf822420b`。Gradle 构建、固定签名、原生入口、启动救援、运行时资产及打包源码逐文件一致性校验均通过；报告见 `dist/Kxxy-0.9.34-verification.json`，版本及权限信息见 `.cache/apk-badging-0.9.34.log`。

## 当前边界

自定义模型用于文本对话，不执行工具调用。原生 Codex CLI 未打包，Android 智能体执行仍需沙箱验收。本轮未使用用户真实 URL/API 密钥访问在线模型服务，也未安装到手机进行真机验收。

接口实现参考 [OpenAI Docs：Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)。
