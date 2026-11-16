package app.kxxy.engine

import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * 用**真实 APK 资产**对**真实旧运行时铺开目录**跑一次离线升级。
 *
 * 目的：设备上「升级卡在解压 0%」无法远程取证，这里复现同一条链路：
 * 旧运行时（0.9.43 归档铺开）→ Python 只读预检 → DSH 增量升级 → Python 修复。
 * 不写死任何期望；成功打印计数与耗时，失败打印真实 Refused 文本。
 */
fun main(args: Array<String>) {
    val root = File(args[0]).absoluteFile
    val assets = File(args[1]).absoluteFile
    val host = args[2]
    val privateDir = root.parentFile

    val dshAssets = DshRuntimeUpgrade.Assets { name ->
        val file = File(assets, name)
        if (!file.isFile) throw java.io.FileNotFoundException("asset missing: $name")
        FileInputStream(file) as InputStream
    }
    val pyAssets = PythonRuntimeRepair.Assets { name ->
        val file = File(assets, name)
        if (!file.isFile) throw java.io.FileNotFoundException("asset missing: $name")
        FileInputStream(file) as InputStream
    }

    val upgrade = DshRuntimeUpgrade(dshAssets, privateDir, host)
    val repair = PythonRuntimeRepair(pyAssets, privateDir, host, 36)

    println("root=${root.path}")
    println("assets=${assets.path}")
    println("private=${privateDir.path}")
    println("dsh configured=${upgrade.isConfigured()} empty=${upgrade.isEmpty(root)} current=${runCatching { upgrade.isCurrent(root) }}")

    val t0 = System.nanoTime()
    try {
        repair.preflight(root)
        println("python preflight: ok (${ms(t0)} ms)")
    } catch (e: Throwable) {
        println("python preflight FAILED: ${e.javaClass.name}: ${e.message}")
        return
    }

    val t1 = System.nanoTime()
    try {
        val result = upgrade.upgrade(root)
        println("dsh upgrade: replaced=${result.replaced.size} backups=${result.backups.size} supported=${result.supported} (${ms(t1)} ms)")
    } catch (e: Throwable) {
        println("dsh upgrade FAILED: ${e.javaClass.name}: ${e.message}")
        return
    }

    val t2 = System.nanoTime()
    try {
        val result = repair.repair(root)
        println("python repair: replaced=${result.replaced.size} (${ms(t2)} ms)")
    } catch (e: Throwable) {
        println("python repair FAILED: ${e.javaClass.name}: ${e.message}")
        return
    }

    println("isCurrent after upgrade=${runCatching { upgrade.isCurrent(root) }.getOrNull()}")
    println("TOTAL ${ms(t0)} ms")
}

private fun ms(start: Long): Long = (System.nanoTime() - start) / 1_000_000
