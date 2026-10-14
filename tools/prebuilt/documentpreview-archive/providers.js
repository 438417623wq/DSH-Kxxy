/**
 * kxxy 归档预览 provider（zip / epub）—— 构建期注入到官方 documentpreview 客户端 bundle。
 *
 * 为什么需要它：上游 8 个内置 provider 里没有任何一个能读 ZIP 容器，`.zip` 在
 * `UNVIEWABLE_BINARY_EXTENSIONS` 里，落「该格式文件暂时无法预览」空态；`.epub` 更是
 * 全 bundle 零支持（只有 `"republishing"` 子串噪声），既不在 provider 清单也不在黑名单，
 * 于是把 ZIP 二进制当纯文本读。桌面版同样如此，所以这不是 Android 特有问题，是上游能力缺口。
 *
 * 为什么放在客户端而不是宿主：解压只需要 `DecompressionStream('deflate-raw')`
 * （真机 WebView 104 实测 `DS=function raw=ok deflate=ok gzip=ok`），而宿主侧做的话
 * 要新增一条 remote 命名空间、改 typert 契约、再让客户端长轮询，成本与风险都高得多。
 *
 * 注入形态：本文件是**片段**，不是模块。`tools/lib/patches.mjs` 把它整段拼进
 * `client.js` 的 `exports.apply = apply;` 之前（模块作用域内，因此可以直接用
 * 上游已经 `require` 好的 `react` / `react_jsx_runtime` / primitives 局部变量），
 * 并在 `apply(ctx)` 末尾追加一次 `kxxyArchiveApply(ctx);`。
 *
 * 全部标识符带 `kxxy` / `KXXY_` 前缀 —— 该 bundle 是 26 万字符的扁平作用域，
 * 未加前缀极易与上游局部变量撞名。
 */

/** zip / epub 两个 provider 的注册 id，必须与 slot 的 `key` 一致。 */
const KXXY_ARCHIVE_ID = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/archive";
const KXXY_EPUB_ID = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/epub";
/** 两个 provider 共用一个 locale 命名空间。 */
const KXXY_ARCHIVE_NS = "kxxyArchive";
/** 单个条目解压后的上限：超过就不解，避免一次 `bytes-complete` 读把内存打满。 */
const KXXY_ARCHIVE_MAX_ENTRY = 16 * 1024 * 1024;
/** 电子书内联资源（图片 / 样式）的总上限。 */
const KXXY_ARCHIVE_MAX_INLINE = 24 * 1024 * 1024;

const KXXY_ARCHIVE_ZH = {
	archiveTitle: "压缩包",
	epubTitle: "电子书",
	loading: "读取中…",
	empty: "压缩包内没有文件。",
	openFailed: "无法打开此压缩包。",
	epubFailed: "无法打开此电子书。",
	entryTooLarge: "该条目过大，无法在此预览。",
	entryBinary: "二进制文件，无法以文本方式显示。",
	unsupportedMethod: "该条目使用了不支持的压缩方式。",
	back: "返回列表",
	entries: "共 {count} 个条目",
	encrypted: "压缩包已加密，无法读取。",
};

const KXXY_ARCHIVE_EN = {
	archiveTitle: "Archive",
	epubTitle: "E-book",
	loading: "Reading...",
	empty: "This archive contains no files.",
	openFailed: "This archive could not be opened.",
	epubFailed: "This e-book could not be opened.",
	entryTooLarge: "This entry is too large to preview here.",
	entryBinary: "Binary file; it cannot be shown as text.",
	unsupportedMethod: "This entry uses an unsupported compression method.",
	back: "Back to list",
	entries: "{count} entries",
	encrypted: "This archive is encrypted and cannot be read.",
};

