// Compile the actual permission helper/Privilege/runner against Android metadata stubs; no APK or device writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cache=process.env.KOTLIN_CACHE||path.join(os.homedir(),'.gradle/caches/modules-2/files-2.1');
const java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin/java.exe'):'E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe';
function jar(group,v){const p=path.join(cache,group,v);return fs.readdirSync(p).flatMap(h=>fs.readdirSync(path.join(p,h)).filter(n=>n.endsWith('.jar')).map(n=>path.join(p,h,n)))[0];}
const std=jar('org.jetbrains.kotlin/kotlin-stdlib','1.9.24'),annotations=jar('org.jetbrains/annotations','13.0'),coroutines=jar('org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm','1.8.1');
const compiler=[jar('org.jetbrains.kotlin/kotlin-compiler-embeddable','1.9.24'),std,jar('org.jetbrains.kotlin/kotlin-reflect','1.9.24'),jar('org.jetbrains.kotlin/kotlin-script-runtime','1.9.24'),jar('org.jetbrains.intellij.deps/trove4j','1.0.20200330'),annotations].join(path.delimiter);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kxxy-permissions-test-'));
const write=(n,s)=>{const p=path.join(temp,n);fs.writeFileSync(p,s);return p;};
const stubs=[write('Context.kt',`package android.content
import java.io.File
class Context(val filesDir:File) { companion object { const val MODE_PRIVATE=0 }; fun getSharedPreferences(n:String,m:Int)=Prefs() }
class Prefs { fun getString(n:String,d:String?):String?=d; fun edit()=this; fun putString(n:String,v:String)=this; fun apply(){} }
`),write('Process.kt',`package android.os
object Process { fun myUid()=12345 }
`),write('Log.kt',`package android.util
object Log { fun i(t:String,s:String)=0; fun w(t:String,s:String)=0 }
`),write('Config.kt',`package app.kxxy.engine
import android.content.Context
import java.io.File
object ShizukuBridge { fun installed(c:Context)=false }
object EngineConfig { fun dshHome(c:Context)=File(c.filesDir,"kxxy-home"); fun engineRoot(c:Context)=File(c.filesDir,"engine");fun tmpDir(c:Context)=File(c.filesDir,"tmp") }
`),write('Os.kt',`package android.system
import java.io.*
import java.nio.file.*
class ErrnoException(val functionName:String,val errno:Int):Exception()
class StructStat(val st_dev:Long=1,val st_ino:Long,val st_uid:Int,val st_gid:Int,val st_mode:Int,val st_nlink:Long=1)
object OsConstants {
 const val S_IFMT=61440;const val S_IFDIR=16384;const val S_IFREG=32768;const val S_IFLNK=40960
 const val R_OK=4; const val W_OK=2;const val X_OK=1;const val ENOENT=2;const val EACCES=13;const val EPERM=1
 const val O_RDONLY=0;const val O_WRONLY=1;const val O_CREAT=64;const val O_EXCL=128;const val O_NOFOLLOW=131072;const val O_NONBLOCK=2048
 fun S_ISDIR(m:Int)=m and S_IFMT==S_IFDIR;fun S_ISREG(m:Int)=m and S_IFMT==S_IFREG;fun S_ISLNK(m:Int)=m and S_IFMT==S_IFLNK
}
object Os {
 fun getgid()=12345
 data class M(var inode:Long,var uid:Int=12345,var gid:Int=12345,var mode:Int,var links:Long=1,var label:String="u:object_r:app_data_file:s0")
 val meta=mutableMapOf<String,M>();val calls=mutableListOf<String>();val handles=mutableMapOf<FileDescriptor,FileOutputStream>()
 var seq=10L;var denyLabel=false;var failChmod=false;var swapOnLstat:String?=null;var swapAt=0;var matchingCalls=0
 fun key(p:String)=File(p).absolutePath
 fun seed(f:File,mode:Int,uid:Int=12345,gid:Int=12345){meta[key(f.path)]=M(++seq,uid,gid,mode)}
 private fun m(p:String):M { val f=File(p);if(!Files.exists(f.toPath(),LinkOption.NOFOLLOW_LINKS))throw ErrnoException("lstat",2)
  return meta.getOrPut(key(p)){M(++seq,uid=if(f.parentFile==null)0 else 12345,mode=if(f.isDirectory)16877 else 33152)} }
 private fun parents(p:String){var f=File(p).parentFile;while(f!=null){val x=meta[key(f.path)];if(x!=null && x.mode and OsConstants.S_IFMT!=OsConstants.S_IFLNK){val bits=if(x.uid==12345)x.mode shr 6 else x.mode
   if(bits and 1==0)throw ErrnoException("parent",13)};f=f.parentFile}}
 fun lstat(p:String):StructStat {calls+="lstat";parents(p);val x=m(p)
  if(key(p)==swapOnLstat && ++matchingCalls==swapAt)x.inode++
  val mode=if(Files.isSymbolicLink(File(p).toPath()))OsConstants.S_IFLNK or 511 else x.mode
  return StructStat(st_ino=x.inode,st_uid=x.uid,st_gid=x.gid,st_mode=mode,st_nlink=x.links) }
 fun getxattr(p:String,n:String):ByteArray{calls+="xattr";parents(p);return m(p).label.toByteArray()}
 fun access(p:String,flags:Int):Boolean{calls+="access";parents(p);val x=m(p);val bits=if(x.uid==12345)x.mode shr 6 else x.mode;return !denyLabel && bits and flags==flags}
 fun chmod(p:String,mode:Int){calls+="chmod:"+p;parents(p);val x=m(p);if(x.uid!=12345||failChmod)throw ErrnoException("chmod",1);x.mode=x.mode and OsConstants.S_IFMT or mode}
 fun open(p:String,flags:Int,mode:Int):FileDescriptor{calls+="open:"+p;parents(p);check(flags and OsConstants.O_CREAT!=0){"Production tried opening user content"};if(Files.exists(File(p).toPath(),LinkOption.NOFOLLOW_LINKS))throw ErrnoException("open",17)
  val stream=FileOutputStream(p);seed(File(p),OsConstants.S_IFREG or mode);handles[stream.fd]=stream;return stream.fd}
 fun fstat(fd:FileDescriptor):StructStat{val f=handles[fd]?:error("fd");return StructStat(st_ino=999,st_uid=12345,st_gid=12345,st_mode=33152)}
 fun close(fd:FileDescriptor){handles.remove(fd)?.close()}
}
`)];
const child=write('child.mjs',`const m=process.argv[2]; if(m==='flood'){for(let i=0;i<300;i++){process.stdout.write('O'.repeat(8192));process.stderr.write('E'.repeat(8192));}process.exitCode=7;}else if(m==='hang'){setInterval(()=>{},1000);}else{process.stderr.write('denied');process.exitCode=1;}`);
const tests=write('PermissionBehavior.kt',`package app.kxxy.engine
import android.content.Context
import android.system.*
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.*
private var count=0
private fun pass(n:String){count++;println("PASS "+n)}
fun main(args:Array<String>)=runBlocking {
 val scratch=File(args[0]).apply{mkdirs()};val node=args[1];val child=args[2]
 fun fresh(n:String):Context {
  Os.denyLabel=false;Os.failChmod=false;Os.swapOnLstat=null;Os.matchingCalls=0
  val c=Context(File(scratch,n).apply{mkdirs()});val h=File(c.filesDir,"kxxy-home");val s=File(h,"storages");s.mkdirs()
  listOf(c.filesDir,h,s).forEach{Os.seed(it,OsConstants.S_IFDIR or 448)}
  val a=File(h,".credentials.yaml");val b=File(s,"workspace.json");a.writeBytes(byteArrayOf(0,1,2,127,-1));b.writeText("secret-workspace-content")
  listOf(a,b).forEach{Os.seed(it,OsConstants.S_IFREG or 384)}
  return c
 }
 fun files(c:Context)=listOf(File(c.filesDir,"kxxy-home/.credentials.yaml"),File(c.filesDir,"kxxy-home/storages/workspace.json"))
 fun contents(c:Context)=files(c).map{it.readBytes().toList()}
 fun m(f:File)=Os.meta.getValue(Os.key(f.path))
 fun journals(c:Context)=c.filesDir.listFiles()!!.filter{it.name.endsWith(".journal")}
 val c=fresh("normal");val old=contents(c);Os.calls.clear();check(UserDataPermissions.issue(c)==null){UserDataPermissions.issue(c).toString()};val r=UserDataPermissions.repair(c)
 check(r.success && r.changes.isEmpty() && contents(c)==old){r};check(Os.calls.filter{it.startsWith("open:")}.all{it.endsWith(".journal")});check(!r.detail.contains("secret-workspace-content"));pass("healthy validation, metadata-only private journal and content unchanged")
 val own=fresh("own000");val before=contents(own);files(own).forEach{m(it).mode=OsConstants.S_IFREG};check(UserDataPermissions.issue(own)!=null)
 val ownResult=UserDataPermissions.repair(own);check(ownResult.success && ownResult.changes.size==2){ownResult};check(contents(own)==before);pass("app-owned file 000 repaired without opening content")
 val dirs=fresh("dir000");val db=contents(dirs);m(File(dirs.filesDir,"kxxy-home")).mode=OsConstants.S_IFDIR;m(File(dirs.filesDir,"kxxy-home/storages")).mode=OsConstants.S_IFDIR
 val dr=UserDataPermissions.repair(dirs);check(dr.success && dr.changes.size==2){dr};check(contents(dirs)==db);pass("app-owned parent directories 000 repaired before child lstat")
 for(mode in listOf(489,505)){val d=fresh("files-"+mode);m(d.filesDir).mode=OsConstants.S_IFDIR or mode;val rr=UserDataPermissions.repair(d);check(rr.success && m(d.filesDir).mode and 4095==448){rr};pass("Android files directory mode "+Integer.toOctalString(mode)+" safely tightened")}
 val broad=fresh("world-writable");m(broad.filesDir).mode=OsConstants.S_IFDIR or 511;check(!UserDataPermissions.repair(broad).success && journals(broad).isEmpty());pass("world-writable journal parent refused")
 val root=fresh("root-owned");val rb=contents(root);m(files(root)[0]).uid=0;check(UserDataPermissions.issue(root)!=null)
 val rr=UserDataPermissions.repair(root);check(!rr.success && rr.needsRoot && rr.changes.isEmpty() && contents(root)==rb);pass("normal repair never probes Root for foreign owner")
 val explicit=UserDataPermissions.repair(root,true);check(!explicit.success && explicit.needsRoot && contents(root)==rb);pass("explicit Root unavailable fails without content mutation")
 val blocked=fresh("foreign-parent000");m(File(blocked.filesDir,"kxxy-home")).apply{uid=0;mode=OsConstants.S_IFDIR};val br=UserDataPermissions.repair(blocked);check(!br.success&&br.needsRoot&&br.detail.contains("EACCES")){br};pass("invisible children treated EACCES rather than ENOENT")
 val missing=fresh("missing");files(missing)[0].delete();check(UserDataPermissions.issue(missing)==null);val mr=UserDataPermissions.repair(missing);check(!mr.success&&mr.detail.contains("ENOENT")&&!files(missing)[0].exists()){mr};pass("missing file not created and no false success; fresh issue ignores missing")
 val freshCtx=Context(File(scratch,"first-run").apply{mkdirs()});Os.seed(freshCtx.filesDir,OsConstants.S_IFDIR or 448);check(UserDataPermissions.issue(freshCtx)==null);pass("brand-new home absent is not permission fault")
 val bad=fresh("chmod-denied");m(files(bad)[0]).mode=OsConstants.S_IFREG;Os.failChmod=true;val badR=UserDataPermissions.repair(bad);check(!badR.success&&badR.needsRoot){badR};Os.failChmod=false;pass("chmod failure is not successful repair")
 val label=fresh("selinux");Os.denyLabel=true;val lr=UserDataPermissions.repair(label);check(!lr.success&&lr.needsRoot){lr};Os.denyLabel=false;pass("SELinux access failure not mistaken for chmod success")
 val race=fresh("inode-replaced");m(files(race)[0]).mode=OsConstants.S_IFREG;Os.swapOnLstat=Os.key(files(race)[0].path);Os.swapAt=3;val ir=UserDataPermissions.repair(race);check(!ir.success){ir};Os.swapOnLstat=null;pass("inode replacement aborts repair")
 val hard=fresh("hardlink");m(files(hard)[0]).links=2;check(!UserDataPermissions.repair(hard).success);pass("multi-hardlink credential rejected")
 val outside=File(scratch,"outside").apply{mkdirs()};val secret=File(outside,"precious").apply{writeText("KEEP")}
 val links=fresh("symlink-file");files(links)[0].delete();Files.createSymbolicLink(files(links)[0].toPath(),secret.toPath());val sr=UserDataPermissions.repair(links);check(!sr.success&&secret.readText()=="KEEP"){sr};pass("symlink target refused and external content unchanged")
 val linkParent=fresh("symlink-parent");File(linkParent.filesDir,"kxxy-home/storages").deleteRecursively();Files.createSymbolicLink(File(linkParent.filesDir,"kxxy-home/storages").toPath(),outside.toPath());check(!UserDataPermissions.repair(linkParent).success&&secret.readText()=="KEEP");pass("user-controlled symlink ancestor refused")
 val real=fresh("trusted-system-alias");val alias=File(scratch,"system-alias");Files.createSymbolicLink(alias.toPath(),real.filesDir.parentFile.toPath());Os.seed(alias,OsConstants.S_IFLNK or 511,0,0)
 val aliasCtx=Context(File(alias,real.filesDir.name));check(UserDataPermissions.repair(aliasCtx).success);pass("root-owned ancestor system alias allowed")
 val untrusted=fresh("untrusted-alias");val ua=File(scratch,"user-alias");Files.createSymbolicLink(ua.toPath(),untrusted.filesDir.parentFile.toPath());Os.seed(ua,OsConstants.S_IFLNK or 511);check(!UserDataPermissions.repair(Context(File(ua,untrusted.filesDir.name))).success);pass("app-owned ancestor alias rejected")
 val flood=Privilege.runExplicitRepairSu(listOf(node,child,"flood"),"ignored",15000);check(!flood.ok&&flood.exitCode==7&&flood.truncated&&flood.text.length<17000){flood};pass("explicit runner drains stdout/stderr and checks nonzero exit")
 val start=System.nanoTime();val timeout=Privilege.runExplicitRepairSu(listOf(node,child,"hang"),"ignored",500);check(timeout.status==RecoveryProcessRunner.Status.TIMED_OUT && (System.nanoTime()-start)/1000000<15000){"status="+timeout.status+" elapsed="+(System.nanoTime()-start)/1000000};pass("explicit runner bounded timeout")
 val legacy=fresh("legacy");m(files(legacy)[0]).uid=0;Privilege.fixHomeOwnership(legacy);check(m(files(legacy)[0]).uid==0);pass("deprecated automatic recursive fix does nothing")
 check(journals(c).all{m(it).mode and 4095==384});check(journals(c).none{it.readText().contains("secret-workspace-content")});pass("journal 0600 and no credential/workspace bytes")
 println("TOTAL PASS "+count)
}
`);
const cp=[std,annotations,coroutines].join(path.delimiter),out=path.join(temp,'classes');
function run(args){const r=spawnSync(java,args,{cwd:temp,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)throw r.error;if(r.status!==0)throw Error('Exit '+r.status);}
run(['-cp',compiler,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',cp,'-d',out,...stubs,tests,...['UserDataPermissions.kt','Privilege.kt','RecoveryProcessRunner.kt'].map(n=>path.join(root,'android/app/src/main/java/app/kxxy/engine',n))]);
run(['-cp',[out,cp].join(path.delimiter),'app.kxxy.engine.PermissionBehaviorKt',path.join(temp,'scratch'),process.execPath,child]);
console.log('Artifacts retained: '+temp);
