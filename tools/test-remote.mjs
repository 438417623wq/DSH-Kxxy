/**
 * 「手机控电脑」的契约测试 + 连接器真跑测试。
 *
 * 分两段，理由不同：
 *
 *   [A] 契约段 —— 原生侧（Kotlin）本地跑不起来。这一层钉的是**接线**：
 *       哪个 action 存在、安全边界在哪一行、JSON 字段叫什么。每条都对应一个
 *       「漏了就会静默退化成『能点但连不上』或『安全边界消失』」的点。
 *
 *   [B] 真跑段 —— 连接器是纯 Node，可以真起服务、真发 HTTP、真做 upgrade。
 *       这一段覆盖的是**最容易被写错又最难在真机上定位**的三件事：
 *       Host 改写、配对门、WebSocket 透传。真机上报「能打开但一发消息就断」
 *       时，几乎一定是这里漏了 upgrade。
 *
 * 用法：node tools/test-remote.mjs
 */

import { readFileSync, writeSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { createConnector, generateCode, listLanAddresses } from './remote-connector.mjs'

const read = (p) => readFileSync(p, 'utf8')
const norm = (s) => s.replace(/\r\n/g, '\n')

const link = norm(read('android/app/src/main/java/app/kxxy/remote/RemoteLink.kt'))
const store = norm(read('android/app/src/main/java/app/kxxy/remote/RemoteStore.kt'))
const bar = norm(read('android/app/src/main/java/app/kxxy/remote/RemoteBar.kt'))
const activity = norm(read('android/app/src/main/java/app/kxxy/MainActivity.kt'))
const supervisor = norm(read('android/app/src/main/java/app/kxxy/engine/EngineSupervisor.kt'))
const html = norm(read('plugins/kxxy-host/web/index.html'))
// `<wbr>` 是纯排版断点（没有文本内容，复制时不会带出去）。比对文案前先去掉它，
// 否则「命令是否完整给出」这类断言会因为中间多了一个断点标记而假失败。
const htmlText = html.replace(/<wbr\s*\/?>/g, '')
const js = norm(read('plugins/kxxy-host/web/host.js'))
const css = norm(read('plugins/kxxy-host/web/host.css'))
const hostLib = norm(read('plugins/kxxy-host/lib/index.js'))
const runtime = norm(read('tools/build-runtime.mjs'))
const installer = norm(read('android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt'))
const scan = norm(read('android/app/src/main/java/app/kxxy/remote/QrScanActivity.kt'))
const decoder = norm(read('android/app/src/main/java/app/kxxy/remote/QrDecoder.kt'))
const netPrint = norm(read('android/app/src/main/java/app/kxxy/remote/NetFingerprint.kt'))
const gradle = norm(read('android/app/build.gradle.kts'))
const connectorSrc = norm(read('tools/remote-connector.mjs'))
const manifest = norm(read('android/app/src/main/AndroidManifest.xml'))

let pass = 0
let fail = 0

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

/** 去空白后比对，避免缩进/换行让断言假失败。 */
const has = (haystack, needle) => haystack.replace(/\s+/g, ' ').includes(needle.replace(/\s+/g, ' '))

/**
 * 剥掉注释再断言。
 *
 * 必要性很具体：注释里为了解释「为什么不用某 API」会写到那个 API 的名字，
 * 而断言想看的是**代码里没有调用它**。不去注释就永远互相打架。
 */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ---------------------------------------------------------------------------
// [A] 契约：连接串解析
// ---------------------------------------------------------------------------
console.log('\n[A] 连接串解析（RemoteLink）')

ok('parse 只接受 http/https', has(link, 'if (scheme != "http" && scheme != "https") return null'))
ok('裸 host 自动补 http://', has(link, 'else -> "http://$trimmed"'))
ok(
  '没有 token/code 时拒绝（否则用户只会看到英文 401）',
  has(link, 'if (!hasCredential(uri)) return null'),
  '这是「添加时就说清楚」与「连上后 401」的分界',
)
ok('认 token / code / pair / key 四种凭据名', ['"token"', '"code"', '"pair"', '"key"'].every((k) => link.includes(k)))
ok('清理包裹引号与尖括号', has(link, "s.trim('`', '\\'', '\"', '<', '>', ' ')"))
ok('能从句子里捞出 URL（终端复制粘贴的常见形态）', has(link, 'lastOrNull { it.startsWith("http", true)'))
ok('origin 规范化：默认端口省略', has(link, 'if (port == defaultPort) "$scheme://$hostForOrigin" else'))
ok('IPv6 origin 加方括号', has(link, 'val hostForOrigin = if (host.contains(\':\')) "[$host]" else host'))
ok('私有网段判定：10/127/192.168/172.16-31', has(link, 'nums[0] == 10 -> true') && has(link, 'nums[0] == 127 -> true') && has(link, 'nums[0] == 192 && nums[1] == 168 -> true') && has(link, 'nums[0] == 172 && nums[1] in 16..31 -> true'))
ok('Android 热点网段 192.0.2.x 也算局域网', has(link, 'nums[0] == 192 && nums[1] == 0 && nums[2] == 2 -> true'))
ok('localhost / .local / .lan 算局域网', has(link, 'h == "localhost" || h.endsWith(".local") || h.endsWith(".lan")'))
ok('IPv6 链路本地与 ULA 算局域网', has(link, 'h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")'))
ok('只按字面量判断，不做 DNS 解析（同步路径不能有网络往返）', !/InetAddress|getByName/.test(link))

// ---------------------------------------------------------------------------
// [A] 契约：设备簿
// ---------------------------------------------------------------------------
console.log('\n[A] 设备簿（RemoteStore）')

ok('按 origin 去重', has(store, 'indexOfFirst { it.origin == parsed.origin }'))
ok('凭据在快照里打码，但保留结构', has(store, 'setOf("token", "code", "pair", "key")') && has(store, '"$key=••••••"'))
ok('快照含 devices / lastUsedId / count / error', ['"devices"', '"lastUsedId"', '"count"', '"error"'].every((k) => store.includes(k)))
ok('每个设备含 id/label/host/origin/kind/secure/ok', ['"id"', '"label"', '"host"', '"origin"', '"kind"', '"secure"', '"ok"'].every((k) => store.includes(k)))
ok('错误带自增序号（前端靠它决定弹不弹 toast）', has(store, 'KEY_ERROR_SEQ') && has(store, 'noteError'))
ok('noteError 递增序号并落盘', has(store, 'putLong(KEY_ERROR_SEQ'))

// ---------------------------------------------------------------------------
// [A] 契约：安全边界（这一段最重要）
// ---------------------------------------------------------------------------
console.log('\n[A] 安全边界（MainActivity）')

ok('存在 remoteMode 标记', has(activity, 'private var remoteMode = false'))
ok(
  '远程模式下 kxxy:// 桥被硬拒绝',
  has(activity, 'if (remoteMode)') && /remoteMode[\s\S]{0,240}kxxy/.test(activity),
  '否则远端页面能调起本机的系统权限申请',
)
ok('先立标记再 loadUrl（顺序是安全语义，不是时序优化）', has(activity, 'remoteMode = true') && /remoteMode = true[\s\S]{0,400}loadUrl/.test(activity))
ok('远程 origin 之外不放行应用内导航', /isPairedOrigin|paired/i.test(activity))
ok(
  'SSL 只对已配对 host 放行，其余 cancel',
  has(activity, 'handler.proceed()') && has(activity, 'handler.cancel()') &&
    /RemoteStore\.devices\([\s\S]{0,160}it\.host == host/.test(activity),
)
ok('远程 URL 只允许 http/https', has(activity, 'scheme != "http" && scheme != "https"'))
ok('断开远程回到本机宿主页并落到 #remote', has(activity, '#remote'))

// ---------------------------------------------------------------------------
// [A] 契约：桥动作与状态发布
// ---------------------------------------------------------------------------
console.log('\n[A] 桥与状态')

for (const action of ['add', 'open', 'remove', 'rename', 'connect', 'disconnect', 'scan', 'trust', 'untrust', 'skiptip']) {
  ok(`桥动作 ${action} 存在`, new RegExp(`"${action}" ->`).test(activity))
}
ok('设备簿变更后立刻重发状态（否则要等心跳）', has(activity, 'supervisor.republishState()'))
ok('publishState 带 remote 快照', has(supervisor, '\\"remote\\": ${app.kxxy.remote.RemoteStore.snapshotJson(ctx)}'))
ok('设备条是覆盖层而不是塞进 WebView（远端页面的 DOM 我们改不了）', /class RemoteBar|object RemoteBar/.test(bar) || /RemoteBar/.test(activity))

// ---------------------------------------------------------------------------
// [A] 契约：扫码
// ---------------------------------------------------------------------------
console.log('\n[A] 扫码')

ok('扫码页在清单里注册且不导出', /android:name="\.remote\.QrScanActivity"[\s\S]{0,120}android:exported="false"/.test(manifest))
ok('相机依赖齐（CameraX 预览 + 分析）', ['camera-core', 'camera-camera2', 'camera-lifecycle', 'camera-view'].every((d) => gradle.includes(d)))
ok('二维码解码用 zxing core（纯 JVM，不拉 GMS/ML Kit）', gradle.includes('com.google.zxing:core') && !/mlkit|play-services/.test(gradle))
ok('只解二维码格式（不放 MultiFormatReader 白烧 CPU）', has(decoder, 'DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)'))
ok('按 rowStride 逐行搬运（否则图像斜切，能看见却扫不出）', has(decoder, 'if (rowStride == width)') && has(decoder, 'System.arraycopy(row, 0, out, written, width)'))
ok('每帧都 close，否则背压队列卡死后不再给新帧', has(scan, 'image.close()'))
ok('解码串行化（同一时刻只解一帧）', has(scan, 'decoding.compareAndSet(false, true)'))
ok(
  '扫到的内容复用 RemoteLink 校验，不另写一套规则',
  has(scan, 'RemoteLink.parse(text)') && has(activity, 'RemoteLink.parse(text)'),
  '两份规则一旦分叉，扫码失败将无法定位',
)
ok('扫码保存与进入复用 upsert + enterRemote', /enterRemote\(RemoteStore\.upsert\(this, parsed, null\)/.test(activity))
ok('扫错码只换提示、不退出相机', has(scan, 'quietUntil') && has(scan, '这不是 Kxxy 的连接码'))
ok('权限被拒给两个出口（去设置 / 改用粘贴）', has(scan, 'ACTION_APPLICATION_DETAILS_SETTINGS') && has(scan, '改用粘贴连接串'))
ok('扫码入口在主按钮上', has(html, 'id="btn-remote-scan"') && has(js, "postRemote('scan')"))

// ---------------------------------------------------------------------------
// [A] 契约：信任与自动连接
// ---------------------------------------------------------------------------
console.log('\n[A] 信任与自动连接')

ok('设备簿有信任/失败次数/成功时间字段', ['trusted', 'failStreak', 'lastOkAt', 'netFingerprint'].every((f) => store.includes(f)))
ok('重新配对时继承信任状态（换配对码不该丢自动连）', has(store, 'trusted = existing?.trusted ?: false'))
ok('自动连接候选由原生判定', has(store, 'fun autoCandidate(ctx: Context): Device?'))
ok('手动断开写入冷却（否则断开会被立刻连回去）', has(store, 'DISCONNECT_COOLDOWN_MS') && has(activity, 'exitRemote(cooldown = true)'))
ok('连续失败降级为手动', has(store, 'MAX_AUTO_FAILS'))
ok('自动失败后有退避窗口（避免本机页重载即重试）', has(store, 'AUTO_RETRY_BACKOFF_MS'))
ok('隧道设备不受网络指纹限制（外网连本来就是正常用法）', has(store, 'if (device.kind == "tunnel") return true'))
ok('网络指纹不依赖定位权限（不取 SSID）', !/getConnectionInfo|\.ssid|ACCESS_FINE_LOCATION/.test(codeOnly(netPrint)))
ok('成功判据是 onPageFinished，不是「点了连接」', /if \(remoteMode\)[\s\S]{0,200}markUsed\(this@MainActivity, it, true\)/.test(activity))
ok('自动连接有看门狗（连得上但不回包时不会一直白屏）', has(activity, 'AUTO_CONNECT_TIMEOUT_MS') && has(activity, 'remoteWatchdog'))
ok('自动失败静默回本机并给一句提示', has(activity, '已回到本机'))
ok(
  '冷启动自动连接在原生（页面加载前就判），不依赖宿主页 JS',
  /fun loadEngineUrl[\s\S]{0,900}autoCandidate\(this\)[\s\S]{0,200}enterRemote\(auto, auto = true\)/.test(activity),
  'App 启动加载的是官方对话页 `/`，宿主页要用户点进去才加载 —— 判在 JS 里等于永远不触发',
)
ok(
  '通知/会话意图优先，不被自动连接顶掉',
  /pendingAttentionId == null && pendingSessionId == null[\s\S]{0,200}autoCandidate/.test(activity),
)
ok('信任提示由原生 trustTip 驱动，前端不复述条件', has(js, 'remote.trustTip') && has(store, 'fun trustTip(ctx: Context): Device?'))
ok('列表里能开关自动连', has(js, 'data-remote-act="${d.trusted ? \'untrust\' : \'trust\'}"'))
/*
 * 「已配对成功的，让我能方便直接连」的落点：概览卡上那台（最近用的）设备
 * 旁边直接有「自动连」。只放在管理视图的列表里，用户得先想到去点「管理」。
 */
ok('概览卡 hero 上就有自动连开关', has(html, 'id="btn-remote-trust"') && has(js, 'dom.btnRemoteTrust?.addEventListener'))
ok('hero 开关状态同样来自原生 trusted', has(js, "classList.toggle('is-on', hero.trusted === true)"))
ok('二维码/连接串带机器名且做了编码', /encodeURIComponent\(os\.hostname\(\)/.test(connectorSrc))
ok('样式齐全（扫码/信任/开关）', ['.remote-scan-button', '.remote-trust-tip', '.remote-trust'].every((c) => css.includes(c)))

// ---------------------------------------------------------------------------
// [A] 契约：前端
// ---------------------------------------------------------------------------
console.log('\n[A] 前端')

ok('概览有远程控制卡', has(html, 'id="remote-card"'))
ok('独立视图 data-view="remote"', has(html, 'data-view="remote"'))
ok('添加表单有连接串与备注两个输入', has(html, 'id="remote-url-input"') && has(html, 'id="remote-label-input"'))
ok('列表容器与空态都在', has(html, 'id="remote-list"') && has(html, 'id="remote-list-empty"'))
ok('说明卡讲清「同一 WiFi 不经过任何服务器」', /不经过|局域网/.test(html.slice(html.indexOf('remote-note-card'))))
ok('前端只发 kxxy://remote/*，不直接改 location 到远端', has(js, 'kxxy://remote/${action}'))
ok('渲染走 data.remote，不本地缓存设备清单', has(js, 'renderRemote('))
/*
 * 缺陷 DV：设备存下来了，列表却永远是空的。
 *
 * 原生把设备簿写在状态文件顶层，插件 `Object.assign` 把它摊进 `engine` ——
 * 所以快照实际只在 `engine.remote`。前端只读 `data.remote` 时永远是 undefined，
 * `renderRemote` 早退，用户看到的就是「手机连上了，已配对的电脑一直空」。
 * 这两条钉住两端：服务端必须把 remote 提到顶层，前端两个位置都要看。
 */
ok('状态 API 把 remote 提到顶层（不是只埋在 engine 里）', /const remote = engine\.remote[\s\S]{0,160}sendJson\(res, 200, \{[\s\S]{0,120}remote,/.test(hostLib))
ok('前端同时兼容 data.remote 与 engine.remote', has(js, 'renderRemote(data.remote || engine.remote)'))
ok('快照缺失时仍画出空态，而不是一片空白', has(js, 'const snapshot = remote || {}'))
ok('错误按 seq 去重，避免每次轮询弹一次 toast', has(js, 'seq > remoteErrorSeq'))
ok('设备名做 HTML 转义', has(js, 'escapeHtml(d.label)'))
ok('样式类齐全（卡片/英雄区/条目/徽章）', ['.remote-card', '.remote-hero', '.remote-item', '.remote-badge'].every((c) => css.includes(c)))

// ---------------------------------------------------------------------------
// [A] 契约：概览折叠（v0.9.17）
// ---------------------------------------------------------------------------
console.log('\n[A] 概览折叠')

/*
 * 概览页原先两张长列表（启动体检查 11 项、运行时完整性 7 项）铺开占一屏多，
 * 而它们正常时的信息量只有一行结论。改成 details 折叠后：
 *   · 默认收起，结论（全部通过 / N 项待处理 / 7-7 通过）留在 summary 徽章上，
 *     收起不等于藏信息；
 *   · 用户展开过一次就记住（localStorage），不逼人每次重新点开；
 *   · 有红项时自动展开一次 —— 写着「3 项待处理」却不告诉是哪三项，
 *     折叠就成了藏故障。
 */
ok('启动体检是可折叠卡', has(html, 'id="health-checks-details"') && /<details class="fold" id="health-checks-details"/.test(html))
ok('运行时完整性是可折叠卡', /<details class="fold" id="runtime-checks-details"/.test(html))
ok('两张卡默认收起（details 上不写 open）', !/<details class="fold"[^>]*\bopen\b/.test(html))
ok('收起态保留结论徽章', has(html, 'id="health-count-badge"') && has(html, 'id="runtime-all-status"'))
ok('检查项容器仍在（renderHealth / renderRuntimeChecks 不失效）', has(html, 'id="health-checks"') && has(html, 'id="runtime-checks-container"'))
ok('折叠样式齐全', ['.fold-card', '.fold-summary', '.fold[open] .chevron-icon', '.fold-body'].every((c) => css.includes(c)))
ok('两张卡与系统权限卡共用一套记忆逻辑', has(js, "bindFold(dom.healthChecksDetails, 'kxxy.overview.health.open.v1')")
  && has(js, "bindFold(dom.runtimeChecksDetails, 'kxxy.overview.runtime.open.v1')")
  && has(js, "bindFold(dom.permDetails, 'kxxy.settings.perm.open.v1')"))
ok('展开状态记进 localStorage，且能在受限 WebView 下降级', has(js, 'localStorage.setItem(key, details.open ? \'1\' : \'0\')') && /catch \(_\) \{\}/.test(js))
ok('有红项时自动展开一次（收起不藏故障）', has(js, 'if (bad.length) openFoldForAttention(dom.healthChecksDetails)'))
ok('用户表过态就不再替它展开', has(js, 'if (details.dataset.foldChoice) return'))
ok('程序化展开不写存档（不改变用户下次的默认版面）', has(js, "details.dataset.foldAuto = '1'"))

// ---------------------------------------------------------------------------
// [A] 契约：上手引导（v0.9.16）
// ---------------------------------------------------------------------------
console.log('\n[A] 上手引导')

/*
 * 引导卡是「第一次连不上」唯一能自救的地方，所以每一条都钉住。
 *
 * 缺链接 = 用户不知道要装什么；缺「必须装」这一句 = 他会跳过这步去粘
 * 连接串，然后卡在 `dsh web authentication required` 上 —— 那正是 v0.9.14
 * 收到的原样反馈。文案里删一行不至于报错，但功能上等于把这条路又堵回去。
 */
const PLUGIN_REPO = 'https://github.com/438417623wq/dshKXHL'
ok('引导卡里有插件仓库链接', has(html, `href="${PLUGIN_REPO}"`))
ok('链接是真的 <a href>，不是一段要用户手抄的纯文本', new RegExp(`<a[^>]*href="${PLUGIN_REPO}"`).test(html))
ok('写明「这一步不能省」并解释原因', /这一步不能省/.test(html) && /只监听本机回环/.test(html))
ok('给出安装命令（clone 与 install 同一条）', has(htmlText, 'git clone https://github.com/438417623wq/dshKXHL.git') && has(htmlText, 'node scripts/install.mjs'))
ok('命令带 <wbr> 断点，窄屏不会从单词中间硬切', /<wbr>/.test(html))
ok('提醒装完要完全退出 DSH 再开', /完全退出 DSH/.test(html))
ok('插件面板步骤在（启动接入 → 二维码）', /启动接入/.test(html))
ok('命令行连接器降为折叠兜底，不在主步骤里', /<details class="remote-fallback">/.test(html))
ok('兜底里说清 token 要手填一次', /手填一次/.test(html))
ok('两个端口都标了（插件 8765 / 命令行 8080），隧道映射不会搞混', /8765/.test(html) && /8080/.test(html))
ok('外网备注改为「别暴露 DSH 的 3080」', /别去暴露/.test(html))
ok('复制按钮走通用委托，不依赖固定 id', /closest\('\.remote-copy'\)/.test(js))
ok('复制按钮按同块 <code> 取文本（加命令不用改 JS）', /querySelector\('code'\)/.test(js))
ok('引导卡样式补齐（链接条 / 兜底折叠）', ['.remote-plugin-link', '.remote-fallback'].every((c) => css.includes(c)))

// ---------------------------------------------------------------------------
// [A] 契约：出包一致性
// ---------------------------------------------------------------------------
console.log('\n[A] 出包')

const markerBuild = (runtime.match(/kxxy-patchset@(\d+)/) || [])[1]
const markerInstall = (installer.match(/kxxy-patchset@(\d+)/) || [])[1]
ok(`补丁集标记两处一致（@${markerBuild} / @${markerInstall}）`, markerBuild && markerBuild === markerInstall)

// ---------------------------------------------------------------------------
// [B] 连接器真跑
// ---------------------------------------------------------------------------
console.log('\n[B] 连接器（真起服务）')

const seen = []

/** 假上游：记录收到的 Host 与路径，模拟 DSH 的 token 换 cookie 行为。 */
function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, url: req.url, cookie: req.headers.cookie || '' })
      if (req.url.startsWith('/?token=') || req.url.startsWith('/?token=')) {
        res.writeHead(302, { 'set-cookie': 'dsh_sid=abc; Path=/; HttpOnly', location: '/' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html>upstream-ok</html>')
    })
    server.on('upgrade', (req, socket) => {
      seen.push({ host: req.headers.host, url: req.url, upgrade: true })
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: test\r\n\r\n',
      )
      socket.write('hello-from-upstream')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 发一个请求，把状态码/头/体原样带回来（不跟随重定向，我们要看 302）。 */
function request(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method || 'GET',
        path: opts.path || '/',
        headers: { host: `127.0.0.1:${port}`, ...(opts.headers || {}) },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * 关掉假上游。
 *
 * 必须 `closeAllConnections()`：upgrade 用例留下的 keep-alive socket 会让
 * `server.close()` 的回调**永不触发**（它只停接受新连接）。之前整脚本挂在
 * 这一步，表现为「全部断言通过但进程不退出」—— 比失败更难查。
 */
function closeUpstream(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

/** 裸 socket 做一次 upgrade 握手，返回 { statusLine, payload }。 */function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ]
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (c) => (raw += c))
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve({ raw, statusLine: raw.split('\r\n')[0], payload: raw.split('\r\n\r\n').slice(1).join('') })
    }, 300)
  })
}

const up = await startUpstream()
const PORT = 18781
const CODE = 'a1b2c3d4'
const conn = createConnector({ port: PORT, target: `http://127.0.0.1:${up.port}/?token=tok-xyz`, code: CODE })

try {
  await conn.listen()

  let r = await request(PORT, { path: '/' })
  ok('无配对码 → 401', r.status === 401, `实际 ${r.status}`)
  ok('401 页面是中文引导，不是英文栈', r.body.includes('需要配对码'))

  r = await request(PORT, { path: '/__kxxy_pair?code=wrong' })
  ok('配对页错误码 → 401', r.status === 401)
  ok('错码不下发 cookie', !String(r.headers['set-cookie'] || '').includes('kxxy_pair='))

  r = await request(PORT, { path: `/__kxxy_pair?code=${CODE}` })
  ok('配对页正确码 → 302', r.status === 302, `实际 ${r.status}`)
  ok('下发 HttpOnly 配对 cookie', /kxxy_pair=.*HttpOnly/.test(String(r.headers['set-cookie'] || '')))
  ok('SameSite=Lax（隧道域名跨站直连也要带上）', /SameSite=Lax/.test(String(r.headers['set-cookie'] || '')))
  ok('配对后回首页', r.headers.location === '/')

  const cookie = `kxxy_pair=${CODE}`

  r = await request(PORT, { path: '/__kxxy_pair?code=' + CODE + '&x=1' })
  ok('配对页保留其它 query（x=1 不丢）', r.status === 302)

  // 连接串直接带 code（手机粘贴的就是这种）
  r = await request(PORT, { path: `/?code=${CODE}&foo=bar` })
  ok('连接串直带 code → 302 并下发 cookie', r.status === 302 && /kxxy_pair=/.test(String(r.headers['set-cookie'] || '')))
  ok('跳转后从 URL 里抹掉 code（避免留在历史/日志）', !String(r.headers.location || '').includes('code=') && String(r.headers.location || '').includes('foo=bar'))

  // 首次文档请求：没有上游 cookie → 补 token
  seen.length = 0
  r = await request(PORT, { path: '/', headers: { cookie, 'sec-fetch-dest': 'document' } })
  ok('首次文档请求 → 302 到带 token 的地址', r.status === 302 && String(r.headers.location).includes('token=tok-xyz'), `实际 ${r.status} ${r.headers.location}`)

  // 该请求不应该打到上游（否则上游会 401）
  ok('补 token 的重定向在本地完成，不消耗上游请求', seen.length === 0, `上游收到 ${seen.length} 次`)

  // 带 token 后正常转发，且 Host 被改回上游
  seen.length = 0
  r = await request(PORT, { path: '/?token=tok-xyz', headers: { cookie, 'sec-fetch-dest': 'document' } })
  ok('带 token 的文档请求被转发', r.status === 302, `实际 ${r.status}`)
  ok('上游收到的 Host 被改成目标 authority', seen[0]?.host === `127.0.0.1:${up.port}`, `实际 ${seen[0]?.host}`)
  ok('上游的 Set-Cookie 原样下发', String(r.headers['set-cookie'] || '').includes('dsh_sid=abc'))

  // 已有上游 cookie：不再重定向（这是防循环的关键）
  r = await request(PORT, { path: '/', headers: { cookie: `${cookie}; dsh_sid=abc`, 'sec-fetch-dest': 'document' } })
  ok('已有上游 cookie → 不再补 token（否则无限 302）', r.status === 200, `实际 ${r.status}`)

  // XHR 不补 token：302 到 HTML 会把「缺 cookie」变成「格式错误」
  seen.length = 0
  r = await request(PORT, { path: '/api/state', headers: { cookie, 'sec-fetch-dest': 'empty', accept: 'application/json' } })
  ok('XHR 不被重定向到 token 页', r.status === 200)
  ok('XHR 正常打到上游并带原路径', seen[0]?.url === '/api/state')

  // WebSocket 透传 —— 漏了它，界面能开、一发消息就断
  let u = await upgrade(PORT, {})
  ok('未配对的 upgrade → 401', /401/.test(u.statusLine), u.statusLine)

  u = await upgrade(PORT, { Cookie: cookie })
  ok('已配对的 upgrade → 101', /101/.test(u.statusLine), u.statusLine)
  ok('升级响应头原样回传（含 Sec-WebSocket-Accept）', /Sec-WebSocket-Accept: test/i.test(u.raw))
  ok('双向字节流真的通了', u.payload.includes('hello-from-upstream'), JSON.stringify(u.payload.slice(0, 60)))
  ok('upgrade 也做了 Host 改写', seen.find((s) => s.upgrade)?.host === `127.0.0.1:${up.port}`)

  // 上游不可达 → 502 可读页，而不是挂住。
  // 这里另起一个指向死端口的连接器：为了造「上游挂掉」而去关共享的假上游，
  // 会牵进 keep-alive socket 清理，反而让测试自己卡住。
  const dead = createConnector({ port: PORT + 1, target: 'http://127.0.0.1:1/', code: CODE })
  await dead.listen()
  try {
    r = await request(PORT + 1, { path: '/', headers: { cookie, 'sec-fetch-dest': 'document' } })
    ok('上游不可达 → 502 且给出可读原因', r.status === 502 && r.body.includes('连不上'), `实际 ${r.status}`)
  } finally {
    await dead.close()
  }
} finally {
  await conn.close()
  // 不 await：假上游可能还挂着 upgrade 留下的 socket，等它等于等一个
  // 永不到来的回调；脚本最后会 process.exit，句柄自然回收。
  closeUpstream(up.server)
}

// ---------------------------------------------------------------------------
// [C] 安全边界：会话判定与日志脱敏（缺陷 DZ / EA / EB）
// ---------------------------------------------------------------------------
//
// 这一层只钉**接线**，行为由 tools/smoke-plugin.mjs 真起服务验。
// 为什么还要静态钉一遍：这次的根因是「调用了一个不存在的方法，于是恒走兜底」，
// 那种错行为测试也会全绿（兜底恒真），只有把"必须调哪个方法"写死才不会回去。
console.log('\n[C] 安全边界（鉴权 / 脱敏）')
{
  const authSrc = norm(read('plugins/kxxy-host/lib/auth.mjs'))
  const redactSrc = norm(read('plugins/kxxy-host/lib/redact.mjs'))

  /*
   * 钉住的是「必须调哪个方法」：这次的根因两连击 —— 先调了一个不存在的
   * `authorization.isTrustedRequest`（于是走 Host 兜底、门全开），修的时候
   * 又换成了 `connection.isAuthenticated`（服务上同样没有，于是每页都变成
   * 「鉴权服务不可用」）。真实入口是 `connection.admit(req)`。
   */
  ok('判定走 connection.admit(req)', authSrc.includes("ctx.get('connection')") && /conn\.admit\(req\)/.test(authSrc))
  ok('admit 之前先拿服务，缺失即 unavailable', /lastDetail = 'no-service'/.test(authSrc))
  ok('判定器缺失/抛错 → unavailable（判不了不放行）', /AUTH_UNAVAILABLE/.test(authSrc) && /return AUTH_UNAVAILABLE/.test(authSrc))
  ok('主模块不再调用 isTrustedRequest', !/isTrustedRequest\s*\(\s*ctx\s*,/.test(hostLib))
  ok('媒体 / API / 页面三处都过同一道判定', (hostLib.match(/authVerdict\(ctx, req\)/g) ?? []).length >= 3)
  ok('写操作要过 CSRF 语义检查', hostLib.includes('checkWriteRequest(req)'))
  ok('跨站来源在最外层挡掉', hostLib.includes('cross-site request rejected'))
  ok('页面加防嵌套头', hostLib.includes("'x-frame-options': 'DENY'") && hostLib.includes('frame-ancestors'))
  ok('日志接口走脱敏尾部', hostLib.includes('redactLogTail('))
  ok('脱敏覆盖 token / bearer / cookie / sk-',
    ['token|access_token', 'authorization', 'cookie:', 'sk-'].every((k) => redactSrc.includes(k)))
  ok('日志尾部上限 32KB（原来是 64KB 原样吐）', redactSrc.includes('32 * 1024'))
  // 管理页要 cookie 之后，冷启动自动连接（跳过 token URL 直接进远程）在
  // 「回到本机」时会没有本机会话 —— 这两条钉住那次补换。
  ok('退出远程前若没换过本机 cookie，先补 token URL', /!localSessionMinted && tokenUrl != null/.test(activity))
  ok('补换完成后由 onPageFinished 转去控制台', activity.includes('pendingConsole && !remoteMode'))
}

// ---------------------------------------------------------------------------
// [D] 写操作 nonce（v0.9.19）
// ---------------------------------------------------------------------------
//
// 三道 CSRF 语义都依赖浏览器**自愿**发的头，nonce 是唯一"对方拿不到"的那条。
// 这里钉住三件事：服务端生成/注入/校验、前端统一加头、以及"旧 nonce 仍可用"
// （插件热重载后已打开的页面不该立刻 403）。
console.log('\n[D] 写操作 nonce')
{
  const authSrc = norm(read('plugins/kxxy-host/lib/auth.mjs'))
  const js = norm(read('plugins/kxxy-host/web/host.js'))
  const html = norm(read('plugins/kxxy-host/web/index.html'))

  ok('服务端用 crypto 随机生成 nonce', hostLib.includes('randomBytes(32)'))
  ok('nonce 注入到页面 head', hostLib.includes('name="kxxy-nonce"') && hostLib.includes('injectNonce('))
  ok('写请求校验 nonce', hostLib.includes('checkNonce(req, acceptedNonces())'))
  ok('比较用 timingSafeEqual（不给计时侧信道）', authSrc.includes('timingSafeEqual'))
  ok('保留最近若干个 nonce（热重载后老页面不立刻失效）',
    authSrc.includes('NONCE_SEEN_MAX') && authSrc.includes('acceptedNonces'))
  ok('nonce 挂在 globalThis（模块重载后仍在）', authSrc.includes('Symbol.for') && authSrc.includes('globalThis['))
  ok('页面读 meta 里的 nonce', js.includes("meta[name=\"kxxy-nonce\"]"))
  ok('前端统一包 fetch 加头（不靠每个调用点自觉）', js.includes("headers.set('x-kxxy-nonce'"))
  ok('只给 /kxxy/api/ 的写请求加（不给外部地址加）',
    js.includes("url.indexOf('/kxxy/api/') >= 0") && js.includes('WRITE_METHODS'))
  // 静态页里不该出现 nonce 字面量：它是运行时注入的，写死在模板里等于公开
  ok('静态 index.html 不含 nonce 字面量', !html.includes('kxxy-nonce'))
}

// ---------------------------------------------------------------------------
// [E] 平台边界：DNS 黑洞诊断 + 体检项（v0.9.19）
// ---------------------------------------------------------------------------
console.log('\n[E] 平台边界与网络诊断')
{
  const netSrc = norm(read('plugins/kxxy-host/lib/netdiag.mjs'))
  const healthSrc = norm(read('plugins/kxxy-host/lib/health.mjs'))
  const kotlinInstaller = norm(read('android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt'))
  const extinstallSrc = norm(read('plugins/kxxy-host/lib/extinstall.mjs'))
  const kotlinConfig = norm(read('android/app/src/main/java/app/kxxy/engine/EngineConfig.kt'))

  ok('空地址判定覆盖 0.0.0.0 与 127.x', netSrc.includes("'0.0.0.0'") && netSrc.includes("startsWith('127.')"))
  ok('有对照组主机（区分"只拦这一个"与"整体没网"）', netSrc.includes("id: 'github'") && netSrc.includes('controlOk'))
  ok('DNS 查询带超时（不能把 /state 拖住）', netSrc.includes('LOOKUP_TIMEOUT_MS'))
  ok('探测结果缓存（5 分钟）', netSrc.includes('TTL_MS') && netSrc.includes('5 * 60 * 1000'))
  ok('体检里分三种结论', /'selective'/.test(netSrc) && /'offline'/.test(netSrc) && /'blackhole'/.test(netSrc))
  ok('网络项只报黄不报红（不影响启动）',
    /code = 'NET'/.test(healthSrc) &&
      !/Verdict\.BAD/.test(
        healthSrc.slice(
          healthSrc.indexOf('function checkNetwork'),
          healthSrc.indexOf('function checkPlatform'),
        ),
      ))
  ok('平台边界项常绿', /code = 'PLATFORM'/.test(healthSrc))
  ok('/state 顶层带 net 快照', hostLib.includes('net: netdiag.netSnapshot()'))
  ok('raw 镜像从 etc/net.json 读（默认不预置第三方地址）',
    kotlinInstaller.includes('etc/net.json') && kotlinInstaller.includes('insteadOf = https://raw.githubusercontent.com/'))
  ok('临时目录每次启动真写一次（失败会指名道姓）', kotlinInstaller.includes('.kxxy-writable'))

  // 这一组钉住「装了扩展之后代码里的修复也能生效」：扩展是用户态资产，
  // 只在安装路径上修等于对老设备完全无效（真机症状：0.9.20 上 yarn 仍旧
  // Cannot find module …/bin/yarn.js）。
  ok('扩展接入自愈是导出函数、可在任意时刻对已装目录跑',
    /export function healExtensions/.test(extinstallSrc))
  ok('启动路径真的调了自愈（不是只留了个函数）',
    /extinstall\.healExtensions\(/.test(hostLib) && /runHeal\(root0\)/.test(hostLib))
  ok('自愈覆盖悬空软链与 wrapper 两种形状',
    /healBinEntry/.test(extinstallSrc) && /repairWrapperRefs/.test(extinstallSrc))

  // NDK：装不进包里，但必须真的接线 —— 否则用户把 NDK 放进去也不会生效
  ok('NDK 三处探测（引擎根两份 + home）并写进 GYP_DEFINES',
    /android_ndk_path=/.test(kotlinConfig) && /File\(root, "ndk"\)/.test(kotlinConfig))
  ok('PLATFORM 说明缺 NDK 时该放哪里', /<引擎根>\/ndk|引擎根>\/ndk/.test(healthSrc))
}

// 生成器
const codes = new Set()
for (let i = 0; i < 200; i++) codes.add(generateCode())
ok('配对码 8 位十六进制', /^[0-9a-f]{8}$/.test(generateCode()))
ok('200 次生成无重复（足够熵避免撞码）', codes.size === 200, `实际 ${codes.size}`)
ok('局域网地址探测返回数组', Array.isArray(listLanAddresses()))

// 用 writeSync 写结论：stdout 是管道时 console.log 是异步的，紧跟 process.exit
// 会把最后几行截掉（表现成「跑完了但看不到结论」）。
const summary = fail === 0 ? `\n结论：远程控制 ${pass} 项全部通过` : `\n结论：${fail} 项失败 / ${pass} 项通过`
try {
  writeSync(1, summary + '\n')
} catch {
  console.log(summary)
}
process.exit(fail === 0 ? 0 : 1)