/** UTF-8 解码，遇到非法序列不抛错（压缩包里的文件名未必是规范 UTF-8）。 */
function kxxyDecodeText(bytes) {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** `deflate-raw` 解压。WebView 104 起 `DecompressionStream` 可用；缺失时明确报错而不是静默返回空。 */
async function kxxyInflateRaw(bytes) {
	if (typeof DecompressionStream !== "function") throw new Error("DecompressionStream is unavailable");
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 解析 ZIP 中央目录。
 *
 * 只做「读目录 + 按需解单条」，不一次性全解 —— 用户打开一个 200 MB 的 zip 时
 * 仍然只读一次文件字节，点哪个条目才解哪个。
 */
async function kxxyReadZip(input) {
	const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const u16 = (at) => view.getUint16(at, true);
	const u32 = (at) => view.getUint32(at, true);
	const u64 = (at) => Number(view.getBigUint64(at, true));

	// EOCD 记录尾部可能有最多 64 KiB 的注释，从后往前扫。
	let eocd = -1;
	const floor = Math.max(0, buf.length - 66000);
	for (let at = buf.length - 22; at >= floor; at -= 1) {
		if (u32(at) === 0x06054b50) {
			eocd = at;
			break;
		}
	}
	if (eocd < 0) throw new Error("ZIP end-of-central-directory record not found");

	let total = u16(eocd + 10);
	let cdSize = u32(eocd + 12);
	let cdOff = u32(eocd + 16);

	// ZIP64：三个字段任一溢出即去读 ZIP64 EOCD 定位器（紧邻 EOCD 之前）。
	if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
		let locator = -1;
		for (let at = eocd - 20; at >= Math.max(0, eocd - 20 - 4096); at -= 1) {
			if (u32(at) === 0x07064b50) {
				locator = at;
				break;
			}
		}
		if (locator >= 0) {
			const z64 = u64(locator + 8);
			if (z64 + 56 <= buf.length && u32(z64) === 0x06064b50) {
				total = u64(z64 + 32);
				cdSize = u64(z64 + 40);
				cdOff = u64(z64 + 48);
			}
		}
	}
	if (cdOff + cdSize > buf.length) throw new Error("ZIP central directory is out of range");

	const entries = [];
	let at = cdOff;
	for (let i = 0; i < total; i += 1) {
		if (at + 46 > buf.length || u32(at) !== 0x02014b50) break;
		const flags = u16(at + 8);
		const method = u16(at + 10);
		let compSize = u32(at + 20);
		let size = u32(at + 24);
		const nameLen = u16(at + 28);
		const extraLen = u16(at + 30);
		const commentLen = u16(at + 32);
		const external = u32(at + 38);
		let localOff = u32(at + 42);
		const name = kxxyDecodeText(buf.subarray(at + 46, at + 46 + nameLen));

		// ZIP64 扩展字段（0x0001）按「哪个主字段溢出就补哪个」的顺序排列。
		let extra = at + 46 + nameLen;
		const extraEnd = extra + extraLen;
		while (extra + 4 <= extraEnd) {
			const fieldId = u16(extra);
			const fieldSize = u16(extra + 2);
			if (fieldId === 0x0001) {
				let cursor = extra + 4;
				if (size === 0xffffffff) {
					size = u64(cursor);
					cursor += 8;
				}
				if (compSize === 0xffffffff) {
					compSize = u64(cursor);
					cursor += 8;
				}
				if (localOff === 0xffffffff) {
					localOff = u64(cursor);
					cursor += 8;
				}
			}
			extra += 4 + fieldSize;
		}

		entries.push({
			name,
			method,
			size,
			compSize,
			localOff,
			encrypted: (flags & 0x1) !== 0,
			directory: name.endsWith("/") || ((external >>> 16) & 0x10) !== 0,
		});
		at += 46 + nameLen + extraLen + commentLen;
	}

	const byName = new Map();
	for (const entry of entries) byName.set(entry.name, entry);

	/** 按条目读出原始字节（含解压）。 */
	const open = async (entry) => {
		if (entry.encrypted) throw new Error("entry is encrypted");
		if (entry.size > KXXY_ARCHIVE_MAX_ENTRY) throw new Error("entry exceeds the preview size limit");
		const at = entry.localOff;
		if (at + 30 > buf.length || u32(at) !== 0x04034b50) throw new Error(`broken local header: ${entry.name}`);
		const nameLen = u16(at + 26);
		const extraLen = u16(at + 28);
		const start = at + 30 + nameLen + extraLen;
		const raw = buf.subarray(start, start + entry.compSize);
		if (entry.method === 0) return raw.slice();
		if (entry.method === 8) return kxxyInflateRaw(raw);
		throw new Error(`unsupported compression method ${entry.method}`);
	};

	return { entries, byName, open };
}

/** 人类可读的字节数。 */
function kxxyFormatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 前 4 KiB 无 NUL 且控制字符稀少，才当文本读。 */
function kxxyLooksText(bytes) {
	const end = Math.min(bytes.length, 4096);
	let control = 0;
	for (let i = 0; i < end; i += 1) {
		const byte = bytes[i];
		if (byte === 0) return false;
		if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
	}
	return control * 20 < end;
}

/** 分块 base64，避免 `String.fromCharCode.apply` 在大数组上爆栈。 */
function kxxyToBase64(bytes) {
	let text = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		text += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
	}
	return btoa(text);
}

