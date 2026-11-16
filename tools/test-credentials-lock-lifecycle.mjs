// Executes production Kotlin lock/lifecycle with metadata stubs. No APK/device/build writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { openZip } from './lib/zipread.mjs';
import { pathToFileURL } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cache=process.env.KOTLIN_CACHE||path.join(os.homedir(),'.gradle/caches/modules-2/files-2.1');
const java=process.env.KXXY_JAVA||'E:/deepseek-harness/XJZB/_toolchain/jdk-17.0.20.1+1/bin/java.exe';
function jar(n,v){const b=path.join(cache,n,v);return fs.readdirSync(b).flatMap(h=>fs.readdirSync(path.join(b,h)).filter(f=>f.endsWith('.jar')).map(f=>path.join(b,h,f)))[0];}
const std=jar('org.jetbrains.kotlin/kotlin-stdlib','1.9.24'),ann=jar('org.jetbrains/annotations','13.0'),co=jar('org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm','1.8.1');
const compiler=[jar('org.jetbrains.kotlin/kotlin-compiler-embeddable','1.9.24'),std,jar('org.jetbrains.kotlin/kotlin-reflect','1.9.24'),jar('org.jetbrains.kotlin/kotlin-script-runtime','1.9.24'),jar('org.jetbrains.intellij.deps/trove4j','1.0.20200330'),ann].join(path.delimiter);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kxxy-lock-lifecycle-')),write=(n,s)=>{const p=path.join(tmp,n);fs.writeFileSync(p,s);return p;};
const source=path.join(root,'android/app/src/main/java/app/kxxy/engine');
const stubs=[write('Context.kt',`package android.content
import java.io.File
class Context(val filesDir:File)
`),write('Process.kt',`package android.os
object Process { fun myUid()=12345;fun myPid()=100 }
`),write('Log.kt',`package android.util
object Log {fun d(t:String,s:String)=0;fun i(t:String,s:String)=0;fun w(t:String,s:String)=0;fun e(t:String,s:String,e:Throwable)=0}
`),write('Support.kt',`package app.kxxy.engine
import android.content.Context
object UserDataPermissions {data class Outcome(val success:Boolean,val changes:List<String>,val detail:String,val needsRoot:Boolean=false)}
object EngineConfig {const val MAX_LOG_BYTES=2000000L}
object RecoveryProcessRunner {enum class Status {EXITED,TIMED_OUT};data class Output(val ok:Boolean=false,val status:Status=Status.EXITED,val exitCode:Int?=1,val truncated:Boolean=false,val text:String="")}
object Privilege {var probes=0;var runs=0;suspend fun explicitRepairSuPrefix():List<String>?{probes++;return null};suspend fun runExplicitRepairSu(p:List<String>,s:String,t:Long=5000):RecoveryProcessRunner.Output{runs++;return RecoveryProcessRunner.Output()};fun shellQuote(s:String)="'"+s.replace("'","'\\\\''")+"'"}
`),write('Os.kt',`package android.system
import java.io.*
import java.nio.file.*
class ErrnoException(val fn:String,val errno:Int):Exception(fn+" errno="+errno)
class StructStat(val st_dev:Long=1,val st_ino:Long,val st_uid:Int,val st_gid:Int,val st_mode:Int,val st_nlink:Long=1,val st_size:Long=0)
object OsConstants {const val S_IFMT=61440;const val S_IFDIR=16384;const val S_IFREG=32768;const val S_IFLNK=40960;const val ENOENT=2;const val EPERM=1;const val EACCES=13;const val ESRCH=3;const val O_RDONLY=0;const val O_WRONLY=1;const val O_CREAT=64;const val O_EXCL=128;const val O_NOFOLLOW=131072;const val O_NONBLOCK=2048
fun S_ISDIR(m:Int)=m and S_IFMT==S_IFDIR;fun S_ISREG(m:Int)=m and S_IFMT==S_IFREG;fun S_ISLNK(m:Int)=m and S_IFMT==S_IFLNK}
object Os {
 data class M(var inode:Long,var uid:Int=12345,var gid:Int=12345,var mode:Int,var links:Long=1)
 data class H(val p:String,val out:FileOutputStream?=null,val input:RandomAccessFile?=null)
 val meta=mutableMapOf<String,M>();val handles=mutableMapOf<FileDescriptor,H>();val calls=mutableListOf<String>();val alive=mutableMapOf<Int,Int>();var seq=10L
 var hook:((String,String)->Unit)?=null;var denied:String?=null;var readCount=0;var maxRead=0
 fun key(p:String)=File(p).absolutePath
 fun seed(f:File,mode:Int=33152,uid:Int=12345){meta[key(f.path)]=M(++seq,uid,uid,mode)}
 private fun m(p:String):M {if(!Files.exists(File(p).toPath(),LinkOption.NOFOLLOW_LINKS))throw ErrnoException("lstat",2);return meta.getOrPut(key(p)){M(++seq,uid=if(File(p).parentFile==null)0 else 12345,mode=if(File(p).isDirectory)16832 else 33152)}}
 fun lstat(p:String):StructStat {hook?.invoke("stat",p);calls+="stat:"+p;val x=m(p);val mode=if(Files.isSymbolicLink(File(p).toPath()))41471 else x.mode;return StructStat(st_ino=x.inode,st_uid=x.uid,st_gid=x.gid,st_mode=mode,st_nlink=x.links,st_size=File(p).length())}
 fun getgid()=12345
 fun open(p:String,flags:Int,mode:Int):FileDescriptor {
  calls+="open:"+p;hook?.invoke("open",p)
  check(flags and OsConstants.O_NOFOLLOW!=0);if(Files.isSymbolicLink(File(p).toPath()))throw ErrnoException("open",40)
  if(flags and OsConstants.O_CREAT!=0){if(File(p).exists())throw ErrnoException("open",17);val o=FileOutputStream(p);seed(File(p),32768 or mode);handles[o.fd]=H(p,out=o);return o.fd}
  if(p==denied || m(p).uid!=12345)throw ErrnoException("open",13)
  check(File(p).name==".credentials.yaml.lock"||File(p).name=="lock"||File(p).name.startsWith(".credentials.yaml.lock.takeover-")){"credential content opened"}
  val r=RandomAccessFile(p,"r");handles[r.fd]=H(p,input=r);return r.fd
 }
 fun fstat(fd:FileDescriptor)=lstat(handles.getValue(fd).p)
 fun read(fd:FileDescriptor,b:ByteArray,o:Int,n:Int):Int {val h=handles.getValue(fd);hook?.invoke("read",h.p);readCount++;maxRead=maxOf(maxRead,n);return h.input!!.read(b,o,n)}
 fun write(fd:FileDescriptor,b:ByteArray,o:Int,n:Int):Int {handles.getValue(fd).out!!.write(b,o,n);return n}
 fun fsync(fd:FileDescriptor){fd.sync()}
 fun close(fd:FileDescriptor){val h=handles.remove(fd)?:return;h.out?.close();h.input?.close()}
 fun mkdir(p:String,mode:Int){check(File(p).mkdir());seed(File(p),16384 or mode)}
 fun rename(a:String,b:String){hook?.invoke("rename",a);calls+="rename:"+a;Files.move(File(a).toPath(),File(b).toPath());meta[key(b)]=meta.remove(key(a))!!;hook?.invoke("renamed",a)}
 fun remove(p:String){hook?.invoke("unlink",p);calls+="unlink:"+p;Files.delete(File(p).toPath());meta.remove(key(p))}
 fun kill(p:Int,s:Int){calls+="kill:"+p+":"+s;val errno=alive[p]?:3;if(errno!=0)throw ErrnoException("kill",errno)}
 fun dup(fd:FileDescriptor):FileDescriptor=throw ErrnoException("dup",9)
}
`),write('Pty.kt',`package app.kxxy.pty
import android.system.Os
object PtyBridge {
 const val SIGTERM=15;const val SIGKILL=9;var pid=500;var closed=0;var killCalls=0;var waitCalls=0;var stubborn=false
 fun nativeForkPty(executable:String,argv:Array<String>,envp:Array<String>,cwd:String?,rows:Int,cols:Int):IntArray{Os.alive[pid]=0;return intArrayOf(88,pid)}
 fun nativeKill(p:Int,s:Int):Int {killCalls++;if(!stubborn)Os.alive[p]=3;return 0}
 fun nativeWaitPid(p:Int):Int{waitCalls++;return 0}
 fun nativeClose(m:Int){closed++};fun nativeAlive(p:Int)=0;fun nativeResize(m:Int,r:Int,c:Int)=0;fun nativeWrite(m:Int,b:ByteArray)=b.size;fun describe(s:Int)="status"
}
`)];
const tests=write('LockBehavior.kt',`package app.kxxy.engine
import android.content.Context
import android.system.*
import app.kxxy.pty.PtyBridge
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.coroutines.*
var count=0
fun pass(s:String){count++;println("PASS "+s)}
fun main(args:Array<String>)=runBlocking {
 val scratch=File(args[0]).apply{mkdirs()}
 fun fresh(n:String,record:String?="200\\n"):Context {Os.hook=null;Os.denied=null;val c=Context(File(scratch,n).apply{mkdirs()});val h=File(c.filesDir,"kxxy-home").apply{mkdirs()};Os.seed(c.filesDir,16832);Os.seed(h,16832);File(h,".credentials.yaml").writeText("SECRET-UNREAD");if(record!=null){val f=File(h,".credentials.yaml.lock");f.writeText(record);Os.seed(f)};return c}
 fun lock(c:Context)=File(c.filesDir,"kxxy-home/.credentials.yaml.lock")
 fun claim(c:Context):File {val hex=MessageDigest.getInstance("SHA-256").digest(lock(c).readBytes()).joinToString(""){"%02x".format(it.toInt() and 255)};return File(lock(c).parentFile,lock(c).name+".takeover-"+hex.take(16))}
 suspend fun repair(c:Context,root:Boolean=false)=CredentialsLockRecovery.repair(c,root,true)
 val no=fresh("gate");Os.calls.clear();check(!CredentialsLockRecovery.repair(no,true,false).success&&Os.calls.isEmpty());pass("mandatory writersStopped false performs zero syscalls")
 val missing=fresh("missing",null);val mr=repair(missing);check(mr.success&&mr.changes.isEmpty());pass("missing lock succeeds with zero changes")
 for(pid in listOf(100,201)){val a=fresh("active-"+pid,pid.toString()+"\\n");Os.alive[pid]=0;val r=repair(a);check(!r.success&&r.changes.isEmpty()&&lock(a).exists());pass("active/current holder never mutated pid="+pid)}
 val ep=fresh("eperm","202\\n");Os.alive[202]=1;val er=repair(ep);check(!er.success&&er.needsRoot&&lock(ep).exists()&&Privilege.probes==0);pass("EPERM is unknown and needs explicit Root")
 for((i,s) in listOf("", "0\\n","2147483648\\n","-2\\n","200", "200\\r\\n","200\\n\\n", " 200\\n","2".repeat(33)+"\\n").withIndex()){val c=fresh("invalid-"+i,s);val r=repair(c);check(!r.success&&r.changes.isEmpty()&&lock(c).readText()==s){r};pass("strict bounded official format invalid="+i)}
 val invalidRoot=fresh("invalid-root","legacy-lock");val ir=repair(invalidRoot);check(!ir.success&&ir.needsRoot&&Privilege.probes==0);val irRoot=repair(invalidRoot,true);check(!irRoot.success&&irRoot.needsRoot&&Privilege.probes==1&&lock(invalidRoot).readText()=="legacy-lock");pass("malformed lock requests explicit Root; denied Root preserves record")
 Privilege.probes=0
 val stale=fresh("stale");val r=repair(stale);check(r.success&&r.changes.size==1&&!lock(stale).exists()&&!claimForAbsent(stale).exists()){r};val backup=lock(stale).parentFile.listFiles()!!.single{it.isDirectory};check(File(backup,"lock").readText()=="200\\n");check(Os.meta.getValue(Os.key(backup.path)).mode and 4095==448);check(File(stale.filesDir,"kxxy-home/.credentials.yaml").readText()=="SECRET-UNREAD");pass("ESRCH exact official claim and atomic private quarantine preserving record")
 val unread=fresh("unreadable");Os.denied=lock(unread).path;val ur=repair(unread);check(!ur.success&&ur.needsRoot&&lock(unread).exists()&&Privilege.probes==0);val rr=repair(unread,true);check(!rr.success&&rr.needsRoot&&Privilege.probes==1);pass("unreadable root0600 defaults no su and explicit denied fails closed")
 for(p in listOf(203,204)){val c=fresh("claim-"+p);val f=claim(c);f.writeText(p.toString()+"\\n");Os.seed(f);Os.alive[p]=if(p==203)0 else 3;val x=repair(c);check(!x.success&&lock(c).exists()&&f.exists()&&x.detail.contains(f.name));pass("existing active/dead official claim refused and metadata reported")}
 for(kind in listOf("group","hardlink","symlink")){val c=fresh("unsafe-"+kind);val m=Os.meta.getValue(Os.key(lock(c).path));when(kind){"group"->m.mode=33184;"hardlink"->m.links=2;else->{lock(c).delete();val ext=File(scratch,"outside").apply{writeText("KEEP")};Files.createSymbolicLink(lock(c).toPath(),ext.toPath())}};check(!repair(c).success);pass("unsafe "+kind+" refused")}
 val race=fresh("record-race");var injected=false;Os.hook={op,p->if(op=="open"&&p.contains(".takeover-")&&!injected){injected=true;lock(race).writeText("205\\n");Os.alive[205]=0}};check(!repair(race).success&&lock(race).readText()=="205\\n"&&!claim(race).exists());pass("record/PID replacement after claim refuses quarantine")
 val inode=fresh("inode-race");Os.hook={op,p->if(op=="open"&&p.contains(".takeover-"))Os.meta.getValue(Os.key(lock(inode).path)).inode++};check(!repair(inode).success&&lock(inode).exists());pass("inode race fails closed")
 val release=fresh("claim-release-race");val cf=claim(release);Os.hook={op,p->if(op=="renamed"){Os.meta.getValue(Os.key(cf.path)).inode++;cf.writeText("206\\n")}};check(repair(release).success&&cf.exists());pass("release never deletes replaced claim identity")
 val postop=fresh("postop-race");Os.hook={op,p->if(op=="renamed"){lock(postop).writeText("207\\n");Os.seed(lock(postop));Os.alive[207]=0}};val pr=repair(postop);check(!pr.success&&pr.changes.size==1&&lock(postop).readText()=="207\\n");pass("post-op new lock retained and partial quarantine reported")
 Os.hook=null;check(Os.maxRead<=33);check(Os.calls.filter{it.startsWith("kill:")}.all{it.endsWith(":0")});pass("bounded lock reads and only kill0 probes, no credential reads")
 // Construct production private handle to isolate stop evidence without JNI/device.
 val ctor=EngineProcess::class.java.declaredConstructors.single{it.parameterCount==4}.apply{isAccessible=true}
 fun handle(root:Boolean=false):EngineProcess=ctor.newInstance(88,500,File(scratch,"engine.log"),root) as EngineProcess
 PtyBridge.stubborn=true;val live=handle();live.exitStatus.complete(0);Os.alive[500]=0;check(runCatching{live.stop(0)}.isFailure&&PtyBridge.closed==0);pass("wait status alone cannot prove stop; handle/master retained on failure")
 Os.alive[500]=1;check(runCatching{live.stop(0)}.isFailure);pass("stop EPERM never accepted as death")
 Os.alive[500]=3;live.stop(0);val closed=PtyBridge.closed;live.stop(0);check(PtyBridge.closed==closed);pass("verified ESRCH stop retry succeeds with exactly-once master close")
 val wrapper=handle(true);check(runCatching{wrapper.stop(0)}.isFailure);pass("unconfirmed root wrapper ESRCH cannot assert actual writer stopped")
 PtyBridge.stubborn=false;val badLog=File(scratch,"directory-log").apply{mkdirs()};val before=PtyBridge.closed;check(runCatching{EngineProcess.spawn(File("/node"),File("/entry"),scratch,emptyArray(),badLog,null)}.isFailure);check(PtyBridge.closed==before+1&&Os.alive[500]==3&&PtyBridge.waitCalls>0);pass("fork then append failure kills/reaps child and closes master")
 PtyBridge.stubborn=true;val leak=runCatching{EngineProcess.spawn(File("/node"),File("/entry"),scratch,emptyArray(),badLog,null)}.exceptionOrNull();check(leak is EngineStartException&&leak.failedProcess!=null);Os.alive[500]=3;leak.failedProcess!!.stop(0);PtyBridge.stubborn=false;pass("failed post-fork cleanup carries retained handle; explicit verified retry required")
 File(args[1]).writeText(CredentialsLockRecovery.ROOT_SCRIPT)
 println("TOTAL PASS "+count)
}
fun claimForAbsent(c:Context)=File(c.filesDir,"kxxy-home/.credentials.yaml.lock.takeover-"+MessageDigest.getInstance("SHA-256").digest("200\\n".toByteArray()).joinToString(""){"%02x".format(it.toInt() and 255)}.take(16))
`);
const cp=[std,ann,co].join(path.delimiter),classes=path.join(tmp,'classes'),actor=path.join(tmp,'root-actor.cjs');
function run(args){const r=spawnSync(java,args,{cwd:tmp,encoding:'utf8',timeout:120000,maxBuffer:8e6});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)throw r.error;if(r.status!==0)throw Error('Java exit '+r.status);}
run(['-cp',compiler,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',cp,'-d',classes,...stubs,tests,path.join(source,'CredentialsLockRecovery.kt'),path.join(source,'EngineProcess.kt')]);
run(['-cp',[classes,cp].join(path.delimiter),'app.kxxy.engine.LockBehaviorKt',path.join(tmp,'scratch'),actor]);
// The EXACT production root actor runs with REAL filesystem I/O and injected metadata/kill0 only.
const actorText=fs.readFileSync(actor,'utf8');
let rootCases=0;
function rootActor(name,record='777\n',behavior={}){
 const files=path.join(tmp,'actor-'+name);fs.mkdirSync(files);const home=path.join(files,'kxxy-home');fs.mkdirSync(home);const lock=path.join(home,'.credentials.yaml.lock');
 fs.writeFileSync(path.join(home,'.credentials.yaml'),'ROOT-SECRET-UNREAD');if(record!==null)fs.writeFileSync(lock,record);
 const claims=new Map(),fdPaths=new Map();let output='',seq=1000n;
 function decorated(p){const s=fs.lstatSync(p,{bigint:true});let mode=s.isDirectory()?16832n:33152n;if(behavior.group&&p===lock)mode=33184n;return Object.assign(s,{uid:12345n,gid:12345n,mode,nlink:behavior.hard&&p===lock?2n:s.nlink,ino:claims.get(p)||s.ino});}
 const procs=new Map([[999,{uid:0,ppid:1,cmd:'node\0',exe:'/system/bin/node',cwd:'/'}],[100,{uid:12345,ppid:1,cmd:'app.kxxy\0',exe:'/system/bin/app_process64',cwd:'/'}],[1,{uid:0,ppid:0,cmd:'init\0',exe:'/init',cwd:'/'}],...(behavior.processes||[]).map(p=>[p.pid,p])]);
 const procHandles=new Map();let procFd=-1,surveys=0;
 function procInfo(p){const id=Number(p.split('/')[2]),value=procs.get(id);if(!value){const e=Error('missing proc');e.code='ENOENT';throw e;}if(behavior.procDenied===id){const e=Error('denied proc');e.code='EACCES';throw e;}return value;}
 const io={...fs,lstatSync(p){if(p.startsWith('/proc/')){const v=procInfo(p);return {uid:BigInt(v.uid),isDirectory:()=>true};}return decorated(p);},fstatSync:(fd)=>decorated(fdPaths.get(fd)),realpathSync:p=>p,
 readdirSync(p,...args){if(p!=='/proc')return fs.readdirSync(p,...args);surveys++;if(behavior.lateWriter&&surveys===2)procs.set(222,{uid:12345,ppid:100,cmd:'node\0',exe:path.join(files,'engine/bin/node'),cwd:home});return [...procs.keys()].map(String);},
 readlinkSync(p){const v=procInfo(p);return p.endsWith('/exe')?v.exe:v.cwd;},
 openSync(p,flags,mode){if(p.startsWith('/proc/')){const v=procInfo(p);let text;if(p.endsWith('/stat')){const f=Array(20).fill('0');f[0]='S';f[1]=String(v.ppid||0);f[19]='10';text=p.split('/')[2]+' (process) '+f.join(' ');}else if(p.endsWith('/status'))text='Uid:\t'+(v.uids||[v.uid,v.uid,v.uid,v.uid]).join('\t')+'\n';else text=v.cmd;const fd=procFd--;procHandles.set(fd,{bytes:Buffer.from(text),offset:0});return fd;}if(path.basename(p)==='.credentials.yaml')throw Error('opened credential');const fd=fs.openSync(p,flags,mode);fdPaths.set(fd,p);if(p.includes('.takeover-')&&behavior.recordRace)fs.writeFileSync(lock,'778\n');return fd;},
 readSync(fd,b,offset,length,pos){if(!procHandles.has(fd))return fs.readSync(fd,b,offset,length,pos);const h=procHandles.get(fd),n=Math.min(length,h.bytes.length-h.offset);h.bytes.copy(b,offset,h.offset,h.offset+n);h.offset+=n;return n;},
 closeSync(fd){if(procHandles.delete(fd))return;fdPaths.delete(fd);return fs.closeSync(fd);},chownSync(){},fchownSync(){},fchmodSync(){},renameSync(a,b){fs.renameSync(a,b);for(const [fd,p] of fdPaths)if(p===a)fdPaths.set(fd,b);if(behavior.postRace)fs.writeFileSync(lock,'779\n');if(behavior.claimRace){const c=fs.readdirSync(home).find(n=>n.includes('.takeover-'));claims.set(path.join(home,c),seq++);}},};
 if(behavior.claim){const c=lock+'.takeover-'+crypto.createHash('sha256').update(record).digest('hex').slice(0,16);fs.writeFileSync(c,'888\n');}
 const processStub={argv:['node',files,home,'12345','12345','100',files,'repair-nonce','/system/bin/su'],pid:999,getuid:()=>0,kill(pid,s){if(s!==0)throw Error('nonzero kill');if(pid===behavior.alive||procs.has(pid))return;const e=Error('probe');e.code=behavior.eperm?'EPERM':'ESRCH';throw e;},exit(){throw Error('test exit');}};
 vm.runInNewContext(actorText,{require:n=>n==='node:fs'?io:n==='node:crypto'?crypto:n==='node:path'?path:null,process:processStub,console:{log:s=>output+=s+'\n'},Buffer},{timeout:5000});
 const ok=output.includes('KXXY_LOCK|OK|'),expected=behavior.ok??true;if(ok!==expected)throw Error(name+' unexpected '+output);
 if(!ok&&!behavior.postRace&&record!==null&&!fs.readFileSync(lock).equals(Buffer.from(behavior.recordRace?'778\n':record)))throw Error(name+' lock mutated');
 if(fs.readFileSync(path.join(home,'.credentials.yaml'),'utf8')!=='ROOT-SECRET-UNREAD')throw Error('credential changed');
 if(ok&&record!==null){const backup=fs.readdirSync(home).find(n=>n.includes('lock-recovery-'));if(!backup||!fs.readFileSync(path.join(home,backup,'lock')).equals(Buffer.from(record)))throw Error(name+' backup record not preserved');const journal=fs.readdirSync(files).find(n=>n.endsWith('.journal'));if(!journal||fs.readFileSync(path.join(files,journal),'utf8').includes('legacy-lock-secret'))throw Error(name+' journal missing or leaked malformed contents');}
 rootCases++;console.log('PASS fixed production root actor '+name);
}
rootActor('dead');rootActor('missing',null);rootActor('active','777\n',{alive:777,ok:false});rootActor('eperm','777\n',{eperm:true,ok:false});rootActor('claim','777\n',{claim:true,ok:false});rootActor('group','777\n',{group:true,ok:false});rootActor('hard','777\n',{hard:true,ok:false});rootActor('record-race','777\n',{recordRace:true,ok:false});rootActor('post-race','777\n',{postRace:true,ok:false});rootActor('claim-release','777\n',{claimRace:true});
rootActor('malformed','777\n\n');rootActor('empty','');rootActor('legacy-secret','legacy-lock-secret');rootActor('high-bit',Buffer.from([0xb7,0x37,0x37,10]));rootActor('long-legacy','x'.repeat(4096));rootActor('oversize','x'.repeat(4097),{ok:false});
rootActor('malformed-app-writer','legacy',{processes:[{pid:222,uid:12345,cmd:'node\0',exe:'/system/bin/node',cwd:'/'}],ok:false});
rootActor('malformed-saved-app-uid','legacy',{processes:[{pid:222,uid:0,uids:[0,0,12345,0],cmd:'node\0',exe:'/system/bin/node',cwd:'/'}],ok:false});
rootActor('malformed-own-su-client','legacy',{processes:[{pid:222,uid:12345,ppid:100,cmd:'/system/bin/su\0-c\0command repair-nonce\0',exe:'/system/bin/su',cwd:'/'}]});
rootActor('malformed-other-su-client','legacy',{processes:[{pid:222,uid:12345,ppid:100,cmd:'/system/bin/su\0-c\0other command\0',exe:'/system/bin/su',cwd:'/'}],ok:false});
rootActor('malformed-root-writer','legacy',{processes:[{pid:222,uid:0,cmd:filesForActor('malformed-root-writer')+'/engine/bin/node\0',exe:'/system/bin/node',cwd:'/'}],ok:false});
rootActor('malformed-relative-root-writer','legacy',{processes:[{pid:222,uid:0,cmd:'node\0',exe:filesForActor('malformed-relative-root-writer')+'/engine/bin/node',cwd:'/'}],ok:false});
rootActor('malformed-root-cwd','legacy',{processes:[{pid:222,uid:0,cmd:'sh\0',exe:'/system/bin/sh',cwd:filesForActor('malformed-root-cwd')+'/kxxy-home'}],ok:false});
rootActor('malformed-unreadable-proc','legacy',{procDenied:1,ok:false});rootActor('malformed-late-writer','legacy',{lateWriter:true,ok:false});rootActor('malformed-existing-claim','legacy',{claim:true,ok:false});
function filesForActor(name){return path.join(tmp,'actor-'+name);}
console.log('TOTAL ROOT ACTOR PASS '+rootCases);
// Supervisor integration remains production-source gate assertions; full Android compile is separate.
const supervisor=fs.readFileSync(path.join(source,'EngineSupervisor.kt'),'utf8');
if(!supervisor.includes('writersStopped = true')||!supervisor.includes('RecoveryManager.Target.BOOT_DATA'))throw Error('missing supervisor gate/result');
if(/catch\s*\(e:[^)]*\)[\s\S]*?process = null/.test(supervisor.slice(supervisor.indexOf('private suspend fun cleanupProcess'),supervisor.indexOf('/** Serial stop + repair'))))throw Error('cleanup swallows failure');
console.log('PASS supervisor verified stop forwarding and BOOT_DATA result integration');
// Load the real zero-dependency packed module in a separate new extraction directory.
const officialDir=fs.mkdtempSync(path.join(os.tmpdir(),'kxxy-official-atomic-'));
const officialPath=path.join(officialDir,'atomic-write.mjs');
const packed=openZip(process.env.KXXY_RUNTIME_ZIP||path.join(root,'.cache/apk-assets-hold/runtime.zip')).read('lib/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js');
if(!packed)throw Error('Packed atomic-write module missing');fs.writeFileSync(officialPath,packed);
const {withFileLock}=await import(pathToFileURL(officialPath).href);
const officialHome=path.join(tmp,'official-data');fs.mkdirSync(officialHome);
const officialTarget=path.join(officialHome,'.credentials.yaml'),officialLock=officialTarget+'.lock';
await withFileLock(officialTarget,async()=>{
 if(fs.readFileSync(officialLock,'utf8')!==process.pid+'\n')throw Error('official PID contract');
 let timedOut=false;try{await withFileLock(officialTarget,async()=>{throw Error('active unexpectedly acquired')},{waitMs:30})}catch(e){timedOut=e.message.includes('timed out waiting')}
 if(!timedOut)throw Error('official active timeout absent');
},{waitMs:100});
console.log('PASS REAL packed atomic-write active exact PID record and contention timeout');
// Obtain a genuinely exited PID from a real child, not a guessed PID.
const gone=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{cwd:tmp,encoding:'utf8'});if(gone.status!==0)throw Error('dead PID child failed');
const deadPid=Number(gone.stdout);try{process.kill(deadPid,0);throw Error('child PID reused')}catch(e){if(e.code!=='ESRCH')throw e}
fs.writeFileSync(officialLock,deadPid+'\n');
await withFileLock(officialTarget,async()=>{if(fs.readFileSync(officialLock,'utf8')!==process.pid+'\n')throw Error('dead takeover not own record')},{waitMs:100});
if(fs.readdirSync(officialHome).some(n=>n.includes('.takeover-')))throw Error('official claim leaked');
console.log('PASS REAL packed atomic-write ESRCH dead takeover and official claim release');
const malformedRecord='not-a-pid\n';fs.writeFileSync(officialLock,malformedRecord);let invalidTimeout=false;
try{await withFileLock(officialTarget,async()=>{}, {waitMs:30})}catch(e){invalidTimeout=e.message.includes('timed out waiting')}
if(!invalidTimeout||fs.readFileSync(officialLock,'utf8')!==malformedRecord)throw Error('official malformed mutated');
console.log('PASS REAL packed atomic-write malformed waits without mutation');
fs.unlinkSync(officialLock);const officialClaim=officialLock+'.takeover-'+crypto.createHash('sha256').update(deadPid+'\n').digest('hex').slice(0,16);fs.writeFileSync(officialLock,deadPid+'\n');fs.writeFileSync(officialClaim,process.pid+'\n');let claimTimeout=false;
try{await withFileLock(officialTarget,async()=>{}, {waitMs:30})}catch(e){claimTimeout=e.message.includes('timed out waiting')}
if(!claimTimeout||!fs.existsSync(officialLock)||!fs.existsSync(officialClaim))throw Error('official existing claim mutated');
console.log('PASS REAL packed atomic-write official existing claim refuses takeover');
console.log('Artifacts retained: '+tmp+'; official module: '+officialDir);
