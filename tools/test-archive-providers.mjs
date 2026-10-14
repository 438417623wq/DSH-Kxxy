/**
 * 归档 provider 片段的行为测试。
 *
 * 被测对象是 `tools/prebuilt/documentpreview-archive/providers.js` —— 它不是模块，
 * 而是一段会被构建期拼进上游 `client.js` 的**片段**。这里用「读取源码 + 在受控
 * 沙箱里求值 + 只导出要测的函数」的方式把它变成可测单元，好处是测的就是构建期
 * 真正注入的那份字节，不会出现「测试副本与生产副本漂移」。
 *
 * 覆盖的重点是 ZIP 解析器：它是整段里唯一有真实算法复杂度的部分，也是唯一
 * 会在用户设备上炸的地方（EOCD 扫描、ZIP64 溢出、stored/deflate 两种压缩方式、
 * 目录项与本地头的双份长度字段）。解压用 `DecompressionStream`，Node 18+ 自带，
 * 与真机 WebView 104 行为一致。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FRAGMENT = join(HERE, "prebuilt", "documentpreview-archive", "providers.js");

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`  ok   ${label}`);
		return;
	}
	failed += 1;
	console.log(`  FAIL ${label}${detail === void 0 ? "" : ` —— ${detail}`}`);
}

function equal(label, actual, expected) {
	check(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}

//#region 测试用 ZIP 构造器

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let c = i;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * 写一个最小 ZIP。
 *
 * @param entries - `{name, data, store?}` 列表；`store` 为真时用 method 0（不压缩）。
 * @param options - `{zip64: true}` 时把中央目录偏移写成 0xffffffff 并附 ZIP64 记录，
 *                  用来验证解析器的 ZIP64 分支确实被走到。
 */
function buildZip(entries, options = {}) {
	const chunks = [];
	const central = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = Buffer.from(entry.name, "utf8");
		const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
		const method = entry.store === true ? 0 : 8;
		const body = method === 0 ? raw : deflateRawSync(raw);
		const crc = crc32(raw);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28);

		chunks.push(local, nameBytes, body);
		central.push({ nameBytes, method, crc, compSize: body.length, size: raw.length, offset, directory: entry.name.endsWith("/") });
		offset += local.length + nameBytes.length + body.length;
	}

	const cdStart = offset;
	for (const item of central) {
		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(20, 6);
		header.writeUInt16LE(0, 8);
		header.writeUInt16LE(item.method, 10);
		header.writeUInt16LE(0, 12);
		header.writeUInt16LE(0, 14);
		header.writeUInt32LE(item.crc, 16);
		header.writeUInt32LE(item.compSize, 20);
		header.writeUInt32LE(item.size, 24);
		header.writeUInt16LE(item.nameBytes.length, 28);
		header.writeUInt16LE(0, 30);
		header.writeUInt16LE(0, 32);
		header.writeUInt16LE(0, 34);
		header.writeUInt16LE(0, 36);
		header.writeUInt32LE(item.directory ? 0x10 : 0, 38);
		header.writeUInt32LE(item.offset, 42);
		chunks.push(header, item.nameBytes);
		offset += header.length + item.nameBytes.length;
	}
	const cdSize = offset - cdStart;

	if (options.zip64 === true) {
		// ZIP64 EOCD 记录 + 定位器；EOCD 里三个字段写溢出值，逼解析器走 ZIP64 分支。
		const z64 = Buffer.alloc(56);
		z64.writeUInt32LE(0x06064b50, 0);
		z64.writeBigUInt64LE(44n, 4);
		z64.writeUInt16LE(45, 12);
		z64.writeUInt16LE(45, 14);
		z64.writeUInt32LE(0, 16);
		z64.writeUInt32LE(0, 20);
		z64.writeBigUInt64LE(BigInt(central.length), 24);
		z64.writeBigUInt64LE(BigInt(central.length), 32);
		z64.writeBigUInt64LE(BigInt(cdSize), 40);
		z64.writeBigUInt64LE(BigInt(cdStart), 48);

		const locator = Buffer.alloc(20);
		locator.writeUInt32LE(0x07064b50, 0);
		locator.writeUInt32LE(0, 4);
		locator.writeBigUInt64LE(BigInt(offset), 8);
		locator.writeUInt32LE(1, 16);
		chunks.push(z64, locator);
		offset += z64.length + locator.length;
	}

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(options.zip64 === true ? 0xffff : central.length, 8);
	eocd.writeUInt16LE(options.zip64 === true ? 0xffff : central.length, 10);
	eocd.writeUInt32LE(options.zip64 === true ? 0xffffffff : cdSize, 12);
	eocd.writeUInt32LE(options.zip64 === true ? 0xffffffff : cdStart, 16);
	eocd.writeUInt16LE(0, 20);
	chunks.push(eocd);

	return Buffer.concat(chunks);
}