const KXXY_MIME_BY_SUFFIX = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	css: "text/css",
	ttf: "font/ttf",
	otf: "font/otf",
	woff: "font/woff",
	woff2: "font/woff2",
};

function kxxySuffixOf(path) {
	const dot = path.lastIndexOf(".");
	return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

/** 把相对引用按所在目录解析成 zip 内的绝对条目名。 */
function kxxyResolvePath(base, relative) {
	const parts = `${base}/${relative}`.split("/");
	const stack = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return stack.join("/");
}

/** 目录部分（含结尾 `/`）。 */
function kxxyDirOf(path) {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash + 1);
}

/** 压缩包列表体：目录树扁平列出，点条目看文本内容。 */
function kxxyArchiveBody(props) {
	const { content, t, scrollportRef } = props;
	const data = content !== void 0 && content.kind === "bytes" ? content.data : void 0;
	const [state, setState] = react.useState({ status: "loading" });
	const [picked, setPicked] = react.useState();

	react.useEffect(() => {
		if (data === void 0) return;
		let alive = true;
		setState({ status: "loading" });
		setPicked(void 0);
		kxxyReadZip(data).then(
			(zip) => {
				if (alive) setState({ status: "ready", zip });
			},
			(error) => {
				if (alive) setState({ status: "failed", message: String((error && error.message) || error) });
			},
		);
		return () => {
			alive = false;
		};
	}, [data]);

	const openEntry = (0, react.useCallback)(
		async (zip, entry) => {
			setPicked({ status: "loading", name: entry.name });
			try {
				const bytes = await zip.open(entry);
				setPicked(
					kxxyLooksText(bytes)
						? { status: "ready", name: entry.name, text: kxxyDecodeText(bytes) }
						: { status: "binary", name: entry.name },
				);
			} catch (error) {
				setPicked({ status: "failed", name: entry.name, message: String((error && error.message) || error) });
			}
		},
		[],
	);

	if (state.status === "loading") {
		return react.createElement("p", { style: KXXY_STATUS_STYLE }, t("loading"));
	}
	if (state.status === "failed") {
		return react.createElement(
			"div",
			{ style: KXXY_STATUS_STYLE, role: "alert" },
			react.createElement("p", null, t("openFailed")),
			react.createElement("p", { style: KXXY_DETAIL_STYLE }, state.message),
		);
	}

	const files = state.zip.entries.filter((entry) => !entry.directory);
	if (picked !== void 0) {
		return react.createElement(
			"div",
			{ style: KXXY_PANE_STYLE, ref: scrollportRef, "data-kxxy-archive": "entry" },
			react.createElement(
				"div",
				{ style: KXXY_BAR_STYLE },
				react.createElement(
					"button",
					{ type: "button", style: KXXY_BUTTON_STYLE, onClick: () => setPicked(void 0) },
					t("back"),
				),
				react.createElement("span", { style: KXXY_NAME_STYLE }, picked.name),
			),
			picked.status === "loading" && react.createElement("p", { style: KXXY_STATUS_STYLE }, t("loading")),
			picked.status === "binary" && react.createElement("p", { style: KXXY_STATUS_STYLE }, t("entryBinary")),
			picked.status === "failed" &&
				react.createElement(
					"div",
					{ style: KXXY_STATUS_STYLE, role: "alert" },
					react.createElement("p", null, t("entryTooLarge")),
					react.createElement("p", { style: KXXY_DETAIL_STYLE }, picked.message),
				),
			picked.status === "ready" && react.createElement("pre", { style: KXXY_PRE_STYLE }, picked.text),
		);
	}

	if (files.length === 0) {
		return react.createElement("p", { style: KXXY_STATUS_STYLE }, t("empty"));
	}

	return react.createElement(
		"div",
		{ style: KXXY_PANE_STYLE, ref: scrollportRef, "data-kxxy-archive": "list" },
		react.createElement("p", { style: KXXY_STATUS_STYLE }, t("entries", { count: files.length })),
		react.createElement(
			"ul",
			{ style: KXXY_LIST_STYLE },
			files.map((entry, index) =>
				react.createElement(
					"li",
					{ key: `${index}:${entry.name}`, style: KXXY_ITEM_STYLE },
					react.createElement(
						"button",
						{
							type: "button",
							style: KXXY_ROW_STYLE,
							title: entry.name,
							onClick: () => openEntry(state.zip, entry),
						},
						react.createElement("span", { style: KXXY_NAME_STYLE }, entry.name),
						react.createElement("span", { style: KXXY_SIZE_STYLE }, kxxyFormatSize(entry.size)),
					),
				),
			),
		),
	);
}

