// Real host behavior tests: compile the production recovery Kotlin against minimal Android/config stubs.
// No Gradle/APK build. Uses existing Kotlin cache; JSON dependency is downloaded into its own empty temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = process.env.KOTLIN_CACHE || path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1');
function jar(folder, version) {
  const base = path.join(cache, folder, version);
  const found = fs.readdirSync(base).flatMap(h => fs.readdirSync(path.join(base,h)).filter(n=>n.endsWith('.jar')).map(n=>path.join(base,h,n)));
  if (!found.length) throw new Error(`No jar under ${base}`);
  return found[0];
}
const java = process.env.KXXY_JAVA || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME,'bin/java.exe') : 'C:/Program Files/Eclipse Adoptium/jdk-21.0.13.9-hotspot/bin/java.exe');
const sep = path.delimiter;
const std = jar('org.jetbrains.kotlin/kotlin-stdlib','1.9.24');
const annotations = jar('org.jetbrains/annotations','13.0');
const compiler = [jar('org.jetbrains.kotlin/kotlin-compiler-embeddable','1.9.24'),std,
  jar('org.jetbrains.kotlin/kotlin-reflect','1.9.24'), jar('org.jetbrains.kotlin/kotlin-script-runtime','1.9.24'),
  jar('org.jetbrains.intellij.deps/trove4j','1.0.20200330'),annotations].join(sep);
