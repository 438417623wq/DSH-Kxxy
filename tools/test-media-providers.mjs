/**
 * 音视频 provider 片段的行为测试。
 *
 * 被测对象是 `tools/prebuilt/documentpreview-media/providers.js` —— 它不是模块，
 * 而是一段会被构建期拼进上游 `client.js` 的**片段**。这里用「读取源码 + 在受控
 * 沙箱里求值 + 只导出要测的函数」的方式把它变成可测单元，好处是测的就是构建机
 * 真正注入的那份字节，不会出现「测试副本与生产副本漂移」。
 *
 * 覆盖重点有两个，都是「写错了不会报错、只会让用户在手机上看到空白或错文案」：
 *   1. src 构造：`/kxxy/media?path=` 的拼法、绝对路径的转义，以及 base 为
 *      `dsh-app://`（桌面）时退回 `api/file` —— 拼错就是 404，界面只剩播放器空壳。
 *   2. 失败归因：`MediaError.code === 4`（SRC_NOT_SUPPORTED）必须与「文件损坏」
 *      分开。混在一起用户会反复重试一个永远播不了的 mkv。
 *
 * react 用自实现的极简 hooks：需要真实的 state 往返才能驱动
 * `loadedmetadata` → `request.loaded()` 这条链，stub 成空函数就测不到。
 *
 * ⚠️ 只有**一个** hooks 运行时。片段在求值时就闭包捕获了传给它的 `react`，
 * 因此测试必须复用它来渲染，另建一份会得到两套互不相干的 state。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FRAGMENT = join(HERE, "prebuilt", "documentpreview-media", "providers.js");

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`  ok   ${label}`);
		return;
	}
	failed += 1;
	console.log(`  FAIL ${label}${detail === void 0 ? "" : `  —— ${detail}`}`);
}

function equal(label, actual, expected) {
	check(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}

//#region 极简 hooks 运行时

/**
 * 一个组件的 hooks 槽位 + 重渲染循环。
 *
 * `render(props)` 复位游标并执行组件体；`flush()` 把挂起的 state 写回槽位后
 * 再执行一次，等价于 React 的一轮「setState → 重渲染」。
 */
function createHarness() {
	let slots = [];
	let cursor = 0;
	const pendingWrites = [];
	const mountEffects = [];

	const react = {
		useState(initial) {
			const index = cursor++;
			if (index >= slots.length) {
				slots[index] = { kind: "state", value: typeof initial === "function" ? initial() : initial };
			}
			const slot = slots[index];
			const set = (next) => {
				const value = typeof next === "function" ? next(slot.value) : next;
				if (Object.is(value, slot.value)) return;
				pendingWrites.push([slot, value]);
			};
			return [slot.value, set];
		},
		useRef(initial) {
			const index = cursor++;
			if (index >= slots.length) slots[index] = { kind: "ref", value: { current: initial } };
			return slots[index].value;
		},
		useEffect(fn, deps) {
			const index = cursor++;
			const previous = slots[index];
			if (index >= slots.length) {
				slots[index] = { kind: "effect", deps };
				mountEffects.push(fn);
				return;
			}
			const changed =
				deps === void 0 ||
				previous.deps === void 0 ||
				deps.length !== previous.deps.length ||
				deps.some((d, i) => !Object.is(d, previous.deps[i]));
			if (changed) {
				previous.deps = deps;
				mountEffects.push(fn);
			}
		},
		useCallback(fn) {
			return fn;
		},
		useMemo(fn) {
			return fn();
		},
		createElement(type, props, ...children) {
			const flat = children.flat().filter((c) => c !== null && c !== void 0 && c !== false);
			const kids = flat.length === 0 ? void 0 : flat.length === 1 ? flat[0] : flat;
			return { type, props: { ...(props ?? {}), children: kids } };
		},
	};

	let component = null;
	let lastProps = null;

	/** 渲染一次；不跑 effect。返回元素树。 */
	function render(fn, props) {
		component = fn;
		lastProps = props;
		cursor = 0;
		return fn(props);
	}

	/** 跑本轮挂起的 effect（模拟 React 提交后执行）。 */
	function commit() {
		const list = mountEffects.splice(0, mountEffects.length);
		for (const fn of list) fn();
	}

	/** 首次挂载：复位槽位、渲染、跑 effect。 */
	function mount(fn, props) {
		slots = [];
		cursor = 0;
		pendingWrites.length = 0;
		mountEffects.length = 0;
		const tree = render(fn, props);
		commit();
		return tree;
	}

	/** 应用挂起的 state 写入并重渲染 + 跑 effect。 */
	function flush() {
		if (component === null) throw new Error("flush() 之前必须先 mount()");
		const writes = pendingWrites.splice(0, pendingWrites.length);
		for (const [slot, value] of writes) slot.value = value;
		const tree = render(component, lastProps);
		commit();
		return tree;
	}

	return { react, mount, flush, render, commit };
}

