# 故障手机直接修复记录

2026-11-09，已安装 0.9.33 的故障手机 25102RKBEC（ADB：192.168.166.241:5555）。

启动受阻原因是应用私有目录中的 `.credentials.yaml.lock` 为 0 字节空锁，导致必需的 connection 插件等待写入锁超时。会话目录权限错误在 0.9.33 上已不再出现。

停止应用后，完整、未截断的进程列表确认 UID 10577 无进程，也没有应用私有引擎路径引用。随后通过 `run-as app.kxxy` 核对空锁 inode、所有者、权限及大小，并将原 inode 原子移入私有备份：

```
/data/user/0/app.kxxy/files/kxxy-home/.kxxy-adb-lock-recovery-0933-25a96d17/lock
```

备份内有仅含元数据的 `repair.journal`。修复过程未打开凭据内容，凭据文件元数据在移动空锁前后完全一致。既有 root-owned 接管记录保持原样，会话和工作区保留。

真机验证结果：

- 引擎 Healthy，PID 6327，验证时已连续运行 733 秒，超过原约 37 秒失败重试周期。
- 从本次启动 URL 在内存中取得 Cookie，认证后的 `/kxxy/api/state`、`/kxxy/api/health`、`/kxxy` 均返回 HTTP 200。
- 11 项健康检查全部 OK，bootFailures 为 0，管理页无 AUTH UNAVAILABLE。
- 本次启动日志无 writer lock 超时或 startup failed。
- 再次打开应用，原有会话内容正常显示。

无线 ADB 曾中断，重连后已完成以上验证。此次是应用 UID 的离线空锁修复；没有把 Root 自动恢复或跨 UID SELinux 行为记为真机验证通过。

详细结果见 `dist/Kxxy-0.9.33-verification.json` 的 `deviceValidation`。
