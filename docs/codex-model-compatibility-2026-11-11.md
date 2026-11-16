# Codex 模型兼容与侧栏优化 · 2026-11-11

## 目标与实现

本轮保留官方 Codex `0.167.0`、DSH `0.2.1-rc.5` 和 Android app-process / untrusted 审批边界，重点解决“已添加的模型仍不能使用”，并在已有 VS Code 风格侧栏上完善操作。

### 模型与协议

- 新增共享 `provider-config.mjs`、`provider-http.mjs`、`provider-protocols.mjs`，统一发现、检查、聊天与桥接请求。
- 支持 OpenAI Responses、Chat Completions、Anthropic Messages；认证支持 Bearer、x-api-key、api-key 和无认证。
- 地址规范化支持基础地址和完整接口路径；附加 headers/query 独立校验。显式预设与模型级兼容、推理档位、输出/思考预算可配置，不按模型名称猜测。
- 版本 1 配置兼容读取，版本 2 原子保存；非法条目保留且隔离，正常模型仍可用。API Key 与服务路由版本分开处理，不向前端返回凭据摘要或附加头/查询参数值。
- 文本、SSE、固定无副作用工具调用与回传分别检查。保存不联网；检查必须点击并确认，结果绑定配置版本。普通回复通过不代表原生工具通过。

### 原生 CLI 兼容桥

`Codex app-server → 127.0.0.1 Responses 入口 → Chat Completions / Anthropic Messages`

- 工具仍由 Codex 执行；桥只转换消息、函数/自由文本/命名空间工具、回传、终态与 usage。
- 入口随机端口、随机路由、独立令牌、绑定目标服务，校验 Host/Origin；不开放任意代理，不跟随重定向，不自动重发。
- 真实文本增量输出并跨片段脱敏。所有工具定义、参数、回放及终态验证完成前不发可执行的 tool done；截断/失败/断流不会伪造 completed。
- 固定 apply_patch Lark grammar 仅通过显式 `wrap-known` 字符串包装，响应告警说明上游不执行原 grammar；未知 grammar 拒绝。
- 不支持并行控制的服务显式收窄到单工具；明确没有推理能力的服务可忽略 CLI 默认 effort 并告警。声明了推理档位的模型遇到不匹配值仍拒绝，不自动选另一个档位。
- 默认资源上限：32 连接、4 全局并发/每绑定 1、128 绑定、2 MiB 请求、512 KiB 下行缓冲；回放每绑定 64 条/8 MiB、全局 32 MiB，最多保留 32 版凭据用于持续脱敏。

**限制：**不支持 previous_response_id、远程 compact、托管搜索、tool-search、多模态、未知协议参数。Anthropic 私密签名只在同一存活绑定缓存回放，重启/淘汰/跨绑定或内容被改后明确失败，需新建线程；不伪造 encrypted reasoning。原生 Responses 继续直连，其 HTTP 参数由 CLI 构造，不保证所有手写 HTTP 兼容参数会改变该直连请求。

### 线程与安全修复

- 官方 native A→B 与自定义模型切换统一新建线程，旧历史保留。
- API Key 单独更新后，空闲发送前刷新原生凭据；正在进行的请求使用接受时的配置快照。地址、协议、认证类型、header/query 变更不允许将旧历史重定向。
- 按 app-server 连接代次标记已加载线程，重连后先恢复，忽略旧进程迟到事件。
- JSON/SSE 共用严格终态；完整工具 JSON、已声明工具名、ID 唯一及常见 schema 校验。schema 校验不是完整 JSON Schema 实现。
- 首包、空闲、总超时和取消传播统一，无隐式重试。stderr 按完整日志单元脱敏，RPC/HTTP 安全错误保留分类。
- 引用文件复用工作区工具的凭据路径屏蔽；浏览器快照剔除私密回放、providerMessages、路由/凭据摘要。
- 有效宿主会话即使尚未选择工作区，也可管理模型、连接 CLI、查看账号；实际任务和环境检查仍必须有工作区。

### 侧栏

- 紧凑顶栏、消息/工具记录和底部单行工具条保留。
- 模型/推理合并菜单支持搜索、协议/引擎分组、管理入口。
- CLI 连接、官方账号、模型服务独立分区，兼容配置折叠，必需认证与无认证明确区分。
- 配置保存/未验证/失败分开显示；检查前确认与错误明细、配置版本失效机制。
- 修复长模型名挤出发送按钮、发送反色、说明弹层被移动插件误匹配、异步清空新草稿。
- 输入自适应高度、手机 Enter 换行/桌面 Enter 发送、IME 保护、编辑定位与删除确认。
- 设置/历史仍可看到运行/待审批状态和停止入口；审批显示工作目录，多个审批共用高度预算。

## 实测结果

### 自动化（最终冻结源码）

**150/150 功能回归通过，0 失败、0 跳过；另实际客户端静态检查 22/22 和增量封装修复回归 1/1 通过。**

