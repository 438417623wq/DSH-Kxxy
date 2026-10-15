/**
 * kxxy 音视频预览 provider（video / audio）—— 构建期注入到官方 documentpreview 客户端 bundle。
 *
 * 为什么需要它：上游 8 个内置 provider 里没有任何一个处理音视频，而 `.mp4 .mov .avi .mkv
 * .webm .flv .wmv .m4v .mp3 .wav .flac .ogg .m4a .aac .wma .opus` 恰好是
 * `UNVIEWABLE_BINARY_EXTENSIONS` 数组**开头**的一批（见 bundle 里那份 65 项清单）。
 * 判据链于是走到 `matched.length === 0 && unviewable` → 返回空数组 → 渲染
 * `data-textpreview-state="unsupported"` 空态「该格式文件暂时无法预览」。
 * 桌面版同样如此，所以这不是 Android 特有问题，是上游能力缺口。
 *
 * ★为什么用 `renderer` 模式而不是 `bytes-complete`：
 *   bytes-complete 要把整个文件经 `remote.workspaceFiles.readBytes` 拉进内存，
 *   上限 `config.maxFileBytes`（默认 32 MiB，见 dsh-api-workspace-files 的 Config）
 *   —— 一个几秒的手机视频就超，超了直接抛 `workspace-file/too-large`，界面只剩错误。
 *   renderer 模式不传字节：body 只需把 `<video src>` 指向宿主的一条 HTTP 路由，
 *   由浏览器的媒体栈自己去取、自己按 Range seek。代价是宿主侧要有一条能回
 *   206 Partial Content 的路由（`plugins/kxxy-host/lib/index.js` 的 `/kxxy/media`），
 *   而那条路由同时也解掉了上游 `/api/file` 的 20 MiB（`maxImageBytes`）上限。
 *
 * ★为什么把「能不能播」交给浏览器而不是查表：
 *   WebView 104 实测 `canPlayType` 的 PROBABLY 集只有 avc1/vp8/vp9/mp3/aac/flac/
 *   opus/vorbis，mkv/avi/wmv/flv/mpg/ts 全是 ""；但安卓 16 那台设备的内核更新，
 *   硬编码一张「不支持清单」会跟着错。这里一律先渲染播放器，让 `error` 事件
 *   自己说话 —— `MediaError.code === 4`（SRC_NOT_SUPPORTED）给「格式不受支持」，
 *   其余给「播放失败 + 错误码」。
 *
 * 注入形态：本文件是**片段**，不是模块。`tools/lib/patches.mjs` 把它整段拼进
 * `client.js` 的 `exports.apply = apply;` 之前（模块作用域内，因此可以直接用
 * 上游已经 `require` 好的 `react` 局部变量），并在 `apply(ctx)` 末尾追加一次
 * `kxxyMediaApply(ctx);`。
 *
 * 全部标识符带 `kxxy` / `KXXY_` 前缀 —— 该 bundle 是 27 万字符的扁平作用域，
 * 未加前缀极易与上游局部变量撞名。
 */

/** 两个 provider 的注册 id，必须与 slot 的 `key` 一致。 */
const KXXY_MEDIA_VIDEO_ID = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/media-video";
const KXXY_MEDIA_AUDIO_ID = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/media-audio";
/** 两个 provider 共用一个 locale 命名空间。 */
const KXXY_MEDIA_NS = "kxxyMedia";

/**
 * 认领的后缀。
 *
 * ⚠️ `.ts` 与代码预览器的 TypeScript 撞名。两边都 `priority: "builtin"`，
 * `matchingDocumentPreviews` 排序为 rank → 后缀长度 → 注册顺序，上游代码预览器
 * 先注册因而排在前面，所以 `.ts` 默认仍按 TypeScript 打开（符合直觉），
 * 但「打开方式」菜单里会多出「视频」一项，真遇到 MPEG-TS 视频时可选。
 */
const KXXY_MEDIA_VIDEO_EXT = [
	"mp4",
	"m4v",
	"webm",
	"ogv",
	"mov",
	"mkv",
	"avi",
	"wmv",
	"flv",
	"mpg",
	"mpeg",
	"ts",
	"3gp",
];
const KXXY_MEDIA_AUDIO_EXT = [
	"mp3",
	"m4a",
	"aac",
	"wav",
	"flac",
	"ogg",
	"oga",
	"opus",
	"weba",
	"mka",
	"wma",
	"aif",
	"aiff",
	"au",
	"amr",
	"mid",
	"midi",
];

const KXXY_MEDIA_ZH = {
	videoTitle: "视频",
	audioTitle: "音频",
	loading: "准备播放…",
	unsupported: "当前系统的浏览器内核不支持 {ext} 格式，无法在此播放。",
	failed: "播放失败（错误码 {code}），文件可能已损坏。",
	noPath: "无法解析该文件的绝对路径。",
	unavailable: "文件资源服务不可用。",
	retry: "重试",
	hint: "mkv / avi / wmv / flv / mpg 等容器通常需要先转成 mp4 或 webm 才能播放。",
	download: "可用系统播放器打开",
};