/**
 * 电子书体：把 OPF spine 里的章节顺序拼成一份自包含 HTML，再交给 sandbox iframe。
 *
 * 图片与样式一律内联成 `data:` —— `sandbox` 帧是不透明源，`blob:` 子资源在那里
 * 取不到，内联是唯一稳的做法。`<script>` 直接剔除。
 */
function kxxyEpubBody(props) {
	const { content, t } = props;
	const data = content !== void 0 && content.kind === "bytes" ? content.data : void 0;
	const [state, setState] = react.useState({ status: "loading" });

	react.useEffect(() => {
		if (data === void 0) return;
		let alive = true;
		let url;
		setState({ status: "loading" });
		(async () => {
			try {
				const zip = await kxxyReadZip(data);
				const html = await kxxyBuildEpubDocument(zip);
				if (!alive) return;
				url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
				setState({ status: "ready", url });
			} catch (error) {
				if (alive) setState({ status: "failed", message: String((error && error.message) || error) });
			}
		})();
		return () => {
			alive = false;
			if (url !== void 0) URL.revokeObjectURL(url);
		};
	}, [data]);

	if (state.status === "loading") {
		return react.createElement("p", { style: KXXY_STATUS_STYLE }, t("loading"));
	}
	if (state.status === "failed") {
		return react.createElement(
			"div",
			{ style: KXXY_STATUS_STYLE, role: "alert" },
			react.createElement("p", null, t("epubFailed")),
			react.createElement("p", { style: KXXY_DETAIL_STYLE }, state.message),
		);
	}
	return react.createElement("iframe", {
		className: "kxxy-epub-frame",
		src: state.url,
		sandbox: "allow-scripts",
		title: t("epubTitle"),
		"data-kxxy-epub": true,
		style: KXXY_FRAME_STYLE,
	});
}

/** 从 OPF 里取 (manifest href → 绝对条目名) 与 spine 顺序。 */
function kxxyParseOpf(text, opfPath) {
	const dir = kxxyDirOf(opfPath);
	const parser = new DOMParser();
	const doc = parser.parseFromString(text, "application/xml");
	if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("OPF is not well-formed XML");
	const manifest = new Map();
	for (const item of Array.from(doc.getElementsByTagName("item"))) {
		const id = item.getAttribute("id");
		const href = item.getAttribute("href");
		if (id === null || href === null) continue;
		manifest.set(id, { path: kxxyResolvePath(dir, href), mediaType: item.getAttribute("media-type") ?? "" });
	}
	const spine = [];
	for (const ref of Array.from(doc.getElementsByTagName("itemref"))) {
		const idref = ref.getAttribute("idref");
		const item = idref === null ? void 0 : manifest.get(idref);
		if (item !== void 0) spine.push(item);
	}
	return { manifest, spine };
}

/** 取出 XHTML 的 `<body>` 内容；没有 body 标签就退回整段。 */
function kxxyBodyInner(text) {
	const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(text);
	const inner = match === null ? text : match[1];
	return inner.replace(/<script[\s\S]*?<\/script>/gi, "");
}