//#endregion

//#region 片段装载

/** 临时替换 `document.baseURI`；片段只用它做 `new URL` 的基准。 */
function withBase(base, fn) {
	const previous = globalThis.document;
	globalThis.document = { baseURI: base };
	try {
		return fn();
	} finally {
		if (previous === void 0) delete globalThis.document;
		else globalThis.document = previous;
	}
}

const harness = createHarness();
const source = readFileSync(FRAGMENT, "utf8");
const NAMES = ["kxxyMediaExtOf", "kxxyMediaApply", "kxxyMakeMediaBody", "kxxyMediaVideoBody", "kxxyMediaAudioBody"];
const api = new Function("react", `${source}\nreturn { ${NAMES.join(", ")} };`)(harness.react);

//#endregion

//#region 元素树工具

/** 深度优先找第一个指定 type 的节点。 */
function find(node, type) {
	if (node === null || node === void 0 || typeof node !== "object") return void 0;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = find(child, type);
			if (hit !== void 0) return hit;
		}
		return void 0;
	}
	if (node.type === type) return node;
	return find(node.props?.children, type);
}

/** 把元素树压成可搜文本（片段只用字符串子节点做文案）。 */
function textOf(node) {
	if (node === null || node === void 0 || node === false) return "";
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	if (typeof node === "object") return `${node.type} ${textOf(node.props?.children)}`;
	return "";
}

//#endregion

console.log("音视频 provider 片段测试");

//#region 静态形态