const KXXY_MEDIA_EN = {
	videoTitle: "Video",
	audioTitle: "Audio",
	loading: "Preparing playback...",
	unsupported: "This system's browser engine cannot play {ext} files.",
	failed: "Playback failed (error {code}); the file may be damaged.",
	noPath: "The file's absolute path could not be resolved.",
	unavailable: "The file resource service is unavailable.",
	retry: "Retry",
	hint: "Containers such as mkv, avi, wmv, flv and mpg usually need converting to mp4 or webm first.",
	download: "Open in a system player",
};

/** 取小写后缀（不含点），取不到时返回 `"?"`，只用于文案。 */
function kxxyMediaExtOf(path) {
	if (typeof path !== "string") return "?";
	const normalized = path.replaceAll("\\", "/").toLowerCase();
	const name = normalized.slice(normalized.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot < 0 || dot === name.length - 1 ? "?" : name.slice(dot + 1);
}

const KXXY_MEDIA_PANE_STYLE = {
	height: "100%",
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	gap: "12px",
	padding: "16px",
	boxSizing: "border-box",
};
const KXXY_MEDIA_VIDEO_STYLE = {
	maxWidth: "100%",
	maxHeight: "100%",
	backgroundColor: "#000",
	borderRadius: "6px",
};
const KXXY_MEDIA_AUDIO_STYLE = { width: "100%", maxWidth: "520px" };
const KXXY_MEDIA_STATUS_STYLE = { margin: "0", textAlign: "center" };
const KXXY_MEDIA_DETAIL_STYLE = {
	margin: "0",
	textAlign: "center",
	fontSize: "12px",
	opacity: "0.75",
	lineHeight: "1.6",
};
const KXXY_MEDIA_BUTTON_STYLE = {
	font: "inherit",
	padding: "6px 16px",
	borderRadius: "6px",
	border: "1px solid currentColor",
	background: "transparent",
	color: "inherit",
	cursor: "pointer",
};

/**
 * 造一个 body 组件。video 与 audio 只差标签名和样式，其余逻辑完全一致，
 * 因此共用同一个工厂 —— 片段里多一份重复实现就多一处会漂移的地方。
 *
 * @param kind - "video" | "audio"
 */
function kxxyMakeMediaBody(kind) {
	return function kxxyMediaBody(props) {
		const { content, resourceAddress, t } = props;
		// renderer 模式：content 是宿主给的加载请求对象，不是字节。
		const request = content !== void 0 && content.kind === "renderer" ? content : void 0;
		// useResource 是 `sidebar.right.tab.document` 的标准 prop（与 MarkdownBody 同款用法），
		// 这里要的是 stat 结果里的 absolutePath —— 媒体路由按绝对路径取文件。
		// 官方 TS 契约清单里没列它，但运行时确实注入了；仍做一次存在性判断，
		// 免得将来上游收紧注入面时整个 document 槽跟着崩。
		const meta = typeof props.useResource === "function" ? props.useResource(resourceAddress) : void 0;
		const absolutePath = meta?.value?.absolutePath;
		const version = meta?.value?.version;
		const [status, setStatus] = react.useState({ phase: "waiting" });
		const [attempt, setAttempt] = react.useState(0);
		// 已上报过的 revision：`request.loaded` 会写 store，store 变化又会让
		// `content` 换一个新对象、effect 重跑。store 的 `rendered` 只认 revision，
		// 重复调用虽然大概率被 immer 的结构共享挡掉，但这里显式只报一次更稳。
		const reported = react.useRef();

		const url = react.useMemo(() => {
			if (typeof absolutePath !== "string" || absolutePath === "") return void 0;
			if (absolutePath.includes("\u0000")) return void 0;
			try {
				const base = document.baseURI;
				// 安卓宿主是 http://127.0.0.1:PORT，走自带 Range/206 的流式路由；
				// 桌面（dsh-app://）没有这条路由，退回官方 /api/file。
				const suffix = /^https?:/i.test(base)
					? `/kxxy/media?path=${encodeURIComponent(absolutePath)}`
					: `api/file?path=${encodeURIComponent(absolutePath)}`;
				return new URL(suffix, base).href;
			} catch {
				return void 0;
			}
		}, [absolutePath]);

		// 元数据到手才算「渲染完成」：宿主据此把 hasContent 置真、清掉 loading。
		// 不调它的话标签页会永远停在加载中，刷新工具条也不工作。
		react.useEffect(() => {
			if (request === void 0) return;
			if (status.phase !== "ready") return;
			if (reported.current === request.revision) return;
			reported.current = request.revision;
			request.loaded(version === void 0 ? 1 : version);
		}, [request, status.phase, version]);

		const retry = (0, react.useCallback)(() => {
			setStatus({ phase: "waiting" });
			setAttempt((n) => n + 1);
		}, []);

		const notice = (message, detail) =>
			react.createElement(
				"div",
				{
					style: KXXY_MEDIA_PANE_STYLE,
					ref: props.scrollportRef,
					role: "alert",
					"data-kxxy-media": kind,
					"data-kxxy-media-state": "failed",
				},
				react.createElement("p", { style: KXXY_MEDIA_STATUS_STYLE }, message),
				detail === void 0 ? null : react.createElement("p", { style: KXXY_MEDIA_DETAIL_STYLE }, detail),
				react.createElement(
					"button",
					{ type: "button", style: KXXY_MEDIA_BUTTON_STYLE, onClick: retry },
					t("retry"),
				),
			);

		if (url === void 0) {
			if (meta?.status === "none") return notice(t("unavailable"), void 0);
			// 元数据已到（`value` 有值）却没有绝对路径：态是「已解析」但拿不到路径，
			// 这时候若退回加载态就会永远转圈，必须报出来。
			if (meta?.value !== void 0) return notice(t("noPath"), void 0);
			// 元数据还没回：正常加载态，别报错。
			return react.createElement(
				"p",
				{ style: KXXY_MEDIA_STATUS_STYLE, "data-kxxy-media": kind, "data-kxxy-media-state": "loading" },
				t("loading"),
			);
		}

		if (status.phase === "failed") {
			const ext = kxxyMediaExtOf(absolutePath);
			// MediaError.code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED：容器/编码不被内核接受，
			// 这与「文件损坏」是两回事，文案必须分开，否则用户会去反复重试。
			return status.code === 4
				? notice(t("unsupported", { ext }), t("hint"))
				: notice(t("failed", { code: status.code }), t("hint"));
		}

		const player = react.createElement(kind === "video" ? "video" : "audio", {
			// attempt 进 key：重试时强制换一个元素，否则浏览器会一直用
			// 那个已经进入 error 态的 media resource。
			key: `${url}#${attempt}`,
			src: url,
			controls: true,
			preload: "metadata",
			playsInline: true,
			style: kind === "video" ? KXXY_MEDIA_VIDEO_STYLE : KXXY_MEDIA_AUDIO_STYLE,
			onLoadedMetadata: () => setStatus({ phase: "ready" }),
			onError: (event) => {
				const code = event?.currentTarget?.error?.code;
				setStatus({ phase: "failed", code: typeof code === "number" ? code : 0 });
			},
		});

		return react.createElement(
			"div",
			{
				style: KXXY_MEDIA_PANE_STYLE,
				ref: props.scrollportRef,
				"data-kxxy-media": kind,
				"data-kxxy-media-state": status.phase,
			},
			player,
		);
	};
}

const kxxyMediaVideoBody = kxxyMakeMediaBody("video");
const kxxyMediaAudioBody = kxxyMakeMediaBody("audio");

function kxxyMediaApply(ctx) {
	const t = ctx.locale.bind(KXXY_MEDIA_NS);
	ctx.effect(
		() => ctx.locale.register(KXXY_MEDIA_NS, { zh: KXXY_MEDIA_ZH, en: KXXY_MEDIA_EN }),
		"kxxy-media: dictionaries",
	);
	ctx.effect(
		() =>
			ctx.documentPreviews.register({
				id: KXXY_MEDIA_VIDEO_ID,
				extensions: KXXY_MEDIA_VIDEO_EXT,
				// binaryExtensions 必须是 extensions 的子集（注册时会断言），
				// 这里两者相同：音视频全是二进制，没有可当文本读的。
				binaryExtensions: KXXY_MEDIA_VIDEO_EXT,
				priority: "builtin",
				title: () => t("videoTitle"),
				loading: "renderer",
				wrap: false,
			}),
		"kxxy-media: video metadata",
	);
	ctx.effect(
		() =>
			ctx.slots.inject("sidebar.right.tab.document", () =>
				ctx.slots.register(
					{
						name: "sidebar.right.tab.document",
						key: KXXY_MEDIA_VIDEO_ID,
						locale: KXXY_MEDIA_NS,
					},
					kxxyMediaVideoBody,
				),
			),
		"kxxy-media: video body",
	);
	ctx.effect(
		() =>
			ctx.documentPreviews.register({
				id: KXXY_MEDIA_AUDIO_ID,
				extensions: KXXY_MEDIA_AUDIO_EXT,
				binaryExtensions: KXXY_MEDIA_AUDIO_EXT,
				priority: "builtin",
				title: () => t("audioTitle"),
				loading: "renderer",
				wrap: false,
			}),
		"kxxy-media: audio metadata",
	);
	ctx.effect(
		() =>
			ctx.slots.inject("sidebar.right.tab.document", () =>
				ctx.slots.register(
					{
						name: "sidebar.right.tab.document",
						key: KXXY_MEDIA_AUDIO_ID,
						locale: KXXY_MEDIA_NS,
					},
					kxxyMediaAudioBody,
				),
			),
		"kxxy-media: audio body",
	);
}