/** 把章节内的图片 / 样式引用换成内联 data: URL。 */
async function kxxyInlineAssets(zip, chapterPath, html, budget) {
	const dir = kxxyDirOf(chapterPath);
	let out = html;

	const replaceRefs = async (pattern, build) => {
		const matches = [...out.matchAll(pattern)];
		for (const match of matches) {
			const reference = match[1];
			if (/^(?:data:|https?:|blob:)/i.test(reference)) continue;
			const target = kxxyResolvePath(dir, reference.split(/[?#]/u)[0]);
			const entry = zip.byName.get(target);
			if (entry === void 0 || entry.directory) continue;
			if (entry.size > budget.left) continue;
			let bytes;
			try {
				bytes = await zip.open(entry);
			} catch {
				continue;
			}
			budget.left -= bytes.length;
			out = out.split(match[0]).join(build(reference, target, bytes));
		}
	};

	await replaceRefs(/\bsrc\s*=\s*"([^"]+)"/gi, (_reference, target, bytes) => {
		const mime = KXXY_MIME_BY_SUFFIX[kxxySuffixOf(target)] ?? "application/octet-stream";
		return `src="data:${mime};base64,${kxxyToBase64(bytes)}"`;
	});
	await replaceRefs(/<link[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>/gi, (_reference, target, bytes) =>
		`<style>${kxxyDecodeText(bytes)}</style>`,
	);
	return out;
}

/** 组装最终的自包含电子书 HTML。 */
async function kxxyBuildEpubDocument(zip) {
	let opfPath;
	const container = zip.byName.get("META-INF/container.xml");
	if (container !== void 0) {
		const xml = kxxyDecodeText(await zip.open(container));
		const match = /full-path\s*=\s*"([^"]+)"/i.exec(xml);
		if (match !== null) opfPath = match[1];
	}
	if (opfPath === void 0) {
		const fallback = zip.entries.find((entry) => !entry.directory && entry.name.toLowerCase().endsWith(".opf"));
		if (fallback === void 0) throw new Error("EPUB has no OPF package document");
		opfPath = fallback.name;
	}

	const opfEntry = zip.byName.get(opfPath);
	if (opfEntry === void 0) throw new Error(`EPUB OPF not found: ${opfPath}`);
	const opf = kxxyParseOpf(kxxyDecodeText(await zip.open(opfEntry)), opfPath);

	const chapters = opf.spine.length > 0 ? opf.spine : [...opf.manifest.values()].filter((item) => item.mediaType.includes("html"));
	const budget = { left: KXXY_ARCHIVE_MAX_INLINE };
	const sections = [];
	for (const chapter of chapters) {
		const entry = zip.byName.get(chapter.path);
		if (entry === void 0 || entry.directory) continue;
		let bytes;
		try {
			bytes = await zip.open(entry);
		} catch {
			continue;
		}
		const inner = kxxyBodyInner(kxxyDecodeText(bytes));
		sections.push(`<section class="kxxy-chapter">${await kxxyInlineAssets(zip, chapter.path, inner, budget)}</section>`);
	}
	if (sections.length === 0) throw new Error("EPUB has no readable spine document");

	return [
		"<!doctype html>",
		'<html lang="zh"><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		`<style>${KXXY_EPUB_CSS}</style>`,
		"</head><body>",
		sections.join("\n"),
		"</body></html>",
	].join("");
}

