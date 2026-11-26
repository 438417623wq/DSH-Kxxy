# v0.9.103：内置 DSH 回归基线

**这是 0.9.102 → 0.9.103 的本地构建与覆盖升级记录，不是一次上游 DSH 升版。** 从两份经验证的 runtime 中读取包清单，两版 `@deepseek-ai/dsh`、`dsh-office-kit` 都是 `0.2.2-rc.3`，`libreoffice-kit` 都是 `0.2.3`。本次从正式旧 APK 增量重封，未用新 ASAR；不能据此证明下次的上游 ASAR 已兼容。本目录记录验证结果，不包含应用源码或 APK。

| 发布物 | 0.9.102 基线 | 0.9.103 目标 |
|---|---|---|
| APK versionCode | 1002000 | 1003000 |
| APK SHA-256 | `fb3e883a455ebb07ca75b5297e90cd16894fd311059e620dc925b1012239d47c` | `bc2a40c341439cf8cba43f65067b91fa6ac487fdd0963d877aaae68f161effc6` |
| 内嵌 runtime SHA-256 | `127de6c2daf9cff7eda1d56af755f4b6485c90ad0bbdae67a6821d30bba1f04b` | `a853c8ae90500b9c284d9164133b1e50d759c86fde9ee24518b87a190af5468f` |
| 补丁集 / 扩展池 | `@50` / 33 个，glibc r10 | `@51` / 33 个，签名 APK 内逐项哈希不变 |

## 下次看到同样症状，先查这里

| 症状 | 这次的根因或边界 | 应验证什么 |
|---|---|---|
| Office 标记不对、Python 路由未同步、`bin/fc-list` 状态错误同时出现 | 拿到 r9 工作缓存，而不是正式 r10。换回已核实的发布基线后，这三项一起恢复。 | 对签名 APK 中的 `assets/runtime.zip` 计算摘要并与独立 ZIP、build meta 对账；还要放入同一版本的池，不能把“扫描 0 个 JAR”当通过。 |
| 新装正常，覆盖升级缺新功能 | 只改宿主指纹，不足以证明能迁移已变的 `health.mjs`。 | JS 与 Kotlin 双端精确列入迁移名单；全包差分、本地真实旧字节 JVM 迁移和用户冲突零写入分别验证。不能为通过测试而放宽名单。 |
| `import matplotlib` 持续报 `Bad key kxxy`、`Duplicate key` | 包模板会剥一个 `#`；把用户 rc 块追加到包模板会产生非法键和重复键。 | 用真实 LF 模板执行生产 shell 和 Kotlin 迁移；确认二次启动不再增行或删除缓存。 |
| 关于页 commit 显示 `fatal: ` | 把 git 的 stderr 当作 commit。 | 分离输出、检查退出码，SHA 合法或显示 `nogit`。本包生成的 `BUILD_COMMIT=5a4a9af` 是构建时采用的 Git 基点，不是未提交修复的源码快照。 |
| `fc-match Calibri` 成功，Office 仍报缺字体 | 请求匹配不等于族名枚举；旧缓存也可能不含新别名。 | 扫描阶段只对随包物理字体追加族名，用 `FcFontList` 验证 23 个别名的文件和款式。测旧缓存、二次暖启动、真 Calibri 和候选完全同分时的用户优先级。WASM 回退按字体 name 表报告，不能与原生路径混为一谈。 |
| 可枚举 `Noto Sans CJK SC/KR`，XeLaTeX 却找不到 | 仅改 fontconfig 不足以让 fontspec 按这两个名字选字。 | 两份站点 `.fontspec` 只在真实字体缺失时回退。关闭 xeCJK 自动分派后读 PDF：SC 嵌入 Noto Sans SC，KR 嵌入 NanumGothic；显式 Path / UprightFont 与真实字体优先。宿主 7 个主用例和 4 个对照通过。 |
| 更新后首启约一分钟 `pydeps=pending` | 离线预置尚未结束，不等于永久故障。 | 检查进度、WARN → OK，以及真正失败后的重试；预置与探针测试 6/6。真实设备首启 UI 未验。 |

## 实际运行记录

- [构建、runtime、JVM、安装路由、缺失夹具的原始输出摘录](verification-excerpts.txt)：不是完整构建机日志。135 项合成 JVM 用例通过；以实际 0.9.102 受管字节升级，6 个文件原子替换、用户冲突零写入、重复升级零替换。
- [APK 验包摘要](apk-verification.json) · [Python 修复包验包摘要](python-verification.json)。保留检测值、限制及告警，不保留机器路径。
- 最终 APK 为 3,973,249,557 字节。`aapt2 dump badging` 实读 `app.kxxy / 0.9.103 / 1003000`。签名、对齐、包内 runtime、字体资源与 33 个扩展池已核对。

## 复跑入口（在与待验版本匹配的源码和隔离工程中）

```text
node tools/verify-runtime.mjs <new-runtime.zip>
node tools/sync-python-repair.mjs --base <published-old.zip> --base-sha256 <old-runtime-sha256> --runtime <new-runtime.zip> --assets <apk-assets/python-repair> --meta <apk-assets/meta/build.json> --check-only
node tools/verify-python-repair.mjs <new-runtime.zip> <apk-assets/python-repair> <apk-assets/meta/build.json>
node tools/test-runtime-installed-routes.mjs <new-runtime.zip> <new-target-dir>
node tools/test-python-repair.mjs <published-old.zip> <apk-assets-dir>
node tools/test-runtime-capability-contracts.mjs
```

**未覆盖：** `test-office-font-patch.mjs` 缺指定的 `0.2.2-rc.2-dedup.asar` 双版本回归夹具，零用例执行，不能算通过。未进行设备覆盖安装、原生 soffice 转换、首启 UI 或设备 XeLaTeX 验收。宿主 Office 检查与宿主 XeTeX 排版均不替代这些项目。
