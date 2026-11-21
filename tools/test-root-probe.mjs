// Source-contract and mocked-output tests only; no su, Android build, or device operations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const engine=path.join(root,'android/app/src/main/java/app/kxxy/engine');
const privilege=fs.readFileSync(path.join(engine,'Privilege.kt'),'utf8');
const runner=fs.readFileSync(path.join(engine,'RecoveryProcessRunner.kt'),'utf8');
let count=0;
function pass(name){count++;console.log('PASS '+name);}
function section(start,end){
  const from=privilege.indexOf(start),to=privilege.indexOf(end,from+start.length);
  assert.ok(from>=0 && to>from,'Missing source section '+start);
  return privilege.slice(from,to);
}
function kotlinString(name){
  const match=privilege.match(new RegExp('private const val '+name+' = ("(?:[^"\\\\]|\\\\.)*")'));
  assert.ok(match,'Missing string constant '+name);
  return JSON.parse(match[1]);
}

const sentinel=kotlinString('ROOT_PROBE_SENTINEL');
const command=kotlinString('ROOT_PROBE_COMMAND');
assert.equal(sentinel,'KXXY_ROOT_PROBE_OK');
assert.equal(command,`cd / && [ "$(/system/bin/id -u)" = 0 ] && printf '${sentinel}\\n'`);
assert.ok(!privilege.includes('echo uid=0'));
assert.ok(!privilege.includes('contains("uid=0")'));
pass('ordinary root probe uses absolute id -u, checks uid 0, then prints shell sentinel');

const probe=section('fun probeRoot(): Boolean {','fun usableSuPrefix(): List<String>? {');
const prefix=section('fun usableSuPrefix(): List<String>? {','private fun trySuPrefix(');
for(const body of [probe,prefix]){
  assert.match(body,/for \(f in SU_ARG_FORMS\)/);
  assert.match(body,/if \(trySuPrefix\(f\)\)/);
}
assert.match(prefix,/val suBin = findSu\(\) \?: return null/);
assert.match(prefix,/return listOf\(suBin\) \+ f/);
pass('both ordinary entry points use same verified probe and absolute executable prefix');

const ordinary=section('private fun trySuPrefix(','/** 返回第一个存在的 su 绝对路径。 */');
assert.match(privilege,/import kotlinx\.coroutines\.runBlocking/);
assert.match(ordinary,/val out = runBlocking/);
assert.match(ordinary,/RecoveryProcessRunner\.run\(ProcessBuilder\(listOf\(suBin\) \+ args \+ ROOT_PROBE_COMMAND\)\.redirectErrorStream\(true\), 2_000L, 16 \* 1024\)/);
assert.ok(!/\.waitFor\(|\.readText\(|\.start\(|\.contains\(/.test(ordinary));
pass('ordinary probes use existing deadline and bounded-drain runner, not wait-before-read');

assert.match(runner,/val ok: Boolean get\(\) = status == Status\.EXITED && exitCode == 0/);
assert.match(runner,/Output\(status, code, text, truncated\)/);
assert.match(runner,/output\(Status\.EXITED, process\.exitValue\(\), out, err\)/);
pass('runner ok is tied to real EXITED status and process exit code 0');

// Evaluate only the exact acceptance expression after checking it in production source.
// This intentionally is not a Kotlin execution test; no compiler/build is needed.
const acceptance=ordinary.match(/\n\s*(out\.ok && !out\.truncated && out\.text\.lineSequence\(\)\.any \{ it == ROOT_PROBE_SENTINEL \})\s*\n/);
assert.ok(acceptance,'Missing strict ordinary acceptance expression');
const accepts=out=>out.ok && !out.truncated && out.text.split(/\r\n|\n|\r/).some(line=>line===sentinel);
function output(status,exitCode,text,truncated=false){return {ok:status==='EXITED' && exitCode===0,text,truncated};}
const cases=[
  ['exact sentinel with successful real exit',output('EXITED',0,sentinel+'\n'),true],
  ['complete sentinel line amid shell messages',output('EXITED',0,'notice\n'+sentinel+'\r\n'),true],
  ['echoed identity without sentinel',output('EXITED',0,'uid=0\n'),false],
  ['sentinel substring',output('EXITED',0,'prefix '+sentinel+' suffix\n'),false],
  ['sentinel with leading whitespace',output('EXITED',0,' '+sentinel+'\n'),false],
  ['sentinel with trailing whitespace',output('EXITED',0,sentinel+' \n'),false],
  ['nonzero exit despite sentinel',output('EXITED',7,sentinel+'\n'),false],
  ['timeout despite sentinel',output('TIMED_OUT',null,sentinel+'\n'),false],
  ['execution failed despite sentinel',output('EXECUTION_FAILED',null,sentinel+'\n'),false],
  ['truncated output despite sentinel',output('EXITED',0,sentinel+'\n',true),false],
  ['empty successful output',output('EXITED',0,''),false],
];
for(const [name,out,expected] of cases){assert.equal(accepts(out),expected,name);pass('mock acceptance: '+name);}

const forms=section('private val SU_ARG_FORMS = listOf(','// ── 模式持久化');
assert.match(forms,/listOf\("-c"\),\s*listOf\("0"\),\s*listOf\("root", "-c"\),/);
assert.match(privilege,/entries\.firstOrNull \{ it\.id == id \} \?: NORMAL/);
assert.match(privilege,/fun rootAvailableMinimal\(\): Boolean = SU_PATHS\.any \{ File\(it\)\.exists\(\) \}/);
pass('existing ordinary su forms, Normal default, and passive availability check are preserved');

const repair=section('internal suspend fun explicitRepairSuPrefix()','// ── Shizuku 探测');
assert.match(repair,/val forms = listOf\(listOf\("-c"\), listOf\("0", "\/system\/bin\/sh", "-c"\), listOf\("root", "-c"\)\)/);
assert.ok(repair.includes('/system/bin/id -u'));
assert.match(repair,/out\.ok && !out\.truncated && out\.text\.lineSequence\(\)\.any \{ it == "KXXY_REPAIR_ROOT_OK" \}/);
assert.match(repair,/if \(index == 0\) 15_000L else 2_000L/);
assert.match(repair,/RecoveryProcessRunner\.run\(ProcessBuilder\(prefix \+ command\)\.redirectErrorStream\(true\), timeoutMs, 16 \* 1024\)/);
pass('explicit-repair authorization entry, probe contract, and timeout choices remain unchanged');
console.log('TOTAL PASS '+count+' (source-contract/mocks only; no Kotlin or device execution)');