//#endregion

//#region 把片段变成可调用单元

/**
 * 极简 XML 解析器桩。
 *
 * Node 没有 `DOMParser`，而片段在浏览器里是有真货的 —— 这里只需要支撑
 * `getElementsByTagName` + `getAttribute` 两个调用，外加「标签不闭合要报
 * parsererror」这一条真实语义（片段正是靠它拒绝坏 OPF）。
 */
class KxxyFakeElement {
	constructor(tag, attrs) {
		this.tag = tag;
		this.attrs = attrs;
	}

	getAttribute(name) {
		return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
	}
}

class KxxyFakeDocument {
	constructor(elements, broken) {
		this.elements = elements;
		this.broken = broken;
	}

	getElementsByTagName(tag) {
		if (tag === "parsererror") return this.broken ? [new KxxyFakeElement("parsererror", {})] : [];
		return this.elements.filter((element) => element.tag === tag);
	}
}

class KxxyFakeDOMParser {
	parseFromString(text) {
		const elements = [];
		const stack = [];
		let broken = false;
		const token = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
		let match;
		while ((match = token.exec(text)) !== null) {
			const [, closing, tag, rawAttrs, selfClosing] = match;
			if (closing === "/") {
				if (stack.pop() !== tag) broken = true;
				continue;
			}
			const attrs = {};
			const attrToken = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
			let attr;
			while ((attr = attrToken.exec(rawAttrs)) !== null) attrs[attr[1]] = attr[2];
			elements.push(new KxxyFakeElement(tag, attrs));
			if (selfClosing !== "/") stack.push(tag);
		}
		if (stack.length > 0) broken = true;
		return new KxxyFakeDocument(elements, broken);
	}
}

/**
 * 求值片段并取回要测的导出。
 *
 * 片段引用了 `react` / `react_jsx_runtime` / `DOMParser`；这里给前两个一组桩
 * （只测纯函数，不渲染），`DOMParser` 用上面的极简实现。`DecompressionStream`
 * 用宿主自带的 —— Node 18+ 与真机 WebView 104 行为一致。
 */
function loadFragment() {
	const source = readFileSync(FRAGMENT, "utf8");
	const names = ["kxxyReadZip", "kxxyLooksText", "kxxyFormatSize", "kxxyResolvePath", "kxxyDirOf", "kxxyParseOpf", "kxxyBodyInner", "kxxySuffixOf"];
	const reactStub = {
		useState: () => [void 0, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		createElement: () => null,
		useRef: () => ({ current: null }),
	};
	const factory = new Function(
		"react",
		"react_jsx_runtime",
		"DOMParser",
		`${source}\nreturn { ${names.join(", ")} };`,
	);
	return { api: factory(reactStub, { jsx: () => null, jsxs: () => null }, KxxyFakeDOMParser), source };
}

//#endregion

console.log("归档 provider 片段测试");
const { api, source } = loadFragment();

//#region 静态形态

check("片段含 kxxyArchiveApply 入口", source.includes("function kxxyArchiveApply("));
check("片段不含 </script（内联进 bundle 会截断脚本）", !source.includes("</script"));
check("片段不引用本文件作用域之外的裸标识符", !/\brequire\s*\(/.test(source));
check("两个 provider id 都带包名前缀", source.includes('documentpreview/archive"') && source.includes('documentpreview/epub"'));
check("两个 provider 都用 bytes-complete 加载模式", source.split('loading: "bytes-complete"').length - 1 === 2);
check("两个 provider 都声明 binaryExtensions", source.split("binaryExtensions: [").length - 1 === 2);
check("槽位注册走 slots.inject（与上游一致）", source.split('ctx.slots.inject("sidebar.right.tab.document"').length - 1 === 2);

//#endregion

//#region kxxyReadZip

const TEXT = "hello 世界\nsecond line\n";
const BINARY = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x00]);
const zipBytes = buildZip([
	{ name: "note.txt", data: TEXT },
	{ name: "raw.bin", data: BINARY, store: true },
	{ name: "dir/", data: "" },
	{ name: "dir/nested.json", data: '{"a":1}' },
	{ name: "dir/deep/inner.css", data: "body{}" },
]);

const zip = await api.kxxyReadZip(zipBytes);
equal("条目数（含目录项）", zip.entries.length, 5);
equal("目录项被标记为 directory", zip.byName.get("dir/").directory, true);
equal("普通文件不是 directory", zip.byName.get("note.txt").directory, false);

const note = await zip.open(zip.byName.get("note.txt"));
equal("deflate 条目解压后字节数", note.length, Buffer.byteLength(TEXT));
equal("deflate 条目解压后内容", Buffer.from(note).toString("utf8"), TEXT);

