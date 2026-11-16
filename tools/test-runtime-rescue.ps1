param([string]$Project = (Split-Path -Parent $PSScriptRoot), [string]$Java = 'E:\deepseek-harness\XJZB\_toolchain\jdk-17.0.20.1+1\bin\java.exe')
$ErrorActionPreference='Stop'
$work=Join-Path ([IO.Path]::GetTempPath()) ('runtime-rescue-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$utf8=New-Object Text.UTF8Encoding($false)
function Stub($name,$body) { [IO.File]::WriteAllText((Join-Path $work $name),$body,$utf8) }
Stub 'Context.kt' @'
package android.content
import java.io.File
import android.content.res.AssetManager
class AppInfo { var nativeLibraryDir: String = "not-installed" }
open class Context(val filesDir: File, val cacheDir: File, val assets: AssetManager) {
    val applicationInfo = AppInfo()
    fun getSystemService(name: String): Any? = null
    companion object { const val CONNECTIVITY_SERVICE = "connectivity" }
}
'@
Stub 'Assets.kt' @'
package android.content.res
import java.io.File
class AssetFd(val length: Long) : java.io.Closeable { override fun close() {} }
class AssetManager(val root: File) {
    fun open(name: String) = File(root, name).inputStream()
    fun openFd(name: String) = AssetFd(File(root, name).length())
    fun list(name: String): Array<String>? = File(root,name).list()
}
'@
Stub 'Log.kt' @'
package android.util
object Log {
    fun i(tag: String, msg: String) = 0
    fun w(tag: String, msg: String) = 0
    fun e(tag: String, msg: String, error: Throwable) = 0
}
'@
Stub 'Network.kt' @'
package android.net
class Network
class Properties { val dnsServers = emptyList<java.net.InetAddress>() }
class ConnectivityManager {
    val activeNetwork: Network? = null
    fun getLinkProperties(network: Network): Properties? = null
}
'@
Stub 'Android.kt' @'
package android.os
object Build { val SUPPORTED_ABIS = arrayOf("arm64-v8a") }
'@
Stub 'BuildConfig.kt' @'
package app.kxxy
object BuildConfig { const val HOST_PLUGIN_FINGERPRINT = "unknown" }
'@
Stub 'EngineConfig.kt' @'
package app.kxxy.engine
import android.content.Context
import java.io.File
object EngineConfig {
    const val DEFAULT_PORT = 3080
    fun engineRoot(c: Context) = File(c.filesDir,"engine")
    fun nodeBin(c: Context) = File(engineRoot(c),"bin/node")
    fun dshEntry(c: Context) = File(engineRoot(c),"lib/node_modules/@deepseek-ai/dsh/lib/bin.js")
    fun stampFile(c: Context) = File(engineRoot(c),".runtime-version")
    fun extensionsRoot(c: Context) = File(engineRoot(c),"extensions")
    fun dshHome(c: Context) = File(c.filesDir,"kxxy-home")
    fun tmpDir(c: Context) = File(c.cacheDir,"tmp")
    fun officeFontsDir(c: Context) = File(engineRoot(c),"fonts")
    fun emacsSiteLoadDir(c: Context) = File(engineRoot(c),"emacs-site")
    fun texmfVar(c: Context) = File(c.filesDir,"texmf-var")
    fun buildEnv(c: Context, port: Int, mode: String) = emptyArray<String>()
}
'@
Stub 'Json.kt' @'
package org.json
class JSONArray { fun length() = 0; fun optString(i: Int) = "" }
class JSONObject(private val text: String) {
    fun optLong(key: String, fallback: Long) = Regex("\""+key+"\"\\s*:\\s*(\\d+)").find(text)?.groupValues?.get(1)?.toLong() ?: fallback
    fun optString(key: String, fallback: String = "") = fallback
    fun optJSONArray(key: String): JSONArray? = JSONArray()
}
'@
$cache=Join-Path $env:USERPROFILE '.gradle\caches\modules-2\files-2.1'
function Jar($pattern) { (Get-ChildItem -LiteralPath $cache -Recurse -Filter $pattern -File | Select-Object -First 1).FullName }
$stdlib=Jar 'kotlin-stdlib-1.9.24.jar'
$annotation=Jar 'annotations-13.0.jar'
$coroutines=Jar 'kotlinx-coroutines-core-jvm-1.8.1.jar'
$compiler=@((Jar 'kotlin-compiler-embeddable-1.9.24.jar'),$stdlib,(Jar 'kotlin-script-runtime-1.9.24.jar'),(Jar 'kotlin-reflect-1.9.24.jar'),(Jar 'trove4j-*.jar'),$annotation) -join ';'
$runtime=@($stdlib,$coroutines,$annotation) -join ';'
$engine=Join-Path $Project 'android\app\src\main\java\app\kxxy\engine'
$sources=@((Join-Path $engine 'RuntimeInstaller.kt'),(Join-Path $engine 'RuntimeInstallIo.kt'),(Join-Path $Project 'tools\fixtures\RuntimeRescueTest.kt')) + @(Get-ChildItem $work -Filter '*.kt' | ForEach-Object {$_.FullName})
$out=Join-Path $work 'tests.jar'
& $Java -cp $compiler org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 17 -classpath $runtime -d $out @sources
if ($LASTEXITCODE -ne 0) { throw "Stub compilation failed ($LASTEXITCODE); scratch: $work" }
& $Java -cp ($out+';'+$runtime) app.kxxy.engine.RuntimeRescueTestKt
if ($LASTEXITCODE -ne 0) { throw "Regression test failed ($LASTEXITCODE); scratch: $work" }
Write-Host "Regression scratch: $work"
