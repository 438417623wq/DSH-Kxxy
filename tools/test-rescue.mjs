// Independent JVM behavior tests: compile production Diagnostics/Gate against small Android stubs.
// No Gradle/APK build, downloads, credentials or repository output; temporary classes removed on exit.
// Run: node tools/test-rescue.mjs (KXXY_JAVA / KXXY_KOTLIN_CACHE may override local tools).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { redactLog } from '../plugins/kxxy-host/lib/redact.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'android/app/src/main/java/app/kxxy')
const temp = mkdtempSync(join(tmpdir(), 'kxxy-rescue-test-'))
const cache = process.env.KXXY_KOTLIN_CACHE || join(homedir(), '.gradle/caches/modules-2/files-2.1')
function find(dir, prefix) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? find(join(dir, e.name), prefix) : e.name.startsWith(prefix) && e.name.endsWith('.jar') ? [join(dir, e.name)] : [])
}
const dependencies = [
  ['org.jetbrains.kotlin/kotlin-compiler-embeddable', 'kotlin-compiler-embeddable-1.9.24'],
  ['org.jetbrains.kotlin/kotlin-stdlib', 'kotlin-stdlib-1.9.24'],
  ['org.jetbrains.kotlin/kotlin-script-runtime', 'kotlin-script-runtime-1.9.24'],
  ['org.jetbrains.kotlin/kotlin-reflect', 'kotlin-reflect-1.6.10'],
  ['org.jetbrains.intellij.deps/trove4j', 'trove4j-'],
  ['org.jetbrains/annotations', 'annotations-13.0'],
].map(([folder, prefix]) => {
  const hit = find(join(cache, folder), prefix)[0]
  assert.ok(hit, `Missing cached dependency ${prefix}; set KXXY_KOTLIN_CACHE`)
  return hit
})
const javaRoot = 'C:/Program Files/Eclipse Adoptium'
const localJava = existsSync(javaRoot) ? readdirSync(javaRoot).filter(n => n.startsWith('jdk-')).map(n => join(javaRoot, n, 'bin/java.exe')).find(existsSync) : null
const java = process.env.KXXY_JAVA || localJava || 'java'
const files = []
function stub(name, text) { const file = join(temp, name); writeFileSync(file, text); files.push(file) }
function command(args) {
  const result = spawnSync(java, args, { cwd: temp, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.equal(result.status, 0, result.error?.message || 'JVM test failed')
}
// Extract real decision bodies, not translated logic. GUI/lifecycle wiring remains device validation.
const main = readFileSync(join(src, 'MainActivity.kt'), 'utf8')
function method(name) {
  const start = main.indexOf(`    private fun ${name}(`)
  assert.ok(start >= 0, `missing Main method ${name}`)
  const opening = main.indexOf('{', start)
  let depth = 1, end = opening + 1
  while (depth && end < main.length) { if (main[end] === '{') depth++; if (main[end] === '}') depth--; end++ }
  return main.slice(start, end)
}
const localPredicate = main.slice(main.indexOf('    private fun isLocalDocument('), main.indexOf('    private fun pathOf('))
try {
  stub('Context.kt', `package android.content
import java.io.File
import android.content.pm.PackageManager
open class Context(val filesDir: File, val packageManager: PackageManager = PackageManager())
class Intent(private val extras: Map<String,String> = emptyMap()) { fun getStringExtra(key:String):String? = extras[key] }
`)
  stub('PackageManager.kt', `package android.content.pm
class PackageInfo(val packageName:String, val versionName:String?)
class PackageManager {
 class NameNotFoundException:Exception()
 val installed = linkedMapOf<String,PackageInfo>()
 var reads = 0
 fun getPackageInfo(pkg:String, flags:Int):PackageInfo { reads++; return installed[pkg] ?: throw NameNotFoundException() }
}
`)
  stub('WebView.kt', `package android.webkit
import android.content.pm.PackageInfo
object WebView { var actual:PackageInfo? = null; var failure:Throwable? = null
 @JvmStatic fun getCurrentWebViewPackage():PackageInfo? { failure?.let { throw it }; return actual }
}
`)
  stub('Log.kt', `package android.util
object Log { fun i(tag:String, text:String)=0; fun w(tag:String,text:String)=0 }
`)
  stub('Build.kt', `package android.os
object Build { const val MANUFACTURER="stub"; const val MODEL="test"; const val DISPLAY="test-build"; val SUPPORTED_ABIS=arrayOf("arm64-v8a")
 object VERSION { const val SDK_INT=26; const val RELEASE="8" } }
class StatFs(path:String) { val availableBytes=123456789L }
object Process { fun myUid()=10234 }
`)
  stub('Os.kt', `package android.system
object Os { fun getgid()=10234 }
`)
  stub('Uri.kt', `package android.net
class Uri(val scheme:String?, val host:String?, val port:Int)
`)
  stub('Engine.kt', `package app.kxxy.engine
import android.content.Context
import java.io.File
object EngineConfig {
 const val DEFAULT_PORT=3080
 fun engineRoot(ctx:Context)=File(ctx.filesDir,"engine")
 fun logFile(ctx:Context)=File(ctx.filesDir,"engine/engine.log")
 fun webBootFile(ctx:Context)=File(ctx.filesDir,"kxxy-home/web-boot/web-boot.json")
 fun recoveryResultFile(ctx:Context)=File(ctx.filesDir,"engine/recovery-result.json")
 var requested="normal"
 fun readPrivMode(ctx:Context)=requested
}
object UserDataPermissions {
 data class Outcome(val success:Boolean, val changes:List<String>, val detail:String, val needsRoot:Boolean=false)
 var metadata="home/.credentials.yaml uid=0 gid=0 mode=0600 label=u:object_r:app_data_file:s0 read=false\\nstorages/workspace.json uid=0 gid=0 mode=0600 read=false"
 var reports=0
 fun report(ctx:Context):String { reports++; return metadata }
 fun issue(ctx:Context):String? = error("diagnostics must not run probe")
 suspend fun repair(ctx:Context, allowRoot:Boolean=false):Outcome = error("diagnostics must not change permissions")
}
object SessionDataPermissions {
 var metadata="home/sessions uid=0 gid=0 mode=0700 read=false; session-files metadata only"
 var reports=0
 fun report(ctx:Context):String { reports++; return metadata }
 fun issue(ctx:Context):String? = error("diagnostics must not run session probe")
 suspend fun repair(ctx:Context, allowRoot:Boolean=false):UserDataPermissions.Outcome = error("diagnostics must not change sessions")
}
object CredentialsLockRecovery {
 var metadata="home/.credentials.lock uid=0 gid=0 mode=0600 pid=12345 alive=false"
 var reports=0
 fun report(ctx:Context):String { reports++; return metadata }
 fun issue(ctx:Context):String? = error("diagnostics must not run lock probe")
 suspend fun repair(ctx:Context, allowRoot:Boolean=false, writersStopped:Boolean=false):UserDataPermissions.Outcome = error("diagnostics must not change lock")
}
object BuildMeta { var text="build-metadata"; fun snapshot(ctx:Context)=Snapshot(); class Snapshot { fun toJson()=text } }
class EngineSupervisor {
 sealed interface State {
  data object Idle:State; data class Installing(val progress:Float):State; data object Starting:State
  data class Healthy(val port:Int,val tokenUrl:String?):State; data class Backoff(val delayMs:Long,val attempt:Int):State
  data class Failed(val reason:String):State; data object Stopped:State
 }
 class Flow(var value:State)
 val state=Flow(State.Idle)
 var effective="normal"
 fun effectivePrivilegeMode()=effective
}
`)
  const vectors = [
    'dsh web: http://127.0.0.1:3080/?token=LaunchSecret123&ok=1',
    '/__kxxy_pair?code=abc123de', 'Authorization: Bearer launch-secret',
    'Authorization: Basic dXNlcjpwYXNz', 'Cookie: session=secret; other=private',
    'Set-Cookie: session=secret; HttpOnly', 'sk-ABCDEFGHIJKLMNOP123456',
    'ghp_ABCDEFGHIJKLMNOP123456', 'token=0123456789abcdef0123456789abcdef',
    '/data/user/10/other.app/files/home/workspace',
  ]
  writeFileSync(join(temp, 'redact-vectors.txt'), vectors.map(v => Buffer.from(v).toString('base64')).join('\n'))
  writeFileSync(join(temp, 'redact-expected.txt'), vectors.map(v => Buffer.from(redactLog(v)).toString('base64')).join('\n'))
  stub('Assertions.kt', `package app.kxxy.testing
var count=0
fun check(value:Boolean, lazyMessage:()->Any={"Check failed"}) { count++; kotlin.check(value,lazyMessage) }
`)
  stub('MainHarness.kt', `package app.kxxy
import app.kxxy.testing.check
import android.content.Intent
import app.kxxy.engine.EngineConfig
import app.kxxy.engine.EngineSupervisor
class MainHarness {
 val supervisor=EngineSupervisor()
 var engineWasHealthy=false; var engineTokenUrl:String?=null; var localSessionMinted=true
 var webViewUsable=true; var urlLoaded=true; var remoteMode=false; var pageReady=false
 var rescueReason:String?=null; var pendingAttentionId:String?=null; var pendingSessionId:String?=null
 var offered=0; var loaded=0; var delivered=0
 fun offerRescue(reason:String) { rescueReason=reason; offered++ }
 fun clearRescue() { rescueReason=null }
 fun loadEngineUrl(url:String?) { loaded++; urlLoaded=true }
 fun navigateToAttention(id:String, session:String?) { delivered++ }
${method('applyEngineState')}
${method('handleLaunchIntent')}
${method('flushPendingAttention')}
${localPredicate}
 fun runTests() {
  applyEngineState(EngineSupervisor.State.Healthy(3080,"http://localhost/?token=a"))
  check(engineWasHealthy && loaded==0)
  applyEngineState(EngineSupervisor.State.Failed("bad")); check(offered==1)
  remoteMode=true; applyEngineState(EngineSupervisor.State.Backoff(1,1)); check(offered==1)
  remoteMode=false; webViewUsable=false; urlLoaded=false
  applyEngineState(EngineSupervisor.State.Healthy(3080,"http://localhost/?token=b")); check(loaded==0 && !localSessionMinted)
  webViewUsable=true; applyEngineState(EngineSupervisor.State.Healthy(3080,null)); check(loaded==1)
  supervisor.state.value=EngineSupervisor.State.Starting
  handleLaunchIntent(Intent(mapOf(EXTRA_ATTENTION_ID to "target", EXTRA_SESSION_ID to "session")))
  check(pendingAttentionId=="target" && delivered==0 && offered==2)
  supervisor.state.value=EngineSupervisor.State.Healthy(3080,null)
  pageReady=false; flushPendingAttention(); check(delivered==0)
  pageReady=true; remoteMode=true; flushPendingAttention(); check(delivered==0)
  remoteMode=false; flushPendingAttention(); check(delivered==1 && pendingAttentionId==null)
  check(isLocalDocument(android.net.Uri("http","127.0.0.1",3080)))
  check(!isLocalDocument(android.net.Uri("http","127.0.0.1.evil",3080)))
  check(!isLocalDocument(android.net.Uri("http","127.0.0.1",9999)))
 }
 companion object { const val TAG="test"; const val EXTRA_ATTENTION_ID="id"; const val EXTRA_SESSION_ID="session" }
}
` .replace('import android.content.Intent', 'import android.content.Intent\nimport android.util.Log'))
  stub('Test.kt', String.raw`import android.content.Context
import app.kxxy.testing.check
import android.content.pm.PackageInfo
import android.webkit.WebView
import app.kxxy.WebViewGate
import app.kxxy.engine.*
import java.io.File
import java.util.Base64
fun main(args:Array<String>) {
 val root=File(args[0]); val ctx=Context(root); val supervisor=EngineSupervisor()
 val input=File(root,"redact-vectors.txt").readLines(); val expected=File(root,"redact-expected.txt").readLines()
 for (i in input.indices) {
  val raw=String(Base64.getDecoder().decode(input[i])); val want=String(Base64.getDecoder().decode(expected[i]))
  val got=RescueDiagnostics.redact(raw)
  if (raw.startsWith("Authorization:")) check(!got.contains("launch-secret") && !got.contains("dXNlcjpwYXNz"))
  else if (raw.startsWith("Set-Cookie:")) check(!got.contains("secret"))
  else check(got==want) { "redact semantics mismatch: $i: $got vs $want" }
 }
 val shortSecrets=listOf("password=hunter2", "pwd=x", "passwd=short", "apiKey=abc", "API_KEY=abc", "access_token=short", "Authorization: Digest private value", "X_API_KEY=abc")
 for (text in shortSecrets) check(!RescueDiagnostics.redact(text).contains(text.substringAfter('=').substringAfter(": "))) { text }
 val json="""{"token":"tiny", "apiKey":"abc", "Authorization":"Bearer xyz", "password":"two words", "message":"fetch failed"}"""
 val cleaned=RescueDiagnostics.redact(json)
 for(secret in listOf("tiny","abc","xyz","two words")) check(!cleaned.contains(secret))
 check(cleaned.contains("fetch failed"))
 check(RescueDiagnostics.redact("commit=1234567 error=ECONNREFUSED")=="commit=1234567 error=ECONNREFUSED")
 check(RescueDiagnostics.redact(cleaned)==cleaned)
 val quoted="""password="line one
line two\\\"tail"""""
 check(!RescueDiagnostics.redact(quoted).contains("line two"))
 check(!RescueDiagnostics.redact("password=\"unterminated secret").contains("unterminated"))
 ctx.packageManager.installed["com.google.android.webview"]=PackageInfo("com.google.android.webview","80.0")
 WebView.actual=PackageInfo("com.selected.webview","130.2")
 check(WebViewGate.chromeMajor(ctx)==130 && ctx.packageManager.reads==0)
 check(WebViewGate.diagnosticLabel(ctx).contains("com.selected.webview"))
 WebView.actual=PackageInfo("com.selected.webview","unknown")
 check(WebViewGate.chromeMajor(ctx)==null && WebViewGate.isSupported(ctx))
 WebView.actual=null; check(WebViewGate.chromeMajor(ctx)==80)
 check(WebViewGate.diagnosticLabel(ctx).contains("无法确定"))
 WebView.failure=IllegalStateException("provider unavailable"); check(WebViewGate.chromeMajor(ctx)==80)
 WebView.failure=UnsatisfiedLinkError(); check(WebViewGate.diagnosticLabel(ctx).contains("无法确定")); WebView.failure=null
 val engine=File(root,"engine"); engine.mkdirs()
 val home=File(root,"kxxy-home/web-boot"); home.mkdirs()
 val log=File(engine,"engine.log"); log.writeText("token=do-not-show\\n".replace("\\n","\n")+"error=ECONNREFUSED\n")
 File(home,"web-boot.json").writeText(json)
 File(engine,"native-boot-failure.json").writeText("""{"error":"UnsatisfiedLinkError", "token":"native-secret"}""")
 File(engine,"recovery-result.json").writeText("password=recovery-secret\nstatus=failed\n")
 val credential=File(root,"kxxy-home/profiles/web/credentials.json"); credential.parentFile.mkdirs(); credential.writeText("CREDENTIAL_FILE_MUST_NOT_BE_READ")
 val session=File(root,"kxxy-home/sessions/current.json"); session.parentFile.mkdirs(); session.writeText("SESSION_FILE_MUST_NOT_BE_READ")
 File(root,"kxxy-home/.credentials.yaml").writeText("CREDENTIAL_YAML_MUST_NOT_BE_READ")
 File(root,"kxxy-home/.credentials.lock").writeText("LOCK_CONTENT_MUST_NOT_BE_READ")
 val original=log.readBytes(); val before=root.walkTopDown().filter {it.isFile}.associate {it.relativeTo(root).path to it.readBytes().contentHashCode()}
 supervisor.state.value=EngineSupervisor.State.Failed("token=failed-secret reason=spawn")
 val report=RescueDiagnostics.report(ctx,supervisor)
 check(UserDataPermissions.reports==1 && SessionDataPermissions.reports==1 && CredentialsLockRecovery.reports==1)
 check(report.contains("Session data permissions (metadata only)") && report.contains("home/sessions") && report.contains("session-files metadata only"))
 check(report.contains("Credentials lock (metadata / nonsecret PID only)") && report.contains("home/.credentials.lock") && report.contains("pid=12345 alive=false"))
 check(report.contains("User data permissions (metadata only)") && report.contains("home/.credentials.yaml") && report.contains("storages/workspace.json"))
 check(report.contains("appUid=10234; appGid=10234") && report.contains("requested=normal; effective=normal"))
 check(report.contains("uid=0 gid=0 mode=0600") && report.contains("label=u:object_r:app_data_file:s0") && report.contains("read=false"))
 EngineConfig.requested="root"; supervisor.effective="normal"
 check(RescueDiagnostics.report(ctx,supervisor).contains("requested=root; effective=normal"))
 UserDataPermissions.metadata+="\npassword=metadata-secret"
 SessionDataPermissions.metadata+="\npassword=session-metadata-secret"
 CredentialsLockRecovery.metadata+="\napi_key=lock-metadata-secret"
 val metadataReport=RescueDiagnostics.report(ctx,supervisor)
 check(!metadataReport.contains("metadata-secret") && !metadataReport.contains("session-metadata-secret") && !metadataReport.contains("lock-metadata-secret"))
 for(secret in listOf("do-not-show","recovery-secret","native-secret","failed-secret","CREDENTIAL_FILE_MUST_NOT_BE_READ","CREDENTIAL_YAML_MUST_NOT_BE_READ","SESSION_FILE_MUST_NOT_BE_READ","LOCK_CONTENT_MUST_NOT_BE_READ","tiny","two words")) check(!report.contains(secret)) {secret}
 for(field in listOf("BuildMeta","ABI=arm64-v8a","availableBytes=123456789","actualWebview","Engine state","ECONNREFUSED","WebBootLog","recovery-result","native-boot-failure","UnsatisfiedLinkError","fetch failed")) check(report.contains(field)) {field}
 check(log.readBytes().contentEquals(original))
 val after=root.walkTopDown().filter {it.isFile}.associate {it.relativeTo(root).path to it.readBytes().contentHashCode()}; check(before==after)
 supervisor.state.value=EngineSupervisor.State.Healthy(3080,"URL_MUST_NOT_APPEAR")
 check(!RescueDiagnostics.report(ctx,supervisor).contains("URL_MUST_NOT_APPEAR"))
 log.writeText("prefix token="+"LEAK".repeat(9000)+"\nnewest complete line\n")
 val tail=RescueDiagnostics.report(ctx,supervisor); check(!tail.contains("LEAK") && tail.contains("newest complete line") && tail.contains("tail truncated"))
 log.writeText("token="+"UNBROKEN".repeat(6000)); check(!RescueDiagnostics.report(ctx,supervisor).contains("UNBROKEN"))
 log.writeText("utf8 中 error=timeout\n".repeat(4000)); check(RescueDiagnostics.report(ctx,supervisor).contains("中 error=timeout"))
 BuildMeta.text="metadata ".repeat(6000)
 log.writeText("diagnostic line\n".repeat(4000))
 UserDataPermissions.metadata="uid=0 mode=0600 label=metadata ".repeat(2000)+" password=metadata-secret"
 val capped=RescueDiagnostics.report(ctx,supervisor)
 check(capped.length==48*1024 && capped.endsWith("[output truncated]\n") && !capped.contains("metadata-secret"))
 BuildMeta.text="build-metadata"; UserDataPermissions.metadata="uid=0 gid=0 mode=0600 read=false"
 SessionDataPermissions.metadata="session-metadata ".repeat(2000)+" password=session-metadata-secret"
 CredentialsLockRecovery.metadata="pid=12345 alive=false ".repeat(2000)+" api_key=lock-metadata-secret"
 val bootCapped=RescueDiagnostics.report(ctx,supervisor)
 check(bootCapped.length==48*1024 && bootCapped.endsWith("[output truncated]\n") && bootCapped.contains("Session data permissions (metadata only)") && bootCapped.contains("pid=12345 alive=false"))
 check(!bootCapped.contains("session-metadata-secret") && !bootCapped.contains("lock-metadata-secret"))
 SessionDataPermissions.metadata="home/sessions uid=0 gid=0 mode=0700"
 CredentialsLockRecovery.metadata="home/.credentials.lock pid=12345 alive=false"
 log.delete(); check(RescueDiagnostics.report(ctx,supervisor).contains("[missing]"))
 try {
  java.nio.file.Files.createSymbolicLink(log.toPath(), credential.toPath())
  val symlinkReport=RescueDiagnostics.report(ctx,supervisor)
  check(symlinkReport.contains("symlink/outside") && !symlinkReport.contains("CREDENTIAL_FILE_MUST_NOT_BE_READ"))
  log.delete()
  println("PASS: credential symlink refused")
 } catch (_: java.nio.file.FileSystemException) {
  println("SKIP: symlink behavior (host cannot create symlinks)")
 } catch (_: UnsupportedOperationException) {
  println("SKIP: symlink behavior (unsupported filesystem)")
 }
 app.kxxy.MainHarness().runTests()
 println("PASS: production redact vectors, JSON/short secrets, real-provider priority, bounded read-only metadata/mode report, Main decision/notification bodies")
 println("TOTAL PASS assertions "+app.kxxy.testing.count)
}
`)
  command(['-Xmx256m', '-cp', dependencies.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', dependencies[1], '-d', join(temp, 'classes'), ...files, join(src, 'WebViewGate.kt'), join(src, 'engine/RescueDiagnostics.kt')])
  command(['-cp', [join(temp, 'classes'), dependencies[1]].join(delimiter), 'TestKt', temp])
} finally { rmSync(temp, { recursive: true, force: true }) }
