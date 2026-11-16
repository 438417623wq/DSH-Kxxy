# 0.9.33：中文工作区与异常凭据锁恢复

0.9.32 救援日志中，工作区服务读取 `--data-user-0-app.kxxy-files-kxxy-home-workspaces-~6D4B~8BD5--/session-e8816590-86c0-4c47-b718-c4608f7a762d` 被拒绝，connection 服务等待 `.credentials.yaml.lock` 超时。这两项阻止服务启动，导致控制台显示 `AUTH UNAVAILABLE / connection.no-service`。

旧救援器没有接受上游 `projectKey` 的 `~XXXX` 中文编码，且把路径段限制为 240 字节；上游最大为 255 字节。本版接受该安全字符范围与长度，继续按日志限定单个私有会话范围。回归测试直接运行打包运行时的 `projectKey`，覆盖日志中的中文目录、空格、波浪号、emoji 与截断后的最长目录名。

该日志还显示凭据锁记录不符合严格的 `PID + LF` 格式。普通修复仍只隔离经 ESRCH 确认失效的标准锁。显式 Root 修复新增异常锁处理：在 supervisor 确认停机后，检查有界 `/proc` 元数据，确认没有其他应用 UID 进程或引用本应用私有目录的进程，再在 claim 下反复核对进程、锁 inode 与记录。无法读取进程信息、仍有写入者、已有 claim、记录超过 4096 字节或核验超时会停止。

异常锁原样保留在私有备份中，凭据文件不读取、不改写；元数据日志只保存记录长度和哈希。Root 仅用于本次修复，后续继续使用原来的运行模式。

覆盖安装 `dist/Kxxy-0.9.33.apk`，保留现有应用数据。进入 **诊断/救援 → 修复会话权限和凭据锁 → 用 Root 修复会话和失效锁**，确认本次授权并在 Root 管理器中允许，完成后重新启动引擎。此案例的异常锁需要 Root；如手机没有 Root，中文路径修复仍可执行，异常锁会明确报告无法核验。

本地 Kotlin/JVM 回归、生产 Root 脚本行为测试及 APK 构建验证见 `dist/Kxxy-0.9.33-verification.json`。这些检查不代替故障手机上的 Root、SELinux 与实际启动验证。