const coroutines = jar('org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm','1.8.1');
const deps = fs.mkdtempSync(path.join(os.tmpdir(),'kxxy-recovery-deps-'));
const json = path.join(deps,'json.jar');
console.log(`Compiling production recovery sources; test workspace will be retained.`);
if (process.env.JSON_JAR) fs.copyFileSync(process.env.JSON_JAR,json);
else {
  const response = await fetch('https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar');
  if (!response.ok) throw new Error(`JSON download failed: ${response.status}`);
  fs.writeFileSync(json,Buffer.from(await response.arrayBuffer()));
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'kxxy-recovery-test-'));
const runtimeCP = [std,annotations,coroutines,json].join(sep);
const write = (name,text) => { const target=path.join(temp,name); fs.writeFileSync(target,text); return target; };
const stubs = [
write('Context.kt',`package android.content
import java.io.File
class Context(val filesDir: File)
`),
write('Log.kt',`package android.util
object Log { fun i(tag:String, text:String):Int=0; fun w(tag:String,text:String):Int=0 }
`),
write('EngineConfig.kt',`package app.kxxy.engine
import android.content.Context
import java.io.File
object EngineConfig {
 const val DEFAULT_PORT=3080
 var nodePath=""; var entryPath=""; var mode="pass"
 val CORE_BUNDLES=listOf("@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-web-mobile")
 fun isCoreBundle(n:String)=n in CORE_BUNDLES
 fun nodeBin(c:Context)=File(nodePath)
 fun dshEntry(c:Context)=File(entryPath)
 fun dshHome(c:Context)=File(c.filesDir,"kxxy-home")
 fun profileDir(c:Context)=File(dshHome(c),"profiles/web")
 fun profileManifestFile(c:Context)=File(profileDir(c),"package.json")
 fun profilePatchFile(c:Context)=File(profileDir(c),"cordis.patch.yml")
 fun homePatchFile(c:Context)=File(dshHome(c),"cordis.patch.yml")
 fun overlayFile(c:Context)=File(c.filesDir,"engine/android-overlay.yml")
 fun profileModulesDir(c:Context)=File(profileDir(c),"node_modules")
 fun recoveryRoot(c:Context)=File(c.filesDir,"kxxy-recovery")
 fun workspaces(c:Context)=File(dshHome(c),"workspaces")
 fun readPrivMode(c:Context)="normal"
 fun overlayContent(c:Context)="generated-overlay\\n"
 fun minimalProfileManifest()="{\\\"dsh\\\":{\\\"profile\\\":{\\\"bundles\\\":[\\\"@deepseek-ai/dsh-base\\\",\\\"@deepseek-ai/dsh-web-app\\\",\\\"dsh-web-mobile\\\"]}}}"
 fun buildEnv(c:Context,p:Int,m:String)=System.getenv().map { it.key+"="+it.value } + listOf("PROBE_MODE="+mode,"USER_HOME="+dshHome(c).absolutePath,"PROFILE_PATCH="+profilePatchFile(c).absolutePath,"HOME_PATCH="+homePatchFile(c).absolutePath,"OVERLAY="+overlayFile(c).absolutePath)
}
class RuntimeInstaller(val ctx:Context) {
 companion object { var calls=0; var fail=false; @Volatile var block=false; @Volatile var entered=false }
 fun forceReinstall(progress:(Float)->Unit) {
  check(EngineConfig.recoveryRoot(ctx).listFiles()!!.any { File(it,"manifest.json").readText().contains("runtimeReinstall") })
  calls++; if(fail) error("injected installer failure")
  entered=true
  if(block) while(true) { Thread.sleep(50); progress(0.3f) }
  for(i in 0..10) progress(i/10f)
 }
}
`),
write('UserDataPermissions.kt',`package app.kxxy.engine
import android.content.Context
object UserDataPermissions {
 data class Outcome(val success:Boolean, val changes:List<String>, val detail:String, val needsRoot:Boolean=false)
 var currentIssue:String?=null; var laterIssue:String?=null; var issueCalls=0
 val authorizations=mutableListOf<Boolean>()
 var outcome=Outcome(true, emptyList(), "metadata already healthy")
 fun reset() { currentIssue=null; laterIssue=null; issueCalls=0; authorizations.clear(); outcome=Outcome(true, emptyList(), "metadata already healthy") }
 fun issue(ctx:Context):String? { issueCalls++; return currentIssue ?: if(issueCalls>1) laterIssue else null }
 fun report(ctx:Context)="uid=0 gid=0 mode=0600 read=false"
 suspend fun repair(ctx:Context, allowRoot:Boolean=false):Outcome { authorizations+=allowRoot; return outcome }
}
object BootDataCalls { val repairs=mutableListOf<String>() }
object SessionDataPermissions {
 var currentIssue:String?=null; var laterIssue:String?=null; var issueCalls=0
 val authorizations=mutableListOf<Boolean>()
 var outcome=UserDataPermissions.Outcome(true, emptyList(), "sessions metadata healthy")
 fun reset() { currentIssue=null; laterIssue=null; issueCalls=0; authorizations.clear(); BootDataCalls.repairs.clear(); outcome=UserDataPermissions.Outcome(true, emptyList(), "sessions metadata healthy") }
 fun issue(ctx:Context):String? { issueCalls++; return currentIssue ?: if(issueCalls>1) laterIssue else null }
 fun report(ctx:Context)="home/sessions uid=0 gid=0 mode=0700 read=false"
 suspend fun repair(ctx:Context, allowRoot:Boolean=false):UserDataPermissions.Outcome { BootDataCalls.repairs+="sessions"; authorizations+=allowRoot; return outcome }
}
object CredentialsLockRecovery {
 var currentIssue:String?=null; var laterIssue:String?=null; var issueCalls=0
 val authorizations=mutableListOf<Pair<Boolean,Boolean>>()
 var outcome=UserDataPermissions.Outcome(true, emptyList(), "credentials lock healthy")
 fun reset() { currentIssue=null; laterIssue=null; issueCalls=0; authorizations.clear(); outcome=UserDataPermissions.Outcome(true, emptyList(), "credentials lock healthy") }
 fun issue(ctx:Context):String? { issueCalls++; return currentIssue ?: if(issueCalls>1) laterIssue else null }
 fun report(ctx:Context)="home/.credentials.lock uid=0 gid=0 mode=0600 pid=12345 alive=false"
 suspend fun repair(ctx:Context, allowRoot:Boolean=false, writersStopped:Boolean=false):UserDataPermissions.Outcome { BootDataCalls.repairs+="lock"; authorizations+=allowRoot to writersStopped; return outcome }
}
`),
];
const child=write('child.mjs',`import fs from 'node:fs';
const mode=process.env.PROBE_MODE||process.argv[2];
if(mode==='hang'){fs.writeFileSync(process.argv[3],String(process.pid));setInterval(()=>{},1000);}
else if(mode==='flood'){for(let i=0;i<512;i++){process.stdout.write('O'.repeat(8192));process.stderr.write('E'.repeat(8192));}process.stderr.write('\\nError: tail-evidence\\n');}
else if(mode==='parse-profile'){console.error('Error: dsh: failed to parse overlay '+process.env.PROFILE_PATCH+': YAMLException');process.exitCode=1;}
else if(mode==='parse-home'){console.error('Error: dsh: failed to parse overlay '+process.env.HOME_PATCH+': YAMLException');process.exitCode=1;}
else if(mode==='ambiguous'){console.error('Error: failed to parse overlay');process.exitCode=1;}
else if(mode==='path-only'){console.error('Error: something failed '+process.env.PROFILE_PATCH);process.exitCode=1;}
else if(mode==='path-prefix'){console.error('Error: failed to parse overlay '+process.env.PROFILE_PATCH+'.extra');process.exitCode=1;}
else if(mode==='environment'){console.error('Error: EACCES failed to parse overlay '+process.env.PROFILE_PATCH);process.exitCode=1;}
else if(mode==='credentials-access'){console.error('Error: EACCES: permission denied, open '+process.env.USER_HOME+'/.credentials.yaml');process.exitCode=1;}
else if(mode==='storage-access'){console.error('Error: EACCES: permission denied, open '+process.env.USER_HOME+'/storages/workspace.json');process.exitCode=1;}
else if(mode==='session-access'){console.error('Error: EACCES: permission denied, open '+process.env.USER_HOME+'/sessions/current.json');process.exitCode=1;}
else if(mode==='lock-timeout'){console.error('Error: credentials.lock timeout');process.exitCode=1;}
else if(mode==='full-lock-timeout' && process.argv.includes('--dump-config')){console.error('Error: credentials.lock timeout');process.exitCode=1;}
else if(mode==='bundle'){console.error('Error: failed to load bundle third-party');process.exitCode=1;}
else {console.log('{}');}
`);
const tests=write('RecoveryBehavior.kt',`package app.kxxy.engine
import android.content.Context
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

private var count=0
private fun passed(name:String) { count++; println("PASS "+name) }
fun main(args:Array<String>)=runBlocking {
 val node=args[0]; val child=args[1]; val scratch=File(args[2]); scratch.mkdirs()
 EngineConfig.nodePath=node; EngineConfig.entryPath=child
 fun fresh(name:String):Context {
  val c=Context(File(scratch,name).apply{mkdirs()})
  EngineConfig.profileDir(c).mkdirs(); EngineConfig.overlayFile(c).parentFile!!.mkdirs()
  EngineConfig.profileManifestFile(c).writeText(EngineConfig.minimalProfileManifest())
  EngineConfig.profilePatchFile(c).writeText("- id: valid-profile\\n")
  EngineConfig.homePatchFile(c).writeText("- id: valid-home\\n")
  EngineConfig.overlayFile(c).writeText("old-overlay\\n")
  EngineConfig.mode="pass"; UserDataPermissions.reset(); SessionDataPermissions.reset(); CredentialsLockRecovery.reset()
  return c
 }
 fun manifest(c:Context, names:List<String>) {
  EngineConfig.profileManifestFile(c).writeText(JSONObject(EngineConfig.minimalProfileManifest()).also {
   it.getJSONObject("dsh").getJSONObject("profile").put("bundles",org.json.JSONArray(EngineConfig.CORE_BUNDLES+names)); it.put("credential","keep-secret")
  }.toString())
 }
 fun snapshot(c:Context)=listOf(EngineConfig.profileManifestFile(c),EngineConfig.profilePatchFile(c),EngineConfig.homePatchFile(c),EngineConfig.overlayFile(c)).map{it.readText()}
 val flood=RecoveryProcessRunner.run(ProcessBuilder(node,child,"flood"),15000,16384)
 check(flood.ok && flood.truncated && flood.text.length<17000 && flood.text.contains("tail-evidence")) { "flood status="+flood.status+" exit="+flood.exitCode+" truncated="+flood.truncated+" length="+flood.text.length+" tail="+flood.text.takeLast(300) }; passed("concurrent stdout/stderr drain and bounded tail capture")
 val pid=File(scratch,"timeout.pid")
 val started=System.nanoTime()
 val timeout=RecoveryProcessRunner.run(ProcessBuilder(node,child,"hang",pid.absolutePath),8000,4096)
 check(timeout.status==RecoveryProcessRunner.Status.TIMED_OUT && TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<12000) { "timeout status="+timeout+" elapsed="+TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started) }
 delay(200); check(!ProcessHandle.of(pid.readText().toLong()).map{it.isAlive}.orElse(false)); passed("real timeout terminates silent child")
 val cancelPid=File(scratch,"cancel.pid")
 val job=launch(Dispatchers.IO) { RecoveryProcessRunner.run(ProcessBuilder(node,child,"hang",cancelPid.absolutePath),30000) }
 withTimeout(5000) { while(!cancelPid.exists()) delay(10) }; job.cancelAndJoin(); delay(200)
 check(!ProcessHandle.of(cancelPid.readText().toLong()).map{it.isAlive}.orElse(false)); passed("cancellation terminates child and propagates")
 val probe=fresh("probe")
 val healthy=RecoveryProbe(probe).diagnose()
 check(healthy.target==RecoveryManager.Target.RETRY && healthy.checks.single {it.code=="E"}.verdict==RecoveryProbe.Verdict.MISS && healthy.checks.single {it.code=="F"}.verdict==RecoveryProbe.Verdict.MISS)
 check(!EngineConfig.workspaces(probe).exists()); passed("diagnose success is RETRY and does not create workspace")
 for(path in listOf(".credentials.yaml","storages/workspace.json")) {
  UserDataPermissions.reset(); UserDataPermissions.currentIssue="home/"+path+" uid=0 gid=0 mode=0600 read=false"
  val before=snapshot(probe); val d=RecoveryProbe(probe).diagnose()
  check(d.target==RecoveryManager.Target.USER_DATA_PERMISSIONS && d.recommended==RecoveryManager.Level.L1 && d.detail.contains(path))
  check(d.checks.single {it.code=="E"}.verdict==RecoveryProbe.Verdict.HIT && snapshot(probe)==before && UserDataPermissions.authorizations.isEmpty())
  passed("current metadata selects L1 user-data permission target "+path)
 }
 UserDataPermissions.reset(); UserDataPermissions.laterIssue="storages/workspace.json read=false"
 val afterDump=RecoveryProbe(probe).diagnose()
 check(afterDump.target==RecoveryManager.Target.USER_DATA_PERMISSIONS && afterDump.checks.single {it.code=="A"}.verdict==RecoveryProbe.Verdict.MISS)
 passed("successful config dumps still detect unreadable user data")
 UserDataPermissions.reset(); EngineConfig.mode="credentials-access"; UserDataPermissions.laterIssue=".credentials.yaml read=false"
 check(RecoveryProbe(probe).diagnose().target==RecoveryManager.Target.USER_DATA_PERMISSIONS)
 passed("native error with current metadata selects user-data permission target")
 UserDataPermissions.reset(); EngineConfig.mode="pass"
 val native=File(EngineConfig.overlayFile(probe).parentFile,"native-boot-failure.json")
 for(path in listOf(".credentials.yaml","storages/workspace.json")) {
  val stale="{\\\"reason\\\":\\\"Error: EACCES: permission denied, open "+EngineConfig.dshHome(probe).absolutePath.replace("\\\\","/")+"/"+path+"\\\"}"
  native.writeText(stale)
  repeat(2) { check(RecoveryProbe(probe).diagnose().target==RecoveryManager.Target.RETRY) }
  check(native.readText()==stale && UserDataPermissions.authorizations.isEmpty())
  passed("healthy metadata ignores stale native EACCES "+path)
 }
 for(mode in listOf("credentials-access","storage-access")) {
  UserDataPermissions.reset(); EngineConfig.mode=mode
  check(RecoveryProbe(probe).diagnose().target==RecoveryManager.Target.ENVIRONMENT)
  passed("fixed-path EACCES without current metadata cannot authorize permission repair "+mode)
 }
 UserDataPermissions.reset()
 fun resetDataIssues() { UserDataPermissions.reset(); SessionDataPermissions.reset(); CredentialsLockRecovery.reset(); EngineConfig.mode="pass" }
 val probeBefore=snapshot(probe)
 val sessionFile=File(EngineConfig.dshHome(probe),"sessions/current.json").apply { parentFile!!.mkdirs(); writeText("SESSION_CONTENT_KEEP") }
 val credentialsFile=File(EngineConfig.dshHome(probe),".credentials.yaml").apply { writeText("CREDENTIAL_CONTENT_KEEP") }
 val lockFile=File(EngineConfig.dshHome(probe),".credentials.lock").apply { writeText("LOCK_CONTENT_KEEP") }
 val bootFiles=listOf(sessionFile,credentialsFile,lockFile)
 val bootBefore=bootFiles.map { it.readBytes().toList() }
 for(sessionIssue in listOf(true,false)) {
  resetDataIssues()
  if(sessionIssue) SessionDataPermissions.currentIssue="home/sessions/current.json EACCES read=false"
  else CredentialsLockRecovery.currentIssue="home/.credentials.lock pid=12345 stale=true"
  val bootDiagnosis=RecoveryProbe(probe).diagnose()
  check(bootDiagnosis.target==RecoveryManager.Target.BOOT_DATA && bootDiagnosis.recommended==RecoveryManager.Level.L1)
  check(bootDiagnosis.checks.single {it.code=="F"}.verdict==RecoveryProbe.Verdict.HIT)
  check(SessionDataPermissions.issueCalls==1 && CredentialsLockRecovery.issueCalls==if(sessionIssue) 0 else 1)
  check(snapshot(probe)==probeBefore && bootFiles.map { it.readBytes().toList() }==bootBefore && BootDataCalls.repairs.isEmpty())
  passed("current metadata selects read-only BOOT_DATA "+if(sessionIssue) "session permissions" else "credentials lock")
  resetDataIssues()
  if(sessionIssue) SessionDataPermissions.laterIssue="home/sessions/current.json read=false"
  else CredentialsLockRecovery.laterIssue="home/.credentials.lock stale=true"
  val laterBoot=RecoveryProbe(probe).diagnose()
  check(laterBoot.target==RecoveryManager.Target.BOOT_DATA && laterBoot.checks.single {it.code=="A"}.verdict==RecoveryProbe.Verdict.MISS && laterBoot.checks.single {it.code=="F"}.verdict==RecoveryProbe.Verdict.HIT)
  passed("successful dumps veto false RETRY with later "+if(sessionIssue) "session issue" else "lock issue")
 }
 resetDataIssues(); UserDataPermissions.currentIssue=".credentials.yaml read=false"; SessionDataPermissions.currentIssue="sessions read=false"; CredentialsLockRecovery.currentIssue="lock stale=true"
 check(RecoveryProbe(probe).diagnose().target==RecoveryManager.Target.USER_DATA_PERMISSIONS && SessionDataPermissions.issueCalls==0 && CredentialsLockRecovery.issueCalls==0)
 passed("fixed credentials/storage permissions retain priority over boot-data issues")
 resetDataIssues(); SessionDataPermissions.currentIssue="sessions read=false"; CredentialsLockRecovery.currentIssue="lock stale=true"
 check(RecoveryProbe(probe).diagnose().detail=="sessions read=false" && CredentialsLockRecovery.issueCalls==0)
 passed("session issue has priority over credentials lock")
 for(mode in listOf("session-access","lock-timeout","full-lock-timeout")) {
  resetDataIssues(); EngineConfig.mode=mode
  if(mode=="session-access") SessionDataPermissions.laterIssue="sessions read=false" else CredentialsLockRecovery.laterIssue="lock stale=true"
  val failedBoot=RecoveryProbe(probe).diagnose()
  check(failedBoot.target==RecoveryManager.Target.BOOT_DATA && failedBoot.checks.single {it.code=="F"}.verdict==RecoveryProbe.Verdict.HIT)
  check(failedBoot.checks.single {it.code=="B"}.verdict==if(mode=="full-lock-timeout") RecoveryProbe.Verdict.MISS else RecoveryProbe.Verdict.UNKNOWN)
  passed("failed dump rechecks current boot metadata "+mode)
 }
 resetDataIssues()
 for(reason in listOf("session EACCES","credentials.lock timeout")) {
  val stale="{\\\"reason\\\":\\\""+reason+"\\\"}"
  native.writeText(stale)
  repeat(2) { check(RecoveryProbe(probe).diagnose().target==RecoveryManager.Target.RETRY) }
  check(native.readText()==stale && BootDataCalls.repairs.isEmpty())
  passed("healthy current metadata ignores stale native boot log "+reason)
 }
 for((mode,target) in listOf("session-access" to RecoveryManager.Target.ENVIRONMENT,"lock-timeout" to RecoveryManager.Target.UNKNOWN)) {
  resetDataIssues(); EngineConfig.mode=mode
  check(RecoveryProbe(probe).diagnose().target==target && BootDataCalls.repairs.isEmpty())
  passed("boot error text alone cannot authorize BOOT_DATA "+mode)
 }
 resetDataIssues()
 for ((mode,target) in listOf("parse-profile" to RecoveryManager.Target.PROFILE_PATCH,"parse-home" to RecoveryManager.Target.HOME_PATCH,"ambiguous" to RecoveryManager.Target.UNKNOWN,"path-only" to RecoveryManager.Target.UNKNOWN,"path-prefix" to RecoveryManager.Target.UNKNOWN,"environment" to RecoveryManager.Target.ENVIRONMENT,"bundle" to RecoveryManager.Target.BUNDLES)) {
  EngineConfig.mode=mode; check(RecoveryProbe(probe).diagnose().target==target) { mode }; passed("diagnosis evidence "+mode)
 }
 val no=fresh("no-op"); val noBefore=snapshot(no); val nm=RecoveryManager(no)
 for(t in listOf(RecoveryManager.Target.RETRY,RecoveryManager.Target.UNKNOWN,RecoveryManager.Target.ENVIRONMENT)) check(nm.recover(RecoveryManager.Level.L3,target=t).changes.isEmpty())
 check(snapshot(no)==noBefore && !EngineConfig.recoveryRoot(no).exists()); passed("RETRY UNKNOWN ENVIRONMENT are zero writes")
 val permissions=fresh("permissions"); manifest(permissions,listOf("third-party"))
 val permissionBefore=snapshot(permissions); val pm=RecoveryManager(permissions)
 UserDataPermissions.currentIssue=".credentials.yaml uid=0 mode=0600 read=false"
 UserDataPermissions.outcome=UserDataPermissions.Outcome(false, emptyList(), "Root repair needs confirmation", needsRoot=true)
 val denied=pm.recover(RecoveryManager.Level.L3,target=RecoveryManager.Target.USER_DATA_PERMISSIONS)
 check(!denied.success && denied.needsRoot && !denied.undoable && !denied.needsNetwork && denied.target==RecoveryManager.Target.USER_DATA_PERMISSIONS)
 check(UserDataPermissions.authorizations==listOf(false) && denied.changes.isEmpty() && denied.detail=="Root repair needs confirmation")
 check(snapshot(permissions)==permissionBefore && !EngineConfig.recoveryRoot(permissions).exists())
 passed("permission recovery defaults to no Root and preserves config/bundles without journal")
 val manualPermissions=pm.recover(RecoveryManager.Level.L3,allowRoot=true)
 check(manualPermissions.needsRoot && UserDataPermissions.authorizations==listOf(false,false) && snapshot(permissions)==permissionBefore)
 passed("manual observed permissions cannot reuse Root authorization")
 UserDataPermissions.outcome=UserDataPermissions.Outcome(true, listOf("fixed metadata only"), "healthy after repair")
 val authorized=pm.recover(RecoveryManager.Level.L3,target=RecoveryManager.Target.USER_DATA_PERMISSIONS,allowRoot=true)
 check(authorized.success && !authorized.needsRoot && !authorized.undoable && !authorized.needsNetwork && authorized.changes==listOf("fixed metadata only") && authorized.detail=="healthy after repair")
 check(UserDataPermissions.authorizations==listOf(false,false,true) && snapshot(permissions)==permissionBefore && !EngineConfig.recoveryRoot(permissions).exists() && pm.backupCount()==0)
 passed("explicit permission target forwards Root consent and Outcome with no config transaction")
 UserDataPermissions.reset()
 check(!RecoveryManager.Result(RecoveryManager.Level.L1,EngineConfig.recoveryRoot(no),emptyList()).needsRoot)
 passed("recovery Result needsRoot defaults false")
 val boot=fresh("boot-recovery"); manifest(boot,listOf("third-party"))
 val bm=RecoveryManager(boot); val coreBefore=snapshot(boot)
 val bootSession=File(EngineConfig.dshHome(boot),"sessions/current.json").apply { parentFile!!.mkdirs(); writeText("SESSION_KEEP") }
 val bootCredential=File(EngineConfig.dshHome(boot),".credentials.yaml").apply { writeText("CREDENTIAL_KEEP") }
 val bootLock=File(EngineConfig.dshHome(boot),".credentials.lock").apply { writeText("LOCK_KEEP") }
 val managedData=listOf(bootSession,bootCredential,bootLock); val managedBefore=managedData.map { it.readBytes().toList() }
 fun preservedBoot() {
  check(snapshot(boot)==coreBefore && managedData.map { it.readBytes().toList() }==managedBefore)
  check(!EngineConfig.recoveryRoot(boot).exists() && bm.backupCount()==0)
 }
 for(explicit in listOf(true,false)) {
  resetDataIssues(); SessionDataPermissions.currentIssue="sessions read=false"
  val refusal=bm.recover(RecoveryManager.Level.L3,target=if(explicit) RecoveryManager.Target.BOOT_DATA else null,allowRoot=true)
  check(!refusal.success && refusal.target==RecoveryManager.Target.BOOT_DATA && !refusal.undoable && !refusal.needsNetwork && refusal.changes.isEmpty())
  check(SessionDataPermissions.authorizations.isEmpty() && CredentialsLockRecovery.authorizations.isEmpty() && BootDataCalls.repairs.isEmpty()); preservedBoot()
  passed("BOOT_DATA default writersStopped=false refuses helpers "+if(explicit) "explicit target" else "legacy observed target")
 }
 resetDataIssues()
 val falseStopped=bm.recover(RecoveryManager.Level.L1,"",RecoveryManager.Target.BOOT_DATA,true,false)
 check(!falseStopped.success && BootDataCalls.repairs.isEmpty()); preservedBoot()
 passed("BOOT_DATA fifth positional false never changes boot data")
 resetDataIssues()
 SessionDataPermissions.outcome=UserDataPermissions.Outcome(false,listOf("session metadata partial"),"session repair denied",needsRoot=true)
 val sessionDenied=bm.recover(RecoveryManager.Level.L3,target=RecoveryManager.Target.BOOT_DATA,writersStopped=true)
 check(!sessionDenied.success && sessionDenied.needsRoot && sessionDenied.changes==listOf("session metadata partial") && sessionDenied.detail=="session repair denied")
 check(!sessionDenied.undoable && !sessionDenied.needsNetwork && SessionDataPermissions.authorizations==listOf(false) && CredentialsLockRecovery.authorizations.isEmpty() && BootDataCalls.repairs==listOf("sessions")); preservedBoot()
 passed("session repair failure propagates Outcome and never calls lock repair")
 for(explicit in listOf(false,true)) {
  resetDataIssues(); CredentialsLockRecovery.currentIssue="credentials lock stale=true"
  SessionDataPermissions.outcome=UserDataPermissions.Outcome(true,listOf("session metadata fixed"),"sessions healthy")
  CredentialsLockRecovery.outcome=UserDataPermissions.Outcome(true,listOf("stale lock removed"),"lock healthy")
  val recovered=bm.recover(RecoveryManager.Level.L3,target=if(explicit) RecoveryManager.Target.BOOT_DATA else null,allowRoot=true,writersStopped=true)
  check(recovered.success && recovered.target==RecoveryManager.Target.BOOT_DATA && !recovered.needsRoot && !recovered.undoable && !recovered.needsNetwork)
  check(recovered.changes==listOf("session metadata fixed","stale lock removed") && recovered.detail=="sessions healthy\\nlock healthy")
  check(SessionDataPermissions.authorizations==listOf(explicit) && CredentialsLockRecovery.authorizations==listOf(explicit to true) && BootDataCalls.repairs==listOf("sessions","lock")); preservedBoot()
  passed("writers stopped boot recovery is serial and Root is "+if(explicit) "explicitly authorized" else "not inherited by legacy calls")
 }
 resetDataIssues()
 val defaultRoot=bm.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.BOOT_DATA,writersStopped=true)
 check(defaultRoot.success && SessionDataPermissions.authorizations==listOf(false) && CredentialsLockRecovery.authorizations==listOf(false to true)); preservedBoot()
 passed("explicit BOOT_DATA with writers stopped still defaults to no Root")
 resetDataIssues()
 SessionDataPermissions.outcome=UserDataPermissions.Outcome(true,listOf("session metadata fixed"),"sessions healthy")
 CredentialsLockRecovery.outcome=UserDataPermissions.Outcome(false,emptyList(),"live lock refused",needsRoot=true)
 val lockDenied=bm.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.BOOT_DATA,allowRoot=true,writersStopped=true)
 check(!lockDenied.success && lockDenied.needsRoot && lockDenied.changes==listOf("session metadata fixed") && lockDenied.detail.contains("live lock refused") && !lockDenied.undoable && !lockDenied.needsNetwork)
 check(BootDataCalls.repairs==listOf("sessions","lock")); preservedBoot()
 passed("credentials lock failure retains session Outcome without config transaction")
 resetDataIssues()
 for(t in listOf(RecoveryManager.Target.PROFILE_PATCH,RecoveryManager.Target.HOME_PATCH,RecoveryManager.Target.OVERLAY,RecoveryManager.Target.MANIFEST)) {
  val c=fresh("target-"+t); if(t==RecoveryManager.Target.MANIFEST) manifest(c,listOf("third-party")); val before=snapshot(c); val m=RecoveryManager(c)
  val r=m.recover(RecoveryManager.Level.L3,target=t); check(r.success && r.undoable)
  val files=listOf(EngineConfig.profileManifestFile(c),EngineConfig.profilePatchFile(c),EngineConfig.homePatchFile(c),EngineConfig.overlayFile(c))
  val selected=when(t){RecoveryManager.Target.PROFILE_PATCH->1; RecoveryManager.Target.HOME_PATCH->2; RecoveryManager.Target.OVERLAY->3;else->0}
  files.forEachIndexed { i,f-> if(i!=selected)check(f.readText()==before[i]) }
  check(m.undoLatest()); check(snapshot(c)==before); passed("precise target and full undo "+t)
 }
 val missing=fresh("missing-manifest"); EngineConfig.profileManifestFile(missing).delete(); val mm=RecoveryManager(missing)
 check(mm.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.MANIFEST).success && mm.undoLatest()); check(!EngineConfig.profileManifestFile(missing).exists()); passed("undo newly created manifest restores absence")
 val corrupt=fresh("corrupt-manifest"); EngineConfig.profileManifestFile(corrupt).writeText("broken"); val cm=RecoveryManager(corrupt)
 check(cm.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.MANIFEST).success && cm.undoLatest()); check(EngineConfig.profileManifestFile(corrupt).readText()=="broken"); passed("undo preserves exact corrupt original rather than guessing")
 val conflict=fresh("conflict"); val mconf=RecoveryManager(conflict); val rc=mconf.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.OVERLAY)
 EngineConfig.overlayFile(conflict).writeText("user-change"); check(!mconf.undoLatest()); check(EngineConfig.overlayFile(conflict).readText()=="user-change" && rc.backupDir.exists() && mconf.lastUndoDetail.isNotBlank()); passed("overlay undo conflict returns false and retains backup")
 val movedConflict=fresh("move-conflict");val mcm=RecoveryManager(movedConflict); val rcm=mcm.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.PROFILE_PATCH)
 EngineConfig.profilePatchFile(movedConflict).writeText("new-patch"); check(!mcm.undoLatest()); check(rcm.backupDir.listFiles()!!.any{it.name.endsWith("cordis.patch.yml")}); passed("move undo conflict retains old and new patches")
 val escalation=fresh("escalation"); manifest(escalation,listOf("@scope/plugin")); val pkg=File(EngineConfig.profileModulesDir(escalation),"@scope/plugin");pkg.mkdirs();File(pkg,"index.js").writeText("plugin")
 val em=RecoveryManager(escalation);val original=snapshot(escalation)
 val l1=em.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.BUNDLES);check(l1.success && pkg.exists())
 val l2=em.recover(RecoveryManager.Level.L2,target=RecoveryManager.Target.BUNDLES);check(l2.success && !pkg.exists() && l1.backupDir!=l2.backupDir)
 check(em.undoLatest() && pkg.exists());check(em.undoLatest() && snapshot(escalation)==original);passed("L1 to L2 reuses original package names and both undo")
 val whole=fresh("whole"); val mods=EngineConfig.profileModulesDir(whole);mods.mkdirs();File(mods,"keep").writeText("bytes");val wm=RecoveryManager(whole)
 val wr=wm.recover(RecoveryManager.Level.L3,target=RecoveryManager.Target.BUNDLES);check(wr.success && !mods.exists());check(wm.undoLatest() && File(mods,"keep").readText()=="bytes");passed("L3 whole directory journal and undo")
 val manual=fresh("manual");manifest(manual,listOf("third-party"));val validProfile=EngineConfig.profilePatchFile(manual).readText();val validHome=EngineConfig.homePatchFile(manual).readText()
 check(RecoveryManager(manual).recover(RecoveryManager.Level.L1).success);check(EngineConfig.profilePatchFile(manual).readText()==validProfile && EngineConfig.homePatchFile(manual).readText()==validHome);passed("legacy manual recovery retains valid patches")
 val invalid=fresh("invalid-package");manifest(invalid,listOf("../../outside"));val badBefore=snapshot(invalid);val bad=RecoveryManager(invalid).recover(RecoveryManager.Level.L2,target=RecoveryManager.Target.BUNDLES);check(!bad.success && snapshot(invalid)==badBefore);passed("path traversal package rejected before config modification")
 val runtime=fresh("runtime");val rtBefore=snapshot(runtime);val rm=RecoveryManager(runtime);val rr=rm.recover(RecoveryManager.Level.L3,target=RecoveryManager.Target.RUNTIME)
 check(rr.success && !rr.undoable && RuntimeInstaller.calls==1 && rm.backupCount()==0 && !rm.undoLatest() && snapshot(runtime)==rtBefore);passed("runtime invokes force API after durable non-undoable record")
 RuntimeInstaller.fail=true;check(!rm.recover(RecoveryManager.Level.L3,target=RecoveryManager.Target.RUNTIME).success && rm.backupCount()==0);RuntimeInstaller.fail=false;passed("runtime failure has no false undo entry")
 RuntimeInstaller.block=true;RuntimeInstaller.entered=false
 val rjob=launch(Dispatchers.IO){rm.recover(RecoveryManager.Level.L3,target=RecoveryManager.Target.RUNTIME)}
 withTimeout(5000){while(!RuntimeInstaller.entered)delay(10)};withTimeout(5000){rjob.cancelAndJoin()};RuntimeInstaller.block=false
 val rtJournal=JSONObject(File(rm.latestRecord()!!.dir,"manifest.json").readText());check(rtJournal.getString("status")=="failed" && !rtJournal.getBoolean("undoable"));passed("runtime cancellation interrupts installer and retains failed non-undoable record")
 val many=fresh("many");val manyManager=RecoveryManager(many);val ids=mutableSetOf<String>()
 repeat(8){ EngineConfig.overlayFile(many).writeText("old-"+it); ids+=manyManager.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.OVERLAY).backupDir.name }
 check(ids.size==8 && manyManager.backupCount()==8 && ids.all{File(EngineConfig.recoveryRoot(many),it).exists()});passed("unique rapid transaction IDs and no pruning of live backups")
 val manifestConflict=fresh("manifest-conflict");manifest(manifestConflict,listOf("third"));val mcf=RecoveryManager(manifestConflict);val mcfr=mcf.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.BUNDLES)
 EngineConfig.profileManifestFile(manifestConflict).writeText("new-user-json");check(!mcf.undoLatest() && EngineConfig.profileManifestFile(manifestConflict).readText()=="new-user-json" && mcfr.backupDir.exists());passed("manifest undo conflict does not overwrite user edits")
 val outside=File(scratch,"outside").apply{mkdirs()};File(outside,"precious").writeText("KEEP")
 try {
  val realAlias=fresh("real-alias-root"); val aliasRoot=File(scratch,"system-files-alias");Files.createSymbolicLink(aliasRoot.toPath(),realAlias.filesDir.toPath());val aliasCtx=Context(aliasRoot);val aliasManager=RecoveryManager(aliasCtx)
  check(aliasManager.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.OVERLAY).success && aliasManager.undoLatest());check(EngineConfig.overlayFile(realAlias).readText()=="old-overlay\\n");passed("trusted filesDir system alias allows recovery and undo")
  val links=File(scratch,"links").apply{mkdirs()};Files.createSymbolicLink(File(links,"external").toPath(),outside.toPath());RecoveryFiles.deleteTreeNoFollow(links);check(File(outside,"precious").readText()=="KEEP");passed("no-follow tree deletion preserves external symlink target")
  val sc=fresh("symlink-parent");val scope=File(EngineConfig.profileModulesDir(sc),"@evil");scope.parentFile!!.mkdirs();Files.createSymbolicLink(scope.toPath(),outside.toPath());manifest(sc,listOf("@evil/precious"));val sr=RecoveryManager(sc).recover(RecoveryManager.Level.L2,target=RecoveryManager.Target.BUNDLES);check(!sr.success && File(outside,"precious").readText()=="KEEP");passed("quarantine refuses symlink ancestor and preserves external file")
 } catch(e:java.nio.file.FileSystemException) { println("SKIP symlinks: "+e.message) }
 // Crash simulation: persist a planned write + intact snapshot, then perform write without completion flush.
 val crash=fresh("crash");val crm=RecoveryManager(crash);val cr=crm.recover(RecoveryManager.Level.L1,target=RecoveryManager.Target.OVERLAY)
 val journal=File(cr.backupDir,"manifest.json");val jj=JSONObject(journal.readText());jj.put("status","planned");jj.getJSONArray("actions").getJSONObject(0).put("state","backed_up");journal.writeText(jj.toString())
 check(crm.undoLatest() && EngineConfig.overlayFile(crash).readText()=="old-overlay\\n");passed("pending write-ahead action is recoverable after interrupted journal flush")
 println("TOTAL PASS "+count)
}
`);
const out=path.join(temp,'classes');
const production=['RecoveryFiles.kt','RecoveryProcessRunner.kt','RecoveryProbe.kt','RecoveryManager.kt'].map(n=>path.join(root,'android/app/src/main/java/app/kxxy/engine',n));
function run(cmd,args) { const r=spawnSync(cmd,args,{cwd:temp,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024}); process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)throw r.error;if(r.status!==0)throw new Error(`Exit ${r.status}`); }
run(java,['-cp',compiler,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',runtimeCP,'-d',out,...stubs,tests,...production]);
run(java,['-cp',[out,runtimeCP].join(sep),'app.kxxy.engine.RecoveryBehaviorKt',process.execPath,child,path.join(temp,'scratch')]);
console.log(`Artifacts retained: ${temp}`);
