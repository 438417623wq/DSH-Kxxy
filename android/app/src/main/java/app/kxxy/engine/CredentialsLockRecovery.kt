package app.kxxy.engine

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

/** Metadata-only writer-lock rescue. Never opens credentials, scans home or kills a recorded PID. */
object CredentialsLockRecovery {
    private const val NAME = ".credentials.yaml.lock"
    private const val PRIVATE_FILE = 384 // 0600
    private const val PRIVATE_DIR = 448 // 0700
    private const val RECORD_LIMIT = 32
    private val mutex = Mutex()
    private class Refused(message: String, val root: Boolean = false) : Exception(message)
    private data class Scope(val files: File, val home: File, val parents: List<Pair<File, StructStat>>) {
        val file get() = File(home, NAME)
    }
    private data class Record(val stat: StructStat, val bytes: ByteArray, val pid: Int) {
        fun text() = "dev=${stat.st_dev} inode=${stat.st_ino} owner=${stat.st_uid}:${stat.st_gid} mode=${Integer.toOctalString(stat.st_mode)} nlink=${stat.st_nlink} pid=$pid record=${hex(bytes)}"
    }
    private fun identity(a: StructStat, b: StructStat) = a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_nlink == b.st_nlink
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun parse(bytes: ByteArray): Int {
        val record = String(bytes, Charsets.US_ASCII)
        if (!Regex("[0-9]+\n").matches(record)) throw Refused("锁记录不是上游 PID\\n 格式；需显式 Root 核验写入进程后备份隔离", true)
        return record.dropLast(1).toLongOrNull()?.takeIf { it in 1..2147483647L }?.toInt()
            ?: throw Refused("锁 PID 超出 1..2147483647；需显式 Root 核验写入进程后备份隔离", true)
    }
    private fun validate(stat: StructStat) {
        if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_nlink != 1L || (stat.st_mode and 4095) != PRIVATE_FILE) {
            throw Refused("拒绝非 regular、符号链接、多硬链接或非 0600 的锁/claim")
        }
    }
    private fun scope(ctx: Context): Scope {
        val raw = ctx.filesDir.absoluteFile
        var ancestor: File? = raw
        while (ancestor != null) {
            val stat = Os.lstat(ancestor.absolutePath)
            if (OsConstants.S_ISLNK(stat.st_mode) && (ancestor == raw || stat.st_uid != 0)) throw Refused("拒绝用户可控符号链接父目录")
            ancestor = ancestor.parentFile
        }
        val files = raw.canonicalFile
        val home = File(files, "kxxy-home")
        val parents = listOf(files, home).map { dir ->
            val stat = Os.lstat(dir.absolutePath)
            if (!OsConstants.S_ISDIR(stat.st_mode) || stat.st_uid != android.os.Process.myUid() || (stat.st_mode and 18) != 0) {
                throw Refused("锁父目录非应用私有或 group/world 可写；需先修复固定父目录", true)
            }
            dir to stat
        }
        return Scope(files, home, parents).also { checkParents(it) }
    }
    private fun checkParents(scope: Scope) {
        scope.parents.forEach { (dir, stat) ->
            if (dir.canonicalFile != dir || !identity(stat, Os.lstat(dir.absolutePath))) throw Refused("canonical 父目录/inode 已变；停止锁修复")
        }
    }
    private fun read(file: File): Record {
        val before = Os.lstat(file.absolutePath)
        validate(before)
        if (before.st_size > RECORD_LIMIT) throw Refused("锁记录超过 PID 格式的 32 bytes；需显式 Root 核验写入进程后备份隔离", true)
        val fd = Os.open(file.absolutePath, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK, 0)
        try {
            val opened = Os.fstat(fd)
            validate(opened)
            if (!identity(before, opened)) throw Refused("打开锁期间 inode 已变")
            val bytes = ByteArray(RECORD_LIMIT + 1)
            var size = 0
            while (size < bytes.size) {
                val count = Os.read(fd, bytes, size, bytes.size - size)
                if (count <= 0) break
                size += count
            }
            if (size > RECORD_LIMIT || !identity(opened, Os.fstat(fd)) || !identity(opened, Os.lstat(file.absolutePath))) throw Refused("读取期间锁更换/超长")
            val record = bytes.copyOf(size)
            return Record(opened, record, parse(record))
        } finally { Os.close(fd) }
    }
    private fun exited(pid: Int): Boolean {
        if (pid == android.os.Process.myPid()) return false
        return try { Os.kill(pid, 0); false } catch (e: ErrnoException) {
            when (e.errno) {
                OsConstants.ESRCH -> true
                OsConstants.EPERM -> throw Refused("holder kill(pid,0)=EPERM；未知/存活，禁止隔离", true)
                else -> throw Refused("holder kill(pid,0) errno=${e.errno}；禁止推测死亡")
            }
        }
    }
    private fun claim(scope: Scope, record: Record) = File(scope.home, "$NAME.takeover-${hex(MessageDigest.getInstance("SHA-256").digest(record.bytes)).take(16)}")
    private fun existingClaim(file: File) {
        val stat = try { Os.lstat(file.absolutePath) } catch (e: ErrnoException) { if (e.errno == OsConstants.ENOENT) return else throw e }
        val summary = "${file.name}: dev=${stat.st_dev} inode=${stat.st_ino} owner=${stat.st_uid}:${stat.st_gid} mode=${Integer.toOctalString(stat.st_mode)} nlink=${stat.st_nlink}"
        val status = try { val r = read(file); if (exited(r.pid)) "ESRCH，但不自动清理既存 claim" else "holder 存活/当前 PID" } catch (e: Exception) { reason(e) }
        throw Refused("官方 takeover claim 已存在；拒绝并发/遗留 claim，未更改。$summary $status")
    }
    private fun inspect(ctx: Context): String? {
        val s = scope(ctx)
        val r = read(s.file)
        val c = claim(s, r)
        existingClaim(c)
        return if (exited(r.pid)) "$NAME: stale ESRCH；${r.text()}，需 verified stop 后隔离" else "$NAME: holder 存活/当前 PID；${r.text()}，禁止隔离"
    }
    fun issue(ctx: Context): String? = try { inspect(ctx)?.takeUnless { it.contains(": holder 存活/当前 PID；") } } catch (e: Exception) { if (e is ErrnoException && e.errno == OsConstants.ENOENT) null else "$NAME: ${reason(e)}" }
    fun report(ctx: Context): String = try { inspect(ctx) ?: "$NAME: absent" } catch (e: Exception) { if (e is ErrnoException && e.errno == OsConstants.ENOENT) "$NAME: ENOENT（无需操作）" else "$NAME: ${reason(e)}" }

    suspend fun repair(ctx: Context, allowRoot: Boolean = false, writersStopped: Boolean = false): UserDataPermissions.Outcome = withContext(Dispatchers.IO) {
        mutex.withLock {
            if (!writersStopped) return@withLock UserDataPermissions.Outcome(false, emptyList(), "锁修复必须先成功验证 supervisor writersStopped；未操作")
            val changes = mutableListOf<String>()
            try {
                val s = try { scope(ctx) } catch (e: ErrnoException) {
                    if (e.errno == OsConstants.ENOENT) return@withLock UserDataPermissions.Outcome(true, emptyList(), "锁/固定 home 不存在；零操作") else throw e
                }
                val r = try { read(s.file) } catch (e: ErrnoException) {
                    if (e.errno == OsConstants.ENOENT) return@withLock UserDataPermissions.Outcome(true, emptyList(), "锁不存在；零操作") else throw e
                }
                if (!exited(r.pid)) throw Refused("holder 存活/当前 PID；未操作。${r.text()}")
                existingClaim(claim(s, r))
                if (r.stat.st_uid != android.os.Process.myUid()) throw Refused("锁非应用 uid 持有；隔离需要再次明确确认 Root。${r.text()}", true)
                quarantine(s, r, changes)
                UserDataPermissions.Outcome(true, changes.toList(), "仅隔离经两次 ESRCH 与 inode/record 验证的官方锁；未读取/修改凭据")
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                val root = (e as? Refused)?.root == true || (e as? ErrnoException)?.errno in listOf(OsConstants.EACCES, OsConstants.EPERM)
                if (root && allowRoot && changes.isEmpty()) rootRepair(ctx) else UserDataPermissions.Outcome(false, changes.toList(), reason(e), root)
            }
        }
    }
    private fun quarantine(s: Scope, original: Record, changes: MutableList<String>) {
        val c = claim(s, original)
        checkParents(s)
        val fd = Os.open(c.absolutePath, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW, PRIVATE_FILE)
        val own = Os.fstat(fd)
        var journal: FileOutputStream? = null
        try {
            validate(own)
            if (own.st_uid != android.os.Process.myUid()) throw Refused("本次 claim owner 不安全")
            val bytes = "${android.os.Process.myPid()}\n".toByteArray(Charsets.US_ASCII)
            var offset = 0
            while (offset < bytes.size) { val n = Os.write(fd, bytes, offset, bytes.size - offset); if (n <= 0) throw Refused("claim 短写"); offset += n }
            Os.fsync(fd)
            checkParents(s)
            val again = read(s.file)
            if (!identity(original.stat, again.stat) || !original.bytes.contentEquals(again.bytes) || !exited(again.pid)) throw Refused("claim 后锁 inode/record/PID 已变化；未隔离")
            val id = UUID.randomUUID().toString()
            val backupDir = File(s.home, ".$NAME-recovery-$id")
            val journalFile = File(s.files, "credentials-lock-$id.journal")
            val stream = FileOutputStream(Os.open(journalFile.absolutePath, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW, PRIVATE_FILE))
            journal = stream
            fun log(text: String) { stream.write((text.take(3000) + "\n").toByteArray()); stream.flush(); stream.fd.sync() }
            log("before ${original.text()} claim=${c.name} claim-inode=${own.st_ino} backup=${backupDir.name}/lock")
            Os.mkdir(backupDir.absolutePath, PRIVATE_DIR)
            val dirStat = Os.lstat(backupDir.absolutePath)
            if (!OsConstants.S_ISDIR(dirStat.st_mode) || dirStat.st_uid != android.os.Process.myUid() || dirStat.st_dev != original.stat.st_dev || (dirStat.st_mode and 4095) != PRIVATE_DIR) throw Refused("backup 不是同文件系统的应用私有目录")
            val backup = File(backupDir, "lock")
            checkParents(s)
            val last = read(s.file)
            if (!identity(original.stat, last.stat) || !original.bytes.contentEquals(last.bytes) || !exited(last.pid)) throw Refused("rename 前锁已变化；停止")
            Os.rename(s.file.absolutePath, backup.absolutePath)
            changes += "$NAME: 原子隔离到 ${backupDir.name}/lock（保留 PID record 与元数据日志）"
            val after = read(backup)
            if (!identity(original.stat, after.stat) || !original.bytes.contentEquals(after.bytes)) {
                // Never overwrite a concurrently created lock, nor move an unidentified backup.
                throw Refused("隔离后 inode/record 不一致；保留私有 backup，禁止覆盖新锁")
            }
            checkParents(s)
            try { Os.lstat(s.file.absolutePath); throw Refused("隔离后出现新锁；未触碰新锁，保留 backup") } catch (e: ErrnoException) { if (e.errno != OsConstants.ENOENT) throw e }
            log("completed ${after.text()}")
        } finally {
            try { journal?.close() } finally {
                Os.close(fd)
                val actual = try { Os.lstat(c.absolutePath) } catch (e: ErrnoException) { if (e.errno == OsConstants.ENOENT) null else throw e }
                if (actual != null && identity(own, actual) && OsConstants.S_ISREG(actual.st_mode) && actual.st_nlink == 1L) {
                    checkParents(s)
                    Os.remove(c.absolutePath)
                }
            }
        }
    }
    private fun reason(e: Exception) = when (e) {
        is ErrnoException -> "errno=${e.errno}（EACCES/EPERM 不是不存在；未读取凭据）"
        else -> e.message ?: e.javaClass.simpleName
    }

    /** Root actor uses only built-in fs/crypto and a fixed script; no NODE_OPTIONS/LD_PRELOAD/user env. */
    private suspend fun rootRepair(ctx: Context): UserDataPermissions.Outcome {
        val prefix = Privilege.explicitRepairSuPrefix() ?: return UserDataPermissions.Outcome(false, emptyList(), "显式 Root 授权/探测失败；未操作锁", true)
        return try {
            val s = scope(ctx)
            val node = File(s.files, "engine/bin/node")
            val dirs = listOf(File(s.files, "engine"), node.parentFile, File(s.files, "engine/lib"))
            val paths = dirs + node
            val stats = paths.map { path ->
                val st = Os.lstat(path.absolutePath)
                if (path.canonicalFile != path || st.st_uid != android.os.Process.myUid() || (st.st_mode and 18) != 0 ||
                    (if (path == node) !OsConstants.S_ISREG(st.st_mode) || st.st_nlink != 1L else !OsConstants.S_ISDIR(st.st_mode))) throw Refused("Root actor runtime 路径不安全；拒绝执行")
                st
            }
            val guard = (s.parents + paths.zip(stats)).joinToString("") { (p, st) ->
                val q = Privilege.shellQuote(p.absolutePath)
                "[ ! -L $q ] && [ \"$(/system/bin/stat -c '%d:%i:%u:%g:%f:%h' $q)\" = '${st.st_dev}:${st.st_ino}:${st.st_uid}:${st.st_gid}:${Integer.toHexString(st.st_mode)}:${st.st_nlink}' ] || exit 85; "
            }
            val runId = UUID.randomUUID().toString()
            val command = "cd / || exit 80; " + guard + "exec /system/bin/env -i PATH=/system/bin LD_LIBRARY_PATH=" + Privilege.shellQuote(File(s.files, "engine/lib").absolutePath) + " " + Privilege.shellQuote(node.absolutePath) + " -e " + Privilege.shellQuote(ROOT_SCRIPT) + " -- " + listOf(s.files.absolutePath, s.home.absolutePath, android.os.Process.myUid().toString(), Os.getgid().toString(), android.os.Process.myPid().toString(), ctx.filesDir.absoluteFile.absolutePath, runId, prefix.first()).joinToString(" ") { Privilege.shellQuote(it) }
            val out = Privilege.runExplicitRepairSu(prefix, command, 15_000L)
            val line = out.text.lineSequence().singleOrNull { it.startsWith("KXXY_LOCK|") }
            if (!out.ok || out.truncated || line == null) UserDataPermissions.Outcome(false, emptyList(), "Root 锁协议失败 status=${out.status} exit=${out.exitCode}；请重查锁/私有日志（可能已隔离，绝不假成功）", true)
            else {
                val v = line.split('|', limit = 4)
                if (v.size != 4) throw Refused("Root 锁结果协议无效")
                UserDataPermissions.Outcome(v[1] == "OK", if (v[2] == "1") listOf("$NAME: Root 原子隔离；保留 app-owned 私有 backup 与原元数据日志") else emptyList(), v[3], v[1] != "OK")
            }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { UserDataPermissions.Outcome(false, emptyList(), reason(e), true) }
    }

    // Exported only internally so host tests execute the exact root actor with real Node fs.
    internal val ROOT_SCRIPT = """
        const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
        const [files,home,uidText,gidText,appPidText,filesAlias,runId,suPath]=process.argv.slice(1),uid=Number(uidText),gid=Number(gidText),appPid=Number(appPidText),C=fs.constants;
        const lock=path.join(home,'.credentials.yaml.lock');let moved=false,claim,claimMeta,fd,journal;
        function fail(s){throw Error(s)}
        function stat(p){return fs.lstatSync(p,{bigint:true})}
        function same(a,b){return ['dev','ino','mode','uid','gid','nlink'].every(k=>a[k]===b[k])}
        function valid(s){if(!s.isFile()||s.nlink!==1n||(s.mode&4095n)!==384n)fail('unsafe regular/0600/nlink lock or claim')}
        function meta(s){return ['dev','ino','uid','gid','mode','nlink'].map(k=>k+'='+s[k]).join(' ')}
        function parent(p){const s=stat(p);if(!s.isDirectory()||s.uid!==BigInt(uid)||(s.mode&18n)!==0n||fs.realpathSync(p)!==p)fail('unsafe canonical app parent');return s}
        let parents;
        function guard(){parents.forEach(([p,s])=>{if(!same(s,parent(p)))fail('parent replaced')})}
        function read(p){const s=stat(p);valid(s);if(s.size>4096n)fail('oversize record');const f=fs.openSync(p,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{if(!same(s,fs.fstatSync(f,{bigint:true})))fail('open race');const b=Buffer.alloc(4097);let n=0,k;while(n<b.length&&(k=fs.readSync(f,b,n,b.length-n,null))>0)n+=k;const record=b.subarray(0,n);if(n>4096||!same(s,stat(p))||!same(s,fs.fstatSync(f,{bigint:true})))fail('read race');const text=record.toString('latin1'),number=Number(text.slice(0,-1));const pid=/^[0-9]+\n$/.exec(text)?.[0]===text&&Number.isInteger(number)&&number>=1&&number<=2147483647?number:null;return {s,record,pid}}finally{fs.closeSync(f)}}
        function dead(pid){if(pid===process.pid)return false;try{process.kill(pid,0);return false}catch(e){if(e.code==='ESRCH')return true;if(e.code==='EPERM')fail('holder EPERM/unknown');fail('kill0 unknown '+e.code)}}
        function absent(p){try{stat(p);return false}catch(e){if(e.code==='ENOENT')return true;throw e}}
        // Unknown records cannot name a holder. Only explicit Root can survey /proc, and
        // every process must be readable. Do not infer death from age, timeout or PID text.
        function procRead(p,limit){const f=fs.openSync(p,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const b=Buffer.alloc(limit+1);let n=0,k;while(n<b.length&&(k=fs.readSync(f,b,n,b.length-n,null))>0)n+=k;if(n>limit)fail('process metadata limit');return b.subarray(0,n).toString('utf8')}finally{fs.closeSync(f)}}
        function proc(pid){const base='/proc/'+pid,s=stat(base);if(!s.isDirectory())fail('invalid proc entry');const t=procRead(base+'/stat',8192),fields=t.slice(t.lastIndexOf(')')+2).trim().split(/\s+/);if(fields.length<20)fail('invalid proc stat');const ppid=Number(fields[1]);if(!Number.isInteger(ppid)||ppid<0)fail('invalid proc parent');const match=/^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/m.exec(procRead(base+'/status',16384));if(!match)fail('invalid process uid');const uids=match.slice(1).map(BigInt);function link(n){try{return fs.readlinkSync(base+'/'+n)}catch(e){if(e.code==='ENOENT')return '';throw e}}const exe=link('exe'),cwd=link('cwd');if(!exe&&!cwd&&fields[0]!=='Z'&&(BigInt(fields[6])&2097152n)===0n)fail('unidentified process pid='+pid);return {uid:uids[1],uids,start:fields[19],ppid,cmd:procRead(base+'/cmdline',65536),exe,cwd}}
        let nativeStart;
        function noWriters(){
          if(!Number.isInteger(appPid)||appPid<=0||!filesAlias||!path.isAbsolute(filesAlias)||!runId||!suPath||!path.isAbsolute(suPath))fail('missing native process identity');
          const deadline=Date.now()+2000,ancestors=new Set();let pid=process.pid;
          for(let i=0;pid>0;i++){if(i>=32||ancestors.has(pid))fail('process ancestry limit');ancestors.add(pid);pid=proc(pid).ppid}
          const entries=fs.readdirSync('/proc').filter(n=>/^[1-9][0-9]*$/.test(n));if(entries.length>8192)fail('process count limit');
          let appSeen=false;
          for(const entry of entries){if(Date.now()>deadline)fail('process survey timeout');const p=Number(entry);if(p===process.pid)continue;let a;
            try{a=proc(p)}catch(e){if(e.code==='ENOENT'&&dead(p))continue;throw e}
            if(p===appPid){if(a.uids.some(v=>v!==BigInt(uid))||a.cmd.split('\0')[0]!=='app.kxxy'||(nativeStart!==undefined&&nativeStart!==a.start))fail('native process identity changed');nativeStart=a.start;appSeen=true;continue}
            // Magisk may retain an app-uid su client while its daemon runs the actor.
            // Identify this exact native child by the per-run nonce and su executable.
            const helperClient=a.ppid===appPid&&a.cmd.includes(runId)&&(a.cmd.split('\0')[0]===suPath||a.exe===fs.realpathSync(suPath));
            const mentions=[files,filesAlias].some(base=>a.cmd.includes(base+'/')||[a.exe,a.cwd].some(v=>v===base||v.startsWith(base+'/')));
            if(!helperClient&&(a.uids.some(v=>v===BigInt(uid))||(mentions&&!ancestors.has(p))))fail('writer process still present pid='+p);
            const b=proc(p);if(a.uids.join(',')!==b.uids.join(',')||a.start!==b.start||a.cmd!==b.cmd||a.exe!==b.exe||a.cwd!==b.cwd)fail('process changed during survey');
          }
          if(!appSeen)fail('native process absent during survey');
        }
        function stopped(r){if(r.pid===null)noWriters();else if(!dead(r.pid))fail('live/current holder; refused '+meta(r.s))}
        function log(s){fs.writeSync(journal,s.slice(0,3000)+'\n');fs.fsyncSync(journal)}
        try{
          if(!Number.isInteger(uid)||uid<=0||!Number.isInteger(gid)||gid<0||process.getuid()!==0)fail('root identity invalid');
          if(absent(home)){console.log('KXXY_LOCK|OK|0|home missing; zero changes');process.exit(0)}
          parents=[[files,parent(files)],[home,parent(home)]];guard();
          if(absent(lock)){console.log('KXXY_LOCK|OK|0|lock missing; zero changes');process.exit(0)}
          const r=read(lock);stopped(r);
          claim=lock+'.takeover-'+crypto.createHash('sha256').update(r.record).digest('hex').slice(0,16);
          if(!absent(claim)){const s=stat(claim);fail('existing official claim '+path.basename(claim)+' '+meta(s)+'; no cleanup')}
          guard();fd=fs.openSync(claim,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,384);claimMeta=fs.fstatSync(fd,{bigint:true});valid(claimMeta);
          fs.writeFileSync(fd,String(process.pid)+'\n');fs.fsyncSync(fd);guard();
          const again=read(lock);if(!same(r.s,again.s)||!r.record.equals(again.record))fail('claim race');stopped(again);
          const id=crypto.randomUUID(),dir=path.join(home,'..credentials.yaml.lock-recovery-'+id),backup=path.join(dir,'lock');
          journal=fs.openSync(path.join(files,'credentials-lock-'+id+'.journal'),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,384);fs.fchownSync(journal,uid,gid);
          log('before '+meta(r.s)+' pid='+r.pid+' bytes='+r.record.length+' sha256='+crypto.createHash('sha256').update(r.record).digest('hex')+' claim='+path.basename(claim)+' backup='+path.basename(dir)+'/lock');
          fs.mkdirSync(dir,{mode:448});fs.chownSync(dir,uid,gid);const d=parent(dir);if(d.dev!==r.s.dev)fail('backup filesystem mismatch');
          guard();const last=read(lock);if(!same(r.s,last.s)||!r.record.equals(last.record))fail('pre-rename race');stopped(last);
          fs.renameSync(lock,backup);moved=true;const after=read(backup);if(!same(r.s,after.s)||!r.record.equals(after.record))fail('post-rename race; retained backup');
          guard();if(!absent(lock))fail('new lock appeared; retained backup, new lock untouched');
          const bfd=fs.openSync(backup,C.O_RDONLY|C.O_NOFOLLOW);try{if(!same(r.s,fs.fstatSync(bfd,{bigint:true})))fail('backup replaced');fs.fchownSync(bfd,uid,gid);fs.fchmodSync(bfd,384)}finally{fs.closeSync(bfd)}
          log('completed '+meta(stat(backup)));console.log('KXXY_LOCK|OK|1|'+(r.pid===null?'malformed lock quarantined after Root process survey':'stale ESRCH lock quarantined')+'; credentials never opened');
        }catch(e){console.log('KXXY_LOCK|FAIL|'+(moved?'1':'0')+'|'+String(e.message||e.code).replace(/[|\r\n]/g,' ').slice(0,1800))}
        finally{if(journal!==undefined)fs.closeSync(journal);if(fd!==undefined)fs.closeSync(fd);if(claimMeta&&!absent(claim)){guard();const s=stat(claim);if(same(s,claimMeta)&&s.isFile()&&s.nlink===1n)fs.unlinkSync(claim)}}
    """.trimIndent()
}