check("片段含 kxxyMediaApply 入口", source.includes("function kxxyMediaApply("));
check("片段不含 </script（内联进 bundle 会截断脚本）", !source.includes("</script"));
check("片段不引用 require（片段里没有模块系统）", !/\brequire\s*\(/.test(source));
check(
	"两个 provider id 都带包名前缀",
	source.includes('documentpreview/media-video"') && source.includes('documentpreview/media-audio"'),
);
check("恰好两个 provider 用 renderer 模式", source.split('loading: "renderer"').length - 1 === 2);
check("没有 provider 误用 bytes-complete（那会撞 32 MiB 上限）", !source.includes('loading: "bytes-complete"'));
check("两个 provider 都声明 binaryExtensions", source.split("binaryExtensions: KXXY_MEDIA_").length - 1 === 2);
check("槽位注册走 slots.inject（与上游一致）", source.split('ctx.slots.inject("sidebar.right.tab.document"').length - 1 === 2);
check("渲染的是 video 与 audio 两种播放器", source.includes('kind === "video" ? "video" : "audio"'));
check("宿主路由指向 /kxxy/media", source.includes("/kxxy/media?path="));
check("桌面 base 退回官方 /api/file", source.includes("api/file?path="));
check("不对后缀做硬编码白名单拦截（交给内核报错）", !source.includes("KXXY_MEDIA_UNSUPPORTED"));

// 认领的后缀必须覆盖用户实测打不开的那批容器。
const VIDEO_EXT = ["mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "3gp"];
const AUDIO_EXT = ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "weba", "mka", "wma", "aif", "aiff", "au", "amr", "mid", "midi"];
const missingVideo = VIDEO_EXT.filter((ext) => !source.includes(`\t"${ext}",`));
const missingAudio = AUDIO_EXT.filter((ext) => !source.includes(`\t"${ext}",`));
check(`video 认领全部 ${VIDEO_EXT.length} 个后缀`, missingVideo.length === 0, missingVideo.join(", "));
check(`audio 认领全部 ${AUDIO_EXT.length} 个后缀`, missingAudio.length === 0, missingAudio.join(", "));

//#endregion

//#region kxxyMediaExtOf

equal("取后缀：普通路径", api.kxxyMediaExtOf("/a/b/clip.MP4"), "mp4");
equal("取后缀：反斜杠路径", api.kxxyMediaExtOf("C:\\a\\b\\song.Flac"), "flac");
equal("取后缀：无后缀", api.kxxyMediaExtOf("/a/b/README"), "?");
equal("取后缀：以点结尾", api.kxxyMediaExtOf("/a/b/trailing."), "?");
equal("取后缀：非字符串", api.kxxyMediaExtOf(void 0), "?");
equal("取后缀：隐藏文件按末段点号切", api.kxxyMediaExtOf("/a/b/.gitignore"), "gitignore");

//#endregion

//#region body 渲染

const PATH = "/data/user/0/app.kxxy/files/kxxy-home/workspaces/kf/测试/media/video/sample.mp4";
const ADDRESS = "dsh-resource://file/session/abc/workspaces/kf/%E6%B5%8B%E8%AF%95/media/video/sample.mp4";
const BASE = "http://127.0.0.1:3080/chat";

/** 构造一次 body props。`__loaded` 收集 `request.loaded()` 的实参。 */
function makeProps(overrides = {}) {
	const loaded = [];
	const props = {
		content: {
			kind: "renderer",
			revision: 7,
			reload: () => {},
			failed: () => {},
			loaded: (v) => loaded.push(v),
		},
		resourceAddress: ADDRESS,
		useResource: () => ({ status: "live", value: { absolutePath: PATH, version: 3 } }),
		useTabInfo: () => ({ tab: { id: "t1", signal: new AbortController().signal } }),
		scrollportRef: () => {},
		t: (key, params) => (params === void 0 ? key : `${key}:${JSON.stringify(params)}`),
		...overrides,
		__loaded: loaded,
	};
	return props;
}

/** 挂载一个 body，返回 { tree, flush }。 */
function mountBody(body, props, base = BASE) {
	return withBase(base, () => {
		const tree = harness.mount(body, props);
		return { tree, flush: () => withBase(base, () => harness.flush()) };
	});
}

// 正常路径：拿到绝对路径 → 渲染 <video>，src 指向宿主流式路由。
{
	const props = makeProps();
	const { tree } = mountBody(api.kxxyMediaVideoBody, props);
	const video = find(tree, "video");
	check("正常路径渲染出 <video>", video !== void 0);
	equal(
		"video.src 指向 /kxxy/media 并转义了绝对路径",
		video?.props?.src,
		// 以 `/` 开头的路径相对「源」解析，与 base 的 `/chat` 这类路径段无关。
		`http://127.0.0.1:3080/kxxy/media?path=${encodeURIComponent(PATH)}`,
	);
	equal("video 带 controls", video?.props?.controls, true);
	equal("video 用 metadata 预载（不整片下载）", video?.props?.preload, "metadata");
	check("video 标记了 playsInline", video?.props?.playsInline === true);
	equal("未拿到元数据时不误报完成", props.__loaded.length, 0);
	check("包裹节点带 data-kxxy-media 供探针定位", find(tree, "div")?.props?.["data-kxxy-media"] === "video");
}

// 桌面 base：退回官方 /api/file。
{
	const props = makeProps();
	const { tree } = mountBody(api.kxxyMediaVideoBody, props, "dsh-app://app/");
	equal(
		"dsh-app:// base 退回官方 api/file",
		find(tree, "video")?.props?.src,
		`dsh-app://app/api/file?path=${encodeURIComponent(PATH)}`,
	);
}

// 音频：标签换成 <audio>，且不应出现 <video>。
{
	const props = makeProps();
	const { tree } = mountBody(api.kxxyMediaAudioBody, props);
	check("音频路径渲染出 <audio>", find(tree, "audio") !== void 0);
	check("音频路径不渲染 <video>", find(tree, "video") === void 0);
}

//#endregion

//#region 失败分支归因

{
	const props = makeProps();
	const { tree, flush } = mountBody(api.kxxyMediaVideoBody, props);
	find(tree, "video").props.onError({ currentTarget: { error: { code: 4 } } });
	const after = flush();
	const text = textOf(after);
	check("code=4 报「内核不支持该格式」", text.includes("unsupported"));
	check("code=4 的文案带上了后缀名", text.includes("mp4"));
	check("code=4 附带了转码提示", text.includes("hint"));
	check("code=4 仍提供重试按钮", find(after, "button") !== void 0);
	check("code=4 不再渲染播放器", find(after, "video") === void 0);
}

{
	const props = makeProps();
	const { tree, flush } = mountBody(api.kxxyMediaVideoBody, props);
	find(tree, "video").props.onError({ currentTarget: { error: { code: 3 } } });
	const after = flush();
	const text = textOf(after);
	check("code=3 报「播放失败」并带错误码", text.includes("failed") && text.includes('"code":3'));
	check("code=3 不误报「格式不受支持」", !text.includes("unsupported"));
}

{
	// 少数内核下 event.currentTarget.error 为空，不能因此抛异常。
	const props = makeProps();
	const { tree, flush } = mountBody(api.kxxyMediaVideoBody, props);
	find(tree, "video").props.onError({ currentTarget: {} });
	const after = flush();
	check("error 缺失时退化成 code 0 而不是抛错", textOf(after).includes('"code":0'));
}

{
	// 重试：换 key 强制重建播放器，否则内核会一直复用进入 error 态的资源。
	const props = makeProps();
	const { tree, flush } = mountBody(api.kxxyMediaVideoBody, props);
	const firstKey = find(tree, "video").props.key;
	find(tree, "video").props.onError({ currentTarget: { error: { code: 4 } } });
	const failed = flush();
	find(failed, "button").props.onClick();
	const retried = flush();
	const video = find(retried, "video");
	check("重试后重新渲染播放器", video !== void 0);
	check("重试换了元素 key（强制重建 media resource）", video?.props?.key !== firstKey);
}

//#endregion

//#region loaded 上报与资源不可用

{
	const props = makeProps();
	const { tree, flush } = mountBody(api.kxxyMediaVideoBody, props);
	find(tree, "video").props.onLoadedMetadata();
	flush();
	equal("loadedmetadata 后向宿主报告一次", props.__loaded.length, 1);
	equal("报告的 version 取自 stat 结果", props.__loaded[0], 3);

	// 重渲染（同一 revision）不应重复上报。
	flush();
	equal("同一 revision 不重复上报", props.__loaded.length, 1);
}

{
	const props = makeProps({ useResource: () => ({ status: "none" }) });
	const { tree } = mountBody(api.kxxyMediaVideoBody, props);
	check("资源服务不可用时给出明确文案", textOf(tree).includes("unavailable"));
	check("资源服务不可用时也提供重试", find(tree, "button") !== void 0);
}

{
	// stat 成功但没有 absolutePath：不能渲染 src=undefined 的播放器。
	const props = makeProps({ useResource: () => ({ status: "live", value: { version: 1 } }) });
	const { tree } = mountBody(api.kxxyMediaVideoBody, props);
	check("缺 absolutePath 时报「无法解析路径」", textOf(tree).includes("noPath"));
	check("缺 absolutePath 时不渲染播放器", find(tree, "video") === void 0);
}

{
	// stat 还没回来：正常加载态，不能报错。
	const props = makeProps({ useResource: () => ({ status: "loading" }) });
	const { tree } = mountBody(api.kxxyMediaVideoBody, props);
	check("stat 未回时是加载态而非错误", textOf(tree).includes("loading"));
	check("stat 未回时不渲染播放器", find(tree, "video") === void 0);
}

{
	// content 为空（renderer 模式下不该发生，但要有兜底不崩）。
	const props = makeProps({ content: void 0 });
	const { tree } = mountBody(api.kxxyMediaVideoBody, props);
	check("content 为空时不抛错且仍渲染播放器", find(tree, "video") !== void 0);
}

{
	// 官方 TS 契约清单里没列 useResource，将来上游收紧注入面时不能整槽崩掉。
	const props = makeProps({ useResource: void 0 });
	const { tree } = mountBody(api.kxxyMediaVideoBody, props);
	check("useResource 缺失时不抛错", tree !== void 0);
	check("useResource 缺失时是加载态", textOf(tree).includes("loading"));
}

//#endregion

//#region kxxyMediaApply 注册形状

{
	const effects = [];
	const registered = [];
	const slots = [];
	const locales = [];
	const ctx = {
		locale: {
			bind: (ns) => (key, params) => `${ns}.${key}${params === void 0 ? "" : JSON.stringify(params)}`,
			register: (ns, dicts) => locales.push([ns, dicts]),
		},
		documentPreviews: { register: (def) => registered.push(def) },
		slots: { inject: (name, fn) => fn(), register: (options, body) => slots.push([options, body]) },
		effect: (fn, label) => {
			effects.push(label);
			fn();
		},
	};
	api.kxxyMediaApply(ctx);

	equal("注册了 1 份字典", locales.length, 1);
	equal("字典命名空间是 kxxyMedia", locales[0][0], "kxxyMedia");
	check("字典同时有 zh 与 en", locales[0][1].zh !== void 0 && locales[0][1].en !== void 0);
	equal("注册了 2 个 provider", registered.length, 2);
	equal("注册了 2 个 body 槽位", slots.length, 2);
	equal("用了 5 个 effect（1 字典 + 2×（元数据 + body））", effects.length, 5);

	const ids = registered.map((d) => d.id);
	equal("provider id 唯一", new Set(ids).size, 2);
	check("slot key 与 provider id 一一对应", slots.every(([options]) => ids.includes(options.key)));
	check(
		"provider 的 title 是惰性求值（跟随 locale 切换）",
		registered.every((d) => typeof d.title === "function"),
	);
	check(
		"title 取到本地化文案",
		registered[0].title() === "kxxyMedia.videoTitle" && registered[1].title() === "kxxyMedia.audioTitle",
	);

	// 最要命的一条：上游 `DocumentPreviewRegistry.register` 会断言
	// binaryExtensions ⊆ extensions，破例直接抛错、整个 document 槽一起崩。
	for (const def of registered) {
		const missing = def.binaryExtensions.filter((ext) => !def.extensions.includes(ext));
		check(`${def.id} 的 binaryExtensions ⊆ extensions`, missing.length === 0, missing.join(", "));
	}
	check("两个 provider 都标为 builtin", registered.every((d) => d.priority === "builtin"));
	check("wrap 为 false（媒体不需要换行开关）", registered.every((d) => d.wrap === false));
	check("body 是两个不同的组件函数", slots[0][1] !== slots[1][1]);

	// locale 文案里用到的插值参数必须被真实提供，否则界面上会露出 `{ext}`。
	const zh = locales[0][1].zh;
	check("unsupported 文案用 {ext} 插值", zh.unsupported.includes("{ext}"));
	check("failed 文案用 {code} 插值", zh.failed.includes("{code}"));
	check("zh 与 en 的键集合一致（缺键会退回键名）", Object.keys(zh).sort().join() === Object.keys(locales[0][1].en).sort().join());
}

//#endregion

console.log(`\n${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