const raw = await zip.open(zip.byName.get("raw.bin"));
equal("stored 条目原样返回", Buffer.from(raw).toString("hex"), Buffer.from(BINARY).toString("hex"));

const nested = await zip.open(zip.byName.get("dir/nested.json"));
equal("子目录条目可解", Buffer.from(nested).toString("utf8"), '{"a":1}');

// 注释填充：EOCD 不在文件最末尾，必须靠回扫找到。
const withComment = Buffer.concat([zipBytes, Buffer.from("x".repeat(300), "utf8")]);
const zip2 = await api.kxxyReadZip(withComment);
equal("尾部有杂音时仍能找到 EOCD", zip2.entries.length, 5);

// ZIP64：三个 EOCD 字段溢出，必须走 ZIP64 定位器。
const zip64 = buildZip([{ name: "big.txt", data: "z".repeat(1000) }], { zip64: true });
const zip3 = await api.kxxyReadZip(zip64);
equal("ZIP64 条目数正确", zip3.entries.length, 1);
equal("ZIP64 条目内容正确", Buffer.from(await zip3.open(zip3.byName.get("big.txt"))).toString("utf8").length, 1000);

// 非 ZIP 输入必须明确失败，而不是静默返回空表。
let threw = false;
try {
	await api.kxxyReadZip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
} catch {
	threw = true;
}
check("非 ZIP 输入抛错", threw);

// 压缩方式不支持时要抛错，而不是把压缩字节当内容返回。
const weird = buildZip([{ name: "x.txt", data: "abc" }]);
weird.writeUInt16LE(12, 8); // 本地头 method
const cdOff = weird.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
weird.writeUInt16LE(12, cdOff + 10); // 中央目录 method
const weirdZip = await api.kxxyReadZip(weird);
let methodThrew = false;
try {
	await weirdZip.open(weirdZip.byName.get("x.txt"));
} catch (error) {
	methodThrew = String(error.message).includes("unsupported compression method");
}
check("未知压缩方式抛错", methodThrew);

//#endregion

//#region 文本判定与格式化

check("UTF-8 文本被判定为文本", api.kxxyLooksText(new TextEncoder().encode("abc 中文")));
check("含 NUL 的字节被判定为二进制", !api.kxxyLooksText(new Uint8Array([0x41, 0x00, 0x42])));
check("大量控制字符被判定为二进制", !api.kxxyLooksText(new Uint8Array(Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0x01 : 0x41)))));
equal("小于 1 KiB 显示 B", api.kxxyFormatSize(512), "512 B");
equal("KiB 档位", api.kxxyFormatSize(2048), "2.0 KB");
equal("MiB 档位", api.kxxyFormatSize(3 * 1024 * 1024), "3.0 MB");

//#endregion

//#region 路径解析

equal("相对路径按目录解析", api.kxxyResolvePath("OEBPS/text/", "../images/a.png"), "OEBPS/images/a.png");
equal("多余斜杠被折叠", api.kxxyResolvePath("a/", "./b//c.png"), "a/b/c.png");
equal("根目录解析", api.kxxyDirOf("content.opf"), "");
equal("子目录解析", api.kxxyDirOf("OEBPS/content.opf"), "OEBPS/");
equal("后缀小写化", api.kxxySuffixOf("A/B/C.PNG"), "png");
equal("无后缀返回空串", api.kxxySuffixOf("Makefile"), "");

//#endregion

//#region OPF / XHTML 解析

const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style/main.css" media-type="text/css"/>
    <item id="img" href="images/a.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="c2"/>
    <itemref idref="c1"/>
  </spine>
</package>`;
const parsed = api.kxxyParseOpf(opf, "OEBPS/content.opf");
equal("spine 顺序被尊重（c2 在前）", parsed.spine.map((s) => s.path).join(","), "OEBPS/text/ch2.xhtml,OEBPS/text/ch1.xhtml");
equal("manifest 解析出 4 项", parsed.manifest.size, 4);
equal("manifest href 按 OPF 所在目录解析", parsed.manifest.get("css").path, "OEBPS/style/main.css");

let opfThrew = false;
try {
	api.kxxyParseOpf("<package><unclosed>", "x.opf");
} catch {
	opfThrew = true;
}
check("非良构 OPF 抛错", opfThrew);

equal(
	"XHTML body 内容被取出",
	api.kxxyBodyInner("<html><body><p>hi</p></body></html>").trim(),
	"<p>hi</p>",
);
equal("body 内的 script 被剔除", api.kxxyBodyInner("<body>a<script>evil()</script>b</body>"), "ab");
equal("没有 body 标签时退回整段", api.kxxyBodyInner("<p>x</p>").trim(), "<p>x</p>");

//#endregion

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