| 测试文件 | 数量 |
| --- | ---: |
| `tools/test-codex.mjs` | 18 |
| `tools/test-codex-custom.mjs` | 10 |
| `tools/test-codex-provider.mjs` | 6 |
| `tools/test-codex-workspace.mjs` | 11 |
| `tools/test-codex-mode.mjs` | 10 |
| `tools/test-codex-native.mjs` | 16 |
| `tools/test-codex-protocols.mjs` | 22 |
| `tools/test-codex-bridge.mjs` | 52 |
| `tools/test-codex-diagnostics.mjs` | 5 |
| `tools/fixtures/codex-ui-static-check.mjs` | 22（独立统计） |
| `tools/test-codex-restamp.mjs` | 1（独立统计） |

其中桥测试使用实际共享协议实现与真实 loopback HTTP mock，不使用外部供应商；原生服务合同仍使用 FakeNativeTransport，不等于真实 CLI 模型往返。基线 65 项在修改前也全部通过。

复现（Node 24）：

```text
node tools/fixtures/codex-ui-static-check.mjs
node --test tools/test-codex.mjs tools/test-codex-custom.mjs tools/test-codex-provider.mjs tools/test-codex-workspace.mjs tools/test-codex-mode.mjs tools/test-codex-native.mjs tools/test-codex-protocols.mjs tools/test-codex-bridge.mjs tools/test-codex-diagnostics.mjs
```

### 浏览器 DOM/交互与几何

通过官方浏览器工具操作正式 `client.js`/CSS 的离线夹具：

- 320/360 手机宽度、1280 视口内 320 窄侧栏，区域 scrollWidth 与 clientWidth 一致。
- 430×932 宽度下任务/待审批状态可见。
- 360 下模型菜单打开后约 x=12.8～340.8，无横向裁切；Anthropic 搜索过滤到对应两组，Escape 可关闭。
- 深色原生启用态发送按钮背景 `rgb(224,226,229)`、前景 `rgb(32,34,38)`，且按钮在容器范围内。
- 320 下审批说明保留 `aria-modal=true`，不匹配移动插件的通用设置弹窗选择器，宽度不溢出，Escape 可关闭。
- 设置页显示独立 CLI 连接与三协议模型设置；切换 Anthropic 的认证默认值为 x-api-key，无认证不要求 Key。
- 历史视图仍显示“待审批 · 3 项”、返回任务与停止。

**未完成像素视觉验收：**浏览器 screenshot 两次返回 `browser screenshot surface preparation timed out after 3000ms`，高阶指针点击也遇到通道超时。部分操作通过官方 DOM 节点点击、表单 API 和语义快照验证。不能将几何/静态检查当作截图验收；未加载完整真机宿主组合，未做触摸键盘真机测试。

正式无密钥预览入口为 `tools/preview-codex-client.mjs`，场景在 `tools/fixtures/codex-ui-scenarios.mjs`；场景内容明确标注模拟，不是构建或模型执行证据。

### 仍需实际环境验证

- 未使用用户真实 API Key/URL 调用模型。
- 本机未找到同版本 Windows CLI；官方发布 API 定向查询超时，未下载或运行替代版本。打包的 ARM64 Linux 程序不能直接在 Windows 执行。
- 未安装 Android 设备，未验证升级后真实 CLI→第三方模型完整任务。
- `check-bundle.mjs` 已补 Codex installation-scope 检查；本轮没有可直接使用的完整安装树，未运行该宿主装配集成脚本。
- 模型基础协议兼容不保证任意供应商支持 Codex 所有工具/参数；真实失败还需看脱敏模型 ID、协议、地址路径和错误分类，不需要提交密钥。

## 装配

新增模块已纳入 `tools/lib/codex.mjs`、`tools/verify-runtime.mjs` 和 Android `RuntimeInstaller.kt` 完整性清单。`build-runtime.mjs` 原有递归收集即可覆盖新模块，无需改它的既有改动。

首次增量重封校验失败：5 个新协议模块只写了本地记录、未进入中央目录。旧 `restamp-codex-plugin.mjs` 还存在已删除模块未真正剔除、中央目录 extra 字节未复制的问题。本轮修复新增/删除条目登记、头部一致性、existing-output 提前拒绝，并用小型独占 ZIP fixture 验证文件内容、条目数、无孤儿记录、原始未变更条目保留、重复输出不覆盖及二次预检。失败候选 `.cache/runtime-0.9.39/` 不用于交付，修复后的目标为 `.cache/runtime-0.9.39-final/`。

已生成新包 `0.9.39` / versionCode `937002`，不覆盖 0.9.38。APK 为 `dist/Kxxy-0.9.39.apk`，1,960,506,456 字节，SHA256 `375055a20749cea42f586b8b91e76b008f829cd6c170b3256b6b1c7e2dd2627b`。Gradle 3m24s成功，aapt2版本核对、APK对齐、固定证书v1/v2/v3签名、原生入口与19个插件文件逐一比对全部通过。报告见 `dist/Kxxy-0.9.39-verification.json`；其中 `checksPassed` 仅代表装配验证，不代表上述真机/真实模型/像素视觉项已通过。未安装设备，后续新包 versionCode 至少937003。