/** 把两个 provider 装进客户端上下文。由 `apply(ctx)` 末尾调用。 */
function kxxyArchiveApply(ctx) {
	const t = ctx.locale.bind(KXXY_ARCHIVE_NS);
	ctx.effect(
		() => ctx.locale.register(KXXY_ARCHIVE_NS, { zh: KXXY_ARCHIVE_ZH, en: KXXY_ARCHIVE_EN }),
		"kxxy-archive: dictionaries",
	);
	ctx.effect(
		() =>
			ctx.documentPreviews.register({
				id: KXXY_ARCHIVE_ID,
				extensions: ["zip"],
				binaryExtensions: ["zip"],
				priority: "builtin",
				title: () => t("archiveTitle"),
				loading: "bytes-complete",
				wrap: false,
			}),
		"kxxy-archive: metadata",
	);
	ctx.effect(
		() =>
			ctx.slots.inject("sidebar.right.tab.document", () =>
				ctx.slots.register(
					{
						name: "sidebar.right.tab.document",
						key: KXXY_ARCHIVE_ID,
						locale: KXXY_ARCHIVE_NS,
					},
					kxxyArchiveBody,
				),
			),
		"kxxy-archive: body",
	);
	ctx.effect(
		() =>
			ctx.documentPreviews.register({
				id: KXXY_EPUB_ID,
				extensions: ["epub"],
				binaryExtensions: ["epub"],
				priority: "builtin",
				title: () => t("epubTitle"),
				loading: "bytes-complete",
				wrap: false,
			}),
		"kxxy-epub: metadata",
	);
	ctx.effect(
		() =>
			ctx.slots.inject("sidebar.right.tab.document", () =>
				ctx.slots.register(
					{
						name: "sidebar.right.tab.document",
						key: KXXY_EPUB_ID,
						locale: KXXY_ARCHIVE_NS,
					},
					kxxyEpubBody,
				),
			),
		"kxxy-epub: body",
	);
}

const KXXY_STATUS_STYLE = {
	color: "var(--dsw-alias-label-secondary)",
	margin: "0",
	padding: "10px",
	whiteSpace: "normal",
};
const KXXY_DETAIL_STYLE = { fontSize: "12px", opacity: "0.75", wordBreak: "break-all" };
const KXXY_PANE_STYLE = { height: "100%", overflow: "auto", padding: "4px 0" };
const KXXY_BAR_STYLE = {
	display: "flex",
	alignItems: "center",
	gap: "8px",
	padding: "6px 10px",
	position: "sticky",
	top: "0",
	background: "var(--dsw-alias-bg-base)",
	borderBottom: "1px solid var(--dsw-alias-border-l2)",
};
const KXXY_BUTTON_STYLE = {
	flex: "0 0 auto",
	font: "inherit",
	color: "inherit",
	background: "transparent",
	border: "1px solid var(--dsw-alias-border-l2)",
	borderRadius: "6px",
	padding: "2px 10px",
	cursor: "pointer",
};
const KXXY_LIST_STYLE = { listStyle: "none", margin: "0", padding: "0" };
const KXXY_ITEM_STYLE = { margin: "0", padding: "0" };
const KXXY_ROW_STYLE = {
	display: "flex",
	alignItems: "baseline",
	gap: "12px",
	width: "100%",
	textAlign: "left",
	font: "inherit",
	color: "inherit",
	background: "transparent",
	border: "0",
	borderBottom: "1px solid var(--dsw-alias-border-l2)",
	padding: "8px 12px",
	cursor: "pointer",
};
const KXXY_NAME_STYLE = {
	flex: "1 1 auto",
	minWidth: "0",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
};
const KXXY_SIZE_STYLE = {
	flex: "0 0 auto",
	fontSize: "12px",
	color: "var(--dsw-alias-label-secondary)",
	fontVariantNumeric: "tabular-nums",
};
const KXXY_PRE_STYLE = {
	margin: "0",
	padding: "10px 12px",
	whiteSpace: "pre-wrap",
	wordBreak: "break-word",
	fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
	fontSize: "12px",
	lineHeight: "1.5",
};
const KXXY_FRAME_STYLE = { border: "none", width: "100%", height: "100%", minHeight: "240px", display: "block" };
const KXXY_EPUB_CSS = [
	":root{color-scheme:light dark}",
	"body{margin:0;padding:16px 18px 48px;font-family:system-ui,-apple-system,'Noto Sans SC',sans-serif;",
	"font-size:16px;line-height:1.75;color:var(--dsw-alias-label-primary,#1a1a1a);background:transparent;",
	"word-wrap:break-word}",
	".kxxy-chapter{break-after:page;page-break-after:always}",
	".kxxy-chapter:last-child{break-after:auto;page-break-after:auto}",
	".kxxy-chapter+.kxxy-chapter{margin-top:28px;padding-top:24px;border-top:1px solid rgba(128,128,128,.3)}",
	"img,svg{max-width:100%;height:auto}",
	"h1,h2,h3{line-height:1.35}",
	"pre{white-space:pre-wrap;word-break:break-word}",
	"table{max-width:100%;border-collapse:collapse}",
	"a{color:inherit}",
].join("");
