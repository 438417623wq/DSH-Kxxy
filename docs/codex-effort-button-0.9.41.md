# 推理强度入口点击修复 · 0.9.41

## 变更

本轮只修改正式客户端的菜单开关和强度按钮点击区域，不改模型协议、权限策略或历史数据。

- `Popup` 的 summary 点击不再只依赖浏览器原生默认展开。点击时明确阻止默认切换并同步 details.open、React 状态及 aria-expanded。
- Enter、空格、向下箭头采用同一显式开关；队列中的 toggle 事件仅同步状态，不二次切换或重复抢焦点。
- 外部点击、Escape、焦点离开及禁用状态统一关闭；模型不支持强度或任务运行中的禁用限制保留。
- 强度按钮最小宽度40px，文字/箭头点击统一交给入口，保留单行底栏且320px无横向溢出。

涉及文件：
- `plugins/dsh-codex-sidebar/lib/client.js`
- `plugins/dsh-codex-sidebar/web/codex.css`
- `tools/fixtures/codex-ui-static-check.mjs`

## 核实与验证

修复前当前预览中曾能展开菜单、从中切换到高，因此不能把“所有点击都会失败”或某一浏览器版本缺陷当成已证实根因；确认的代码问题是入口完全依赖原生summary默认切换且缺入口级测试，本轮将此路径显式化。

- 界面静态检查 **51/51通过**，新增指针默认行为被阻止时仍同步开关、键盘/外部关闭/禁用状态、选项选择及下一次turn携带high的覆盖。
- Codex全量回归 **187/187通过**，0失败。
- 正式客户端语法检查通过。
- 当前360px浏览器预览已刷新为修复代码。通过截图定位后的点击，强度菜单展开；点击高后按钮更新为高，菜单收起，aria-expanded恢复false。
- 320px测得侧栏clientWidth=scrollWidth=319，强度按钮宽40px且未挤出发送控件。
- 高阶浏览器定位点击仍间歇出现宿主超时，采用官方截图/坐标交互完成验证；不把工具通道失败归因为模型接口故障。

没有使用真实模型API、没有安装Android设备。当前预览由本机夹具提供，UI点击与真实请求参数由独立静态测试验证，不代表所有设备触控组合已验收。

## 构建

已构建 `dist/Kxxy-0.9.41.apk`，versionName0.9.41 / versionCode937004（aapt2核对），1,960,539,224字节。APK SHA256：`56b46b73b3a7429dbf78d59cfdfc2b416fae7c65f2f91ffeab3d26414f157f89`。编译、固定证书签名、22个插件文件源码一致性及运行时完整性校验均通过；报告为 `dist/Kxxy-0.9.41-verification.json`，旧0.9.40保留，未安装设备。

runtime为 `.cache/runtime-0.9.41/runtime.zip`，SHA256 `07c9fa7479a08139bed1765d57f2818c0d30b5d5256ffd31b9fec78449bf52b8`，插件指纹 `67289b106baf93cb9c3e37becacc3fc9686ecaee2d90d96eb14d158ca7a308c4`。后续版本号下限为937005。
