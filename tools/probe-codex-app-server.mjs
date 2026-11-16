import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [executable, ...args] = process.argv.slice(2);
if (!executable) throw new Error('Usage: node tools/probe-codex-app-server.mjs <executable> [args...]');
const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map();
let serial = 0;
const timer = setTimeout(() => {
  console.error('Codex probe timed out');
  child.kill();
  process.exitCode = 1;
}, 35000);
child.stderr.on('data', (data) => process.stderr.write(data));
child.on('error', (error) => {
  console.error(error.message);
  clearTimeout(timer);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  clearTimeout(timer);
  for (const { reject } of pending.values()) reject(new Error(`Process exited: ${code}`));
});
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { console.log('non-protocol:', line); return; }
  if (message.id !== undefined && pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  } else if (message.method) console.log('event:', message.method);
});
function request(method, params) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
try {
  console.log('initialize:', JSON.stringify(await request('initialize', {
    clientInfo: { name: 'kxxy-codex-probe', title: 'Kxxy isolated compatibility probe', version: '0.1.0' },
    capabilities: { experimentalApi: false },
  })));
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const account = await request('account/read', { refreshToken: false });
  console.log('account:', JSON.stringify({ loggedIn: !!account.account, type: account.account?.type ?? null, requiresOpenaiAuth: account.requiresOpenaiAuth }));
  const models = await request('model/list', {});
  console.log('models:', JSON.stringify(models.data?.map(({ id, model, supportedReasoningEfforts }) => ({ id, model, supportedReasoningEfforts }))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.stdin.end();
  child.kill();
}
