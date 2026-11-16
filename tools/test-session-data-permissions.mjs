// Actual production Kotlin, Android metadata stubs, no APK/ADB. Independent session regression harness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {openZip} from './lib/zipread.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cache=process.env.KOTLIN_CACHE||path.join(os.homedir(),'.gradle/caches/modules-2/files-2.1');
const java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin/java.exe'):'E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe';
function jar(group,v){const p=path.join(cache,group,v);return fs.readdirSync(p).flatMap(h=>fs.readdirSync(path.join(p,h)).filter(n=>n.endsWith('.jar')).map(n=>path.join(p,h,n)))[0];}
const std=jar('org.jetbrains.kotlin/kotlin-stdlib','1.9.24'),ann=jar('org.jetbrains/annotations','13.0'),co=jar('org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm','1.8.1');
const compiler=[jar('org.jetbrains.kotlin/kotlin-compiler-embeddable','1.9.24'),std,jar('org.jetbrains.kotlin/kotlin-reflect','1.9.24'),jar('org.jetbrains.kotlin/kotlin-script-runtime','1.9.24'),jar('org.jetbrains.intellij.deps/trove4j','1.0.20200330'),ann].join(path.delimiter);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kxxy-session-permissions-'));
const write=(n,s)=>{const f=path.join(temp,n);fs.writeFileSync(f,s);return f;};
const sources=[write('Context.kt',`package android.content
import java.io.File
class Context(val filesDir:File)
`),write('Process.kt',`package android.os
object Process { fun myUid()=12345 }
`),write('Privilege.kt',`package app.kxxy.engine
object Privilege {
 var probes=0;var runs=0
 suspend fun explicitRepairSuPrefix():List<String>? { probes++;return null }
 suspend fun runExplicitRepairSu(p:List<String>,s:String,t:Long=5000):RecoveryProcessRunner.Output { runs++;error("Root denied: unexpected execution") }
 fun shellQuote(s:String)="'"+s.replace("'","'\\\\''")+"'"
}
object RecoveryProcessRunner { data class Output(val ok:Boolean=false,val truncated:Boolean=false,val text:String="",val exitCode:Int?=1,val status:String="FAILED") }
`),write('Os.kt',`package android.system
import java.io.*
import java.nio.file.*
class ErrnoException(val functionName:String,val errno:Int):Exception()
class StructStat(val st_dev:Long=1,val st_ino:Long,val st_uid:Int,val st_gid:Int,val st_mode:Int,val st_nlink:Long=1,val st_size:Long=0,val st_mtime:Long=0)
object OsConstants {
 const val S_IFMT=61440;const val S_IFDIR=16384;const val S_IFREG=32768;const val S_IFLNK=40960
 const val R_OK=4;const val W_OK=2;const val X_OK=1;const val ENOENT=2;const val EACCES=13;const val EPERM=1
 const val O_RDONLY=0;const val O_WRONLY=1;const val O_CREAT=64;const val O_EXCL=128;const val O_NOFOLLOW=131072;const val O_NONBLOCK=2048;const val SEEK_SET=0
 fun S_ISDIR(m:Int)=m and S_IFMT==S_IFDIR;fun S_ISREG(m:Int)=m and S_IFMT==S_IFREG;fun S_ISLNK(m:Int)=m and S_IFMT==S_IFLNK
}
object Os {
 fun getgid()=12345
 data class M(var ino:Long,var uid:Int=12345,var gid:Int=12345,var mode:Int,var links:Long=1)
 val meta=mutableMapOf<String,M>();val calls=mutableListOf<String>();val handles=mutableMapOf<FileDescriptor,Pair<File,RandomAccessFile>>()
 var seq=10L;var swap:String?=null;var swapAt=0;var matches=0;var delay=0L;var denied=false
 fun key(p:String)=File(p).absolutePath
 fun seed(f:File,mode:Int,uid:Int=12345){meta[key(f.path)]=M(++seq,uid,uid,mode)}
 private fun m(p:String):M {val f=File(p);if(!Files.exists(f.toPath(),LinkOption.NOFOLLOW_LINKS))throw ErrnoException("lstat",2);return meta.getOrPut(key(p)){M(++seq,if(f.parentFile==null)0 else 12345,mode=if(f.isDirectory)16877 else 33152)}}
 private fun parents(p:String){var f=File(p).parentFile;while(f!=null){val x=meta[key(f.path)];if(x!=null&&!OsConstants.S_ISLNK(x.mode)){val bits=if(x.uid==12345)x.mode shr 6 else x.mode;if(bits and 1==0)throw ErrnoException("parent",13)};f=f.parentFile}}
 fun lstat(p:String):StructStat {if(delay>0)Thread.sleep(delay);calls+="lstat:"+p;parents(p);val f=File(p);val x=m(p);if(key(p)==swap&&++matches==swapAt)x.ino++
  return StructStat(st_ino=x.ino,st_uid=x.uid,st_gid=x.gid,st_mode=if(Files.isSymbolicLink(f.toPath()))40960 or 511 else x.mode,st_nlink=x.links,st_size=f.length(),st_mtime=f.lastModified()/1000)}
 fun access(p:String,flags:Int):Boolean {parents(p);val x=m(p);val bits=if(x.uid==12345)x.mode shr 6 else x.mode;return !denied&&bits and flags==flags}
 fun chmod(p:String,mode:Int){calls+="chmod:"+p;parents(p);val x=m(p);if(x.uid!=12345)throw ErrnoException("chmod",1);x.mode=x.mode and OsConstants.S_IFMT or mode}
 fun getxattr(p:String,n:String):ByteArray {parents(p);return "u:object_r:app_data_file:s0".toByteArray()}
 fun open(p:String,flags:Int,mode:Int):FileDescriptor {
  if(flags and OsConstants.O_CREAT!=0){check(File(p).name.endsWith(".journal"));check(flags and OsConstants.O_EXCL!=0&&flags and OsConstants.O_NOFOLLOW!=0);check(!Files.exists(File(p).toPath(),LinkOption.NOFOLLOW_LINKS));parents(p);val r=RandomAccessFile(p,"rw");seed(File(p),32768 or mode);handles[r.fd]=File(p) to r;calls+="journal:"+p;return r.fd}
  check(File(p).name in listOf("engine.log","native-boot-failure.json")){"session/credential content opened"};calls+="open:"+p;check(flags and OsConstants.O_NOFOLLOW!=0);parents(p);if(Files.isSymbolicLink(File(p).toPath()))throw ErrnoException("open",40);val r=RandomAccessFile(p,"r");handles[r.fd]=File(p) to r;return r.fd}
 fun fstat(fd:FileDescriptor)=lstat(handles.getValue(fd).first.path)
 fun lseek(fd:FileDescriptor,n:Long,whence:Int):Long {handles.getValue(fd).second.seek(n);return n}
 fun close(fd:FileDescriptor){handles.remove(fd)?.second?.close()}
}
`),write('Test.kt',`package app.kxxy.engine
import android.content.Context
import android.system.*
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
private var count=0
private fun pass(n:String){count++;println("PASS "+n)}
fun main(args:Array<String>)=runBlocking {
 val scratch=File(args[0]).apply{mkdirs()};val uuid="session-12345678-1234-1234-1234-123456789abc"
 fun fresh(n:String):Context {
  Os.swap=null;Os.matches=0;Os.delay=0;Os.denied=false;Privilege.probes=0;Privilege.runs=0
  val c=Context(File(scratch,n).apply{mkdirs()});val h=File(c.filesDir,"kxxy-home");val s=File(h,"sessions");val w=File(s,"%2Fstorage%2Femulated%2F0");val d=File(w,uuid);d.mkdirs()
  listOf(c.filesDir,h,s,w,d).forEach{Os.seed(it,16384 or 448)}
  File(d,"attachment.sh").apply{writeText("#!/bin/sh\\necho KEEP")}.also{Os.seed(it,32768 or 448)}
  File(d,"messages.jsonl").apply{writeBytes(byteArrayOf(0,1,2,-1,127))}.also{Os.seed(it,32768 or 384)}
  File(c.filesDir,"engine").mkdirs();return c
 }
 fun session(c:Context)=File(c.filesDir,"kxxy-home/sessions/%2Fstorage%2Femulated%2F0/"+uuid)
 fun evidence(c:Context,p:String=session(c).absolutePath)=File(c.filesDir,"engine/engine.log").apply{writeText("Error: EACCES: permission denied, scandir '"+p+"'\\n    at async scan\\n")}
 fun m(f:File)=Os.meta.getValue(Os.key(f.path))
 fun bytes(c:Context)=session(c).listFiles()!!.associate{it.name to it.readBytes().toList()}
 val none=fresh("none");check(SessionDataPermissions.issue(none)==null);check(SessionDataPermissions.repair(none).let{it.success&&it.changes.isEmpty()});pass("no evidence zero changes/no su")
 val healthy=fresh("healthy");evidence(healthy);val old=bytes(healthy);check(SessionDataPermissions.issue(healthy)==null);val hr=SessionDataPermissions.repair(healthy);check(hr.success&&hr.changes.isEmpty()&&bytes(healthy)==old){hr};pass("stale EACCES but healthy metadata ignored")
 val own=fresh("owner000");evidence(own);val before=bytes(own);m(session(own)).mode=16384;m(File(session(own),"messages.jsonl")).mode=32768
 val other=File(own.filesDir,"kxxy-home/sessions/unrelated").apply{mkdirs()};Os.seed(other,16384,0)
 val rr=SessionDataPermissions.repair(own);check(rr.success&&bytes(own)==before&&m(File(session(own),"attachment.sh")).mode and 511==448){rr};check(m(other).uid==0);pass("directory/file 000 repaired; attachment exec/content preserved; unrelated session untouched")
 val foreign=fresh("foreign");evidence(foreign);val fb=bytes(foreign);m(File(session(foreign),"messages.jsonl")).uid=0
 val fr=SessionDataPermissions.repair(foreign);check(!fr.success&&fr.needsRoot&&Privilege.probes==0&&Privilege.runs==0&&bytes(foreign)==fb){fr};pass("foreign owner requires explicit Root; default never su")
 val er=SessionDataPermissions.repair(foreign,true);check(!er.success&&er.needsRoot&&Privilege.probes==1&&Privilege.runs==0&&bytes(foreign)==fb){er};pass("explicit Root denied; no mutation")
 val blocked=fresh("rootparent000");evidence(blocked);m(session(blocked).parentFile).apply{uid=0;mode=16384};val br=SessionDataPermissions.repair(blocked);check(!br.success&&br.needsRoot&&Privilege.probes==0){br};pass("unsearchable root ancestor needs Root not stale ENOENT")
 val missing=fresh("missing");evidence(missing);session(missing).deleteRecursively();check(SessionDataPermissions.issue(missing)==null);val mr=SessionDataPermissions.repair(missing);check(!mr.success&&!session(missing).exists()){mr};pass("missing stale exact path not recreated")
 for(p in listOf(".."+File.separator+uuid,"workspace"+File.separator+"session-invalid","workspace"+File.separator+uuid+File.separator+"..")){
  val bad=fresh("bad"+count);evidence(bad,File(bad.filesDir,"kxxy-home/sessions").absolutePath+File.separator+p);val r=SessionDataPermissions.repair(bad);check(!r.success&&Privilege.probes==0){r};pass("malformed/traversal scope rejected")
 }
 val outside=File(scratch,"external").apply{mkdirs()};val precious=File(outside,"precious").apply{writeText("KEEP")}
 val link=fresh("publiclink");val root=File(link.filesDir,"kxxy-home/sessions");root.deleteRecursively();Files.createSymbolicLink(root.toPath(),outside.toPath())
 check(SessionDataPermissions.repair(link).success);evidence(link);val lr=SessionDataPermissions.repair(link);check(!lr.success&&lr.detail.contains("unsupported")&&precious.readText()=="KEEP"&&Privilege.probes==0){lr};pass("public sessions symlink unsupported only with evidence; external content untouched")
 val child=fresh("childlink");evidence(child);Files.createSymbolicLink(File(session(child),"escape").toPath(),outside.toPath());check(!SessionDataPermissions.repair(child).success&&precious.readText()=="KEEP");pass("nested symlink refused")
 val hard=fresh("hardlink");evidence(hard);m(File(session(hard),"messages.jsonl")).links=2;check(!SessionDataPermissions.repair(hard).success);pass("hardlink refused")
 val race=fresh("replaced");evidence(race);m(session(race)).mode=16384;Os.swap=Os.key(session(race).path);Os.swapAt=4;check(!SessionDataPermissions.repair(race).success);Os.swap=null;pass("inode replacement aborts")
 val broad=fresh("caps");evidence(broad);repeat(260){File(session(broad),"n"+it).writeText("KEEP")};val cap=SessionDataPermissions.repair(broad);check(!cap.success&&cap.detail.contains("NODE_LIMIT")){cap};pass("bounded node scope")
 val slow=fresh("timecap");evidence(slow);repeat(30){File(session(slow),"n"+it).writeText("KEEP")};Os.delay=40;val started=System.nanoTime();val tr=SessionDataPermissions.repair(slow);Os.delay=0;check(!tr.success&&tr.detail.contains("TIME_LIMIT")&&(System.nanoTime()-started)/1000000<13000){tr};pass("bounded elapsed time")
 val big=fresh("biglog");val log=evidence(big);log.writeText("x".repeat(70000)+"\\n"+log.readText());check(SessionDataPermissions.repair(big).success);pass("bounded log tail handles large logs")
 val tail=fresh("partialline");val partial=evidence(tail);partial.writeText("x".repeat(70000)+partial.readText().trimEnd());check(SessionDataPermissions.issue(tail)==null);pass("discard truncated first line, never join into evidence")
 val latest=fresh("latestfailure");val l=evidence(latest);l.appendText("Error: unrelated latest failure\\n");check(SessionDataPermissions.repair(latest).changes.isEmpty());pass("healthy metadata still zero changes with multiple errors")
 val realLog=fresh("userloground");val userLog=evidence(realLog);m(session(realLog)).mode=16384
 userLog.writeText("---- engine start 101 ----\\n"+userLog.readText()+"Error: EEXIST connection writer lock\\n---- engine start 102 ----\\n")
 File(realLog.filesDir,"engine/native-boot-failure.json").apply{writeText("{\\\"reason\\\":\\\"Error: connection writer lock\\\"}");setLastModified(System.currentTimeMillis()+2000)}
 check(SessionDataPermissions.issue(realLog)!=null);val ur=SessionDataPermissions.repair(realLog);check(ur.success&&ur.changes.isNotEmpty()){ur};pass("real log workspace Error + connection Error + empty retry; native lock does not mask session")
 val rounds=fresh("newfailure");val rlog=evidence(rounds);m(session(rounds)).mode=16384;rlog.writeText("---- engine start 1 ----\\n"+rlog.readText()+"---- engine start 2 ----\\nError: unrelated current round\\n");check(SessionDataPermissions.repair(rounds).let{it.success&&it.changes.isEmpty()});pass("new completed unrelated round supersedes old session evidence")
 val aliasReal=fresh("aliasreal");val alias=File(scratch,"system-alias");Files.createSymbolicLink(alias.toPath(),aliasReal.filesDir.parentFile.toPath());Os.seed(alias,40960 or 511,0)
 val aliasCtx=Context(File(alias,aliasReal.filesDir.name));evidence(aliasReal,File(aliasCtx.filesDir,"kxxy-home/sessions/%2Fstorage%2Femulated%2F0/"+uuid).absolutePath);m(session(aliasReal)).mode=16384
 val ar=SessionDataPermissions.repair(aliasCtx);check(ar.success&&ar.changes.isNotEmpty()){ar};pass("trusted Context system alias maps exact log path without resolving sessions")
 // Actual upstream projectKey output, including Unicode escapes and 255-byte truncation.
 for((i,key) in args.drop(1).withIndex()) {
  val c=fresh("upstream-key-"+i);val w=File(c.filesDir,"kxxy-home/sessions/"+key);val d=File(w,uuid).apply{mkdirs()};Os.seed(w,16384 or 448);Os.seed(d,16384)
  val body=File(d,"messages.jsonl").apply{writeText("KEEP-UNICODE-SESSION")};Os.seed(body,32768 or 384)
  evidence(c,d.absolutePath).writeText("---- engine start 1794214193534 ----\\nError: EACCES: permission denied, scandir '"+d.absolutePath+"'\\n  connection (required)\\n    Error: atomic-write: timed out waiting for the writer lock\\n---- engine start 1794214232519 ----\\n---- engine start 1794219774680 ----\\n---- engine start 1794219790693 ----\\n---- engine start 1794219813377 -\\n")
  check(SessionDataPermissions.issue(c)!=null);val r=SessionDataPermissions.repair(c);check(r.success&&r.changes.size==1&&body.readText()=="KEEP-UNICODE-SESSION"&&m(d).mode and 511==448){r};pass("packed upstream workspace key repaired bytes="+key.length+" key="+key.take(70))
 }
 val longKey=fresh("overlong-key");evidence(longKey,File(longKey.filesDir,"kxxy-home/sessions/"+"a".repeat(256)+"/"+uuid).absolutePath);check(!SessionDataPermissions.repair(longKey).success);pass("workspace above filesystem component limit refused")
 val journal=own.filesDir.listFiles()!!.single{it.name.endsWith(".journal")};check(m(journal).mode and 4095==384);val jt=journal.readText();check(jt.contains("before ")&&jt.contains("after ")&&jt.contains("session completed")&&!jt.contains("echo KEEP"));pass("shared production journal write-ahead metadata 0600, no body bytes")
 check(Privilege.runs==0);check(Os.calls.filter{it.startsWith("open:")}.all{it.endsWith("engine.log")||it.endsWith("native-boot-failure.json")});pass("only bounded logs opened, never session/credential body")
 println("TOTAL PASS "+count)
}
`)];
const cp=[std,ann,co].join(path.delimiter),out=path.join(temp,'classes');
function run(a){const r=spawnSync(java,a,{cwd:temp,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)throw r.error;if(r.status!==0)throw Error('Exit '+r.status);}
run(['-cp',compiler,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',cp,'-d',out,...sources,...['SessionDataPermissions.kt','UserDataPermissions.kt'].map(n=>path.join(root,'android/app/src/main/java/app/kxxy/engine',n))]);
const packed=openZip(process.env.KXXY_RUNTIME_ZIP||path.join(root,'.cache/apk-assets-hold/runtime.zip')).read('lib/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js').toString();
const keySource=packed.match(/function projectKey\(cwd\) \{[\s\S]*?\n\}/)?.[0];
if(!keySource)throw Error('Packed upstream projectKey missing');
const projectKey=vm.runInNewContext(keySource+'; projectKey');
const keys=['/data/user/0/app.kxxy/files/kxxy-home/workspaces/测试','/中文/有 空格/~/%/😀','/workspace/'+ '中'.repeat(80)].map(projectKey);
if(keys[0]!=='--data-user-0-app.kxxy-files-kxxy-home-workspaces-~6D4B~8BD5--'||keys[2].length!==255)throw Error('Upstream fixture differs from supplied report');
run(['-cp',[out,cp].join(path.delimiter),'app.kxxy.engine.TestKt',path.join(temp,'scratch'),...keys]);
console.log('Artifacts retained: '+temp);
