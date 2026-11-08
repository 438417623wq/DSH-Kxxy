/**
 * 扩展安装器的装配逻辑测试（问题.txt【1】【4】【6】）。
 *
 * 被测对象是 `plugins/kxxy-host/lib/extinstall.mjs` 里三个纯文件系统函数：
 *   · buildViews         —— bin 递归展平 + opt/<name>/lib 软链 + etc/share 合并视图
 *   · applyPlaceholders  —— 按包内清单回填 @DSH_ROOT@ 等占位符
 *   · removeExtension / relinkAll —— 按 .links.json 回收与重建
 *
 * 为什么能在构建机上测：这三件事只依赖 node:fs 的软链接能力，与安卓无关。
 * **但 Windows 建软链接需要「开发者模式」或管理员**（缺了报
 * `EPERM: operation not permitted, symlink …`）。所以脚本开头先真建一条
 * 链接探测该能力，**没有就整轮 SKIP 并说明原因**：被测代码的每一条
 * `symlinkSync` 都会落进它自己的 catch，视图一条都建不出来，硬跑只会得到
 * 与被测逻辑无关的满屏 FAIL。曾经的行为更糟 —— 直接崩在 `readlinkSync`
 * 的 ENOENT 上，连「为什么」都不打印。
 * 真机上这条路径由「获取」按钮触发，装一次要解 60~250 MiB，出错的代价很高，
 * 所以每个「为什么会这样写」的分支都在这里钉一条断言。
 *
 * 覆盖的都是真机踩过或注定会踩的坑：
 *   · `bin/texlive/` 作为**目录**被整体软链 ⇒ 411 个 TeX 引擎一个都不在 PATH
 *   · 展平后 `name` 不再等于扩展内相对路径 ⇒ relinkAll 必须靠记下的 src 重建
 *   · `existsSync` 会跟随符号链接 ⇒ 悬空链接判断不出「已存在」，建链抛 EEXIST
 *   · 卸载时不校验链接归属 ⇒ 把后装扩展贡献的同名资源一起摘掉
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
	applyPlaceholders,
	buildViews,
	ensureLibexecView,
	healExtensions,
	placeholderMap,
	poolSignature,
	relinkAll,
	removeExtension,
	staleExtensions,
	SHADOWING_BARE_LIBS,
	LAYOUT_VERSION,
} from '../plugins/kxxy-host/lib/extinstall.mjs';

let passed = 0;
let failed = 0;

/**
 * 本机能不能建符号链接？
 *
 * 在临时目录里真建一条（悬空目标即可）再删掉 —— 不猜注册表、不猜管理员，
 * 只问「这个能力现在到底有没有」。Windows 上缺「开发者模式」且非管理员时
 * 会抛 `EPERM`；Linux / Android 上恒为 true。
 */
const SYMLINKS_OK = (() => {
	try {
		const probe = mkdtempSync(join(tmpdir(), 'kxxy-symprobe-'));
		try {
			symlinkSync(join(probe, 'nowhere'), join(probe, 'link'));
			return true;
		} finally {
			rmSync(probe, { recursive: true, force: true });
		}
	} catch {
		return false;
	}
})();

/**
 * 断言「这是一条指向 `target` 的符号链接」。
 *
 * 本机建不出链接时这组用例根本跑不起来（buildViews 里的 symlinkSync 全部
 * 落进 catch，视图一个都不会被建出来），所以整轮在下面直接跳过，这里不再
 * 做降级判定 —— 半真半假的断言比不跑更误导人。
 */
function checkLink(label, path, target) {
	let ok = false;
	try { ok = lstatSync(path).isSymbolicLink() && readlinkSync(path) === target; } catch { ok = false; }
	check(label, ok, `期望 → ${target}`);
}

function checkNotLink(label, path) {
	check(label, lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink());
}

function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`  ok   ${label}`);
		return;
	}
	failed += 1;
	console.log(`  FAIL ${label}${detail === void 0 ? '' : ` —— ${detail}`}`);
}

function equal(label, actual, expected) {
	check(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}

/** 在临时工作区里造一个扩展目录树。 */
function makeExt(root, id, tree) {
	const extDir = join(root, 'extensions', id);
	mkdirSync(extDir, { recursive: true });
	for (const [rel, content] of Object.entries(tree)) {
		const full = join(extDir, rel);
		if (content === null) {
			mkdirSync(full, { recursive: true });
			continue;
		}
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, content);
	}
	return extDir;
}

const workdir = mkdtempSync(join(tmpdir(), 'kxxy-extinstall-'));

// 本机没有建链接的能力 ⇒ 被测代码（extinstall.mjs）的每一条 symlinkSync 都会
// 落进它自己的 catch 里，视图一条都建不出来。此时继续跑只会得到满屏 FAIL，
// 而 FAIL 的成因与被测逻辑毫无关系 —— 那是环境缺能力，不是代码有 bug。
// 明确跳过并给出原因，比「假装跑过」或「红一片」都诚实。
if (!SYMLINKS_OK) {
	rmSync(workdir, { recursive: true, force: true });
	console.log('扩展安装器装配测试：跳过（SKIP）');
	console.log(
		'  原因：本机无法创建符号链接。Windows 需要「开发者模式」或管理员权限，' +
		'当前两者都不具备（实测 symlink 抛 EPERM）。',
	);
	console.log(
		'  影响：extinstall.mjs 的视图全部靠软链建立，没有该能力时被测逻辑整条走不通，' +
		'本脚本 0 条断言被执行。',
	);
	console.log(
		'  说明：Android 与 Linux 上恒有该能力，真机安装路径不受此限制影响；' +
		'如需在 Windows 上验证，请开启「设置 → 系统 → 开发者选项 → 开发者模式」后重跑。',
	);
	process.exit(0);
}

try {
	// -----------------------------------------------------------------------
	console.log('[1] bin 递归展平（问题.txt【4】TeX Live 的 411 个引擎）');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r1');
		const extDir = makeExt(root, 'texlive', {
			'bin/tlmgr': '#!/bin/sh\n',
			'bin/texlive/pdftex': 'PDFTEX',
			'bin/texlive/xetex': 'XETEX',
			'bin/texlive/latexmk': 'LATEXMK',
			'share/texlive/2026.0/tlmgr.pl': 'perl',
		});

		const links = buildViews(root, 'texlive', extDir);

		check('bin/pdftex 出现在引擎 bin 里（展平）', existsSync(join(root, 'bin', 'pdftex')));
		check('bin/xetex 出现在引擎 bin 里（展平）', existsSync(join(root, 'bin', 'xetex')));
		check('bin/latexmk 出现在引擎 bin 里（展平）', existsSync(join(root, 'bin', 'latexmk')));
		check('bin/tlmgr 出现在引擎 bin 里（顶层）', existsSync(join(root, 'bin', 'tlmgr')));
		equal('展开出的命令数', links.bins.length, 4);

		// 展平后的 src 必须指向扩展内的真实文件，否则 relinkAll 重建时会找不到
		const pdftex = links.bins.find((b) => b.name === 'pdftex');
		check('展平条目记下了 src', typeof pdftex?.src === 'string' && pdftex.src.endsWith(join('bin', 'texlive', 'pdftex')),
			`src=${pdftex?.src}`);

		// 目录软链保留：texlinks / fmtutil 靠「自己所在目录」找兄弟程序
		const dirLink = join(root, 'bin', 'texlive');
		check('bin/texlive 目录软链存在', existsSync(dirLink) && lstatSync(dirLink).isSymbolicLink());
		checkLink('目录软链指向扩展内的 bin/texlive', dirLink, join(extDir, 'bin', 'texlive'));
		check('目录软链计入 views（kind=dir）', links.views.some((v) => v.kind === 'dir' && v.name === 'texlive'));
	}

	// -----------------------------------------------------------------------
	console.log('[2] 同名命令：同扩展内重名不互相顶掉');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r2');
		const extDir = makeExt(root, 'dup', {
			'bin/foo': 'TOP',
			'bin/sub/foo': 'SUB',
		});

		const links = buildViews(root, 'dup', extDir);
		equal('两个 foo 都保留', links.bins.length, 2);
		check('顶层 foo 拿到干净名', existsSync(join(root, 'bin', 'foo')));
		check('子目录 foo 退回相对路径形态', existsSync(join(root, 'bin', 'sub_foo')));
		equal('顶层 foo 的内容正确', readFileSync(join(root, 'bin', 'foo'), 'utf8'), 'TOP');
		equal('重命名后的 foo 内容正确', readFileSync(join(root, 'bin', 'sub_foo'), 'utf8'), 'SUB');
	}

	// -----------------------------------------------------------------------
	console.log('[3] opt/<name>/lib → <extDir>/lib（Gradle / Kotlin 布局）');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r3');
		const extDir = makeExt(root, 'gradle', {
			'bin/gradle': '#!/bin/sh\n',
			'opt/gradle/lib/gradle-cli.jar': 'JAR',
		});

		const links = buildViews(root, 'gradle', extDir);
		const libLink = join(extDir, 'lib');
		check('extDir/lib 软链已建', existsSync(libLink) && lstatSync(libLink).isSymbolicLink());
		checkLink('extDir/lib 指向 opt/gradle/lib', libLink, join(extDir, 'opt', 'gradle', 'lib'));
		// launcher 解链后向上一层取 $APP_HOME，再拼 $APP_HOME/lib/*.jar
		check('launcher 的 $APP_HOME/lib/*.jar 因此命中', existsSync(join(extDir, 'lib', 'gradle-cli.jar')));
		check('该软链计入 views', links.views.some((v) => v.kind === 'dir' && v.name === 'lib'));
	}

	// -----------------------------------------------------------------------
	console.log('[4] opt/<name>/lib 不覆盖扩展自带的 lib/');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r4');
		const extDir = makeExt(root, 'both', {
			'lib/libreal.so': 'REAL',
			'opt/thing/lib/x.jar': 'JAR',
		});

		buildViews(root, 'both', extDir);
		check('自带 lib/ 仍是真目录', lstatSync(join(extDir, 'lib')).isDirectory());
		check('自带 lib/ 里的库还在', existsSync(join(extDir, 'lib', 'libreal.so')));
		check('库已复制进引擎 lib', existsSync(join(root, 'lib', 'libreal.so')));
	}

	// -----------------------------------------------------------------------
	console.log('[4b] 裸名遮蔽库不进引擎 lib（缺陷 BH）');
	// -----------------------------------------------------------------------
	{
		// 缺陷 BH：扩展带来的 libheif.so 是 soname libheif.so.1 的 1.23.6，
		// 系统的 /system/lib64/libheif.so 是另一个库（符号零重叠）。因为
		// <root>/lib 在 LD_LIBRARY_PATH 首位，裸名落进去就会让系统侧
		// libhwui.so 的 _Z17createHeifDecoderv 解析失败。
		// 带版本名的那个必须照常复制 —— 13 个消费者一律要 libheif.so.1。
		const root = join(workdir, 'r4b');
		const extDir = makeExt(root, 'imagemagick', {
			'lib/libheif.so': 'SYSTEM-SHADOW',
			'lib/libheif.so.1': 'REAL-HEIF',
			'lib/libheif.so.1.23.6': 'REAL-HEIF-2',
			'lib/libMagickCore.so': 'MAGICK',
		});

		const links = buildViews(root, 'imagemagick', extDir);
		check('裸名 libheif.so 没被复制进引擎 lib', !existsSync(join(root, 'lib', 'libheif.so')));
		check('带 soname 的 libheif.so.1 照常复制', existsSync(join(root, 'lib', 'libheif.so.1')));
		check('全版本名 libheif.so.1.23.6 照常复制', existsSync(join(root, 'lib', 'libheif.so.1.23.6')));
		check('其它库不受影响', existsSync(join(root, 'lib', 'libMagickCore.so')));
		check('清单里也不记裸名', !links.libs.some((l) => l.name === 'libheif.so'));
		check('清单里记了带版本名的', links.libs.some((l) => l.name === 'libheif.so.1'));
		check('SHADOWING_BARE_LIBS 含 libheif.so 与 liblzma.so',
			SHADOWING_BARE_LIBS.has('libheif.so') && SHADOWING_BARE_LIBS.has('liblzma.so'));

		// relink 自愈：老设备上这些裸名已经躺在盘上了，必须被摘掉
		writeFileSync(join(root, 'lib', 'libheif.so'), 'OLD-INSTALL-LEFTOVER');
		writeFileSync(join(root, 'lib', 'liblzma.so'), 'OLD-INSTALL-LEFTOVER');
		mkdirSync(join(root, 'extensions'), { recursive: true });
		writeFileSync(join(root, 'extensions', '.relink'), '1');
		relinkAll(root);
		check('relink 摘掉盘上残留的裸名 libheif.so', !existsSync(join(root, 'lib', 'libheif.so')));
		check('relink 摘掉盘上残留的裸名 liblzma.so', !existsSync(join(root, 'lib', 'liblzma.so')));
		check('relink 没有误删带版本名的库', existsSync(join(root, 'lib', 'libheif.so.1')));
	}

	// -----------------------------------------------------------------------
	console.log('[5] etc / share 合并视图（问题.txt【6】fontconfig / tessdata）');	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r5');
		const fontExt = makeExt(root, 'texlive', {
			'etc/fonts/fonts.conf': '<fontconfig/>',
			'share/texlive/x': 'X',
		});
		const tessExt = makeExt(root, 'tesseract', {
			'share/tessdata/eng.traineddata': 'ENG',
		});
		// 互补贡献：gnuplot 往同一个 etc/fonts 里放的是**另一个**文件。
		// 整目录软链会让它整棵被 texlive 的树遮掉 —— 实测 etc/fonts 有 7 个
		// 扩展共同贡献，conf.d 与 fonts.conf 恰好分属不同包。
		const gnuplotExt = makeExt(root, 'gnuplot', {
			'etc/fonts/conf.d/10-hinting.conf': 'HINT',
		});

		const l1 = buildViews(root, 'texlive', fontExt);
		buildViews(root, 'tesseract', tessExt);
		buildViews(root, 'gnuplot', gnuplotExt);

		check('root/etc/fonts 可见', existsSync(join(root, 'etc', 'fonts', 'fonts.conf')));
		check('root/share/texlive 可见', existsSync(join(root, 'share', 'texlive', 'x')));
		check('root/share/tessdata 可见（第二个扩展的贡献）', existsSync(join(root, 'share', 'tessdata', 'eng.traineddata')));
		equal('fonts.conf 内容经软链可读', readFileSync(join(root, 'etc', 'fonts', 'fonts.conf'), 'utf8'), '<fontconfig/>');
		check('后来者往同一目录里的互补文件也可见（未被整目录遮蔽）', existsSync(join(root, 'etc', 'fonts', 'conf.d', '10-hinting.conf')));
		equal('互补文件内容正确', readFileSync(join(root, 'etc', 'fonts', 'conf.d', '10-hinting.conf'), 'utf8'), 'HINT');
		check('合并视图计入 views（kind=view）', l1.views.every((v) => v.kind === 'dir' || v.kind === 'view'));
		check('views 里记了 etc/fonts 的归属 src', l1.views.some((v) => v.target === join(root, 'etc', 'fonts') && v.src === join(fontExt, 'etc', 'fonts')));
	}

	// -----------------------------------------------------------------------
	console.log('[6] applyPlaceholders 回填（问题.txt【1】）');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r6');
		const extDir = makeExt(root, 'perl', {
			// 构建期 poolextract.py 已经把 Termux 前缀换成了占位符，
			// 设备端拿到的一定是 @DSH_ROOT@ 形态 —— 测试夹具照这个来。
			'bin/perl': '#!@DSH_ROOT@/bin/sh\nexec @DSH_ROOT@/bin/real-perl "$@"\n',
			'lib/perl5/Config.pm': 'prefix=@DSH_ROOT@\nhome=@DSH_HOME@\ntmp=@DSH_TMP@\n',
			// ★ 真机复核时仅剩的残留（缺陷 AJ）：perl 的 Config_heavy.pl 把
			// sysroot 记成**不带 /usr** 的裸父目录前缀，长规则一条都匹配不到。
			'lib/perl5/Config_heavy.pl': '-Dsysroot=-I@DSH_FILES@ -Darch=@DSH_DATA@\n',
			'lib/libperl.so': 'ELF-BINARY-PLACEHOLDER-@DSH_ROOT@',
		});
		const manifestPath = join(extDir, '.pool-manifest.json');
		writeFileSync(manifestPath, JSON.stringify({
			extId: 'perl',
			placeholders: {
				'@DSH_ROOT@': 'root', '@DSH_HOME@': 'home', '@DSH_TMP@': 'tmp',
				'@DSH_FILES@': 'files', '@DSH_DATA@': 'data',
			},
			files: ['bin/perl', 'lib/perl5/Config.pm', 'lib/perl5/Config_heavy.pl'],
		}));

		const map = placeholderMap(root);
		const result = applyPlaceholders(root, extDir, manifestPath);

		equal('回填了 3 个文件', result.rewritten, 3);
		check('不是跳过态', result.skipped === false);
		equal('未列进清单的 .so 原样不动', readFileSync(join(extDir, 'lib', 'libperl.so'), 'utf8'), 'ELF-BINARY-PLACEHOLDER-@DSH_ROOT@');
		check('清单本身被删掉', !existsSync(manifestPath));

		const perl = readFileSync(join(extDir, 'bin', 'perl'), 'utf8');
		check('shebang 已指向真实根', perl.startsWith('#!'), perl);
		check('@DSH_ROOT@ 已消失', !perl.includes('@DSH_ROOT@'), perl);
		check('com.termux 已消失', !perl.includes('com.termux'), perl);

		const cfg = readFileSync(join(extDir, 'lib', 'perl5', 'Config.pm'), 'utf8');
		check('@DSH_HOME@ 换成 home', cfg.includes(`home=${map['@DSH_HOME@']}`), cfg);
		check('@DSH_TMP@ 换成 tmp', cfg.includes(`tmp=${map['@DSH_TMP@']}`), cfg);

		// 五项映射里，`@DSH_FILES@` 是 root 的父目录、`@DSH_DATA@` 再上一层；
		// 回填后必须是**规范化**路径（不含 `/..`），否则 perl 的 sysroot 会带过去。
		const heavy = readFileSync(join(extDir, 'lib', 'perl5', 'Config_heavy.pl'), 'utf8');
		equal('@DSH_FILES@ 是 root 的父目录', map['@DSH_FILES@'], dirname(root));
		equal('@DSH_DATA@ 再上一层', map['@DSH_DATA@'], dirname(dirname(root)));
		check('@DSH_FILES@ 已回填', heavy.includes(`-Dsysroot=-I${dirname(root)}`), heavy);
		check('回填结果不含 /..', !heavy.includes('..'), heavy);
		check('没有残留占位符', !heavy.includes('@DSH_'), heavy);
	}

	// -----------------------------------------------------------------------
	console.log('[7] 没有清单的老包：静默跳过，不是错误（向后兼容）');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r7');
		const extDir = makeExt(root, 'old', { 'bin/old': '#!/data/data/com.termux/files/usr/bin/sh\n' });

		const result = applyPlaceholders(root, extDir, join(extDir, '.pool-manifest.json'));
		check('跳过态', result.skipped === true);
		equal('没有回填', result.rewritten, 0);
		equal('内容原样保留', readFileSync(join(extDir, 'bin', 'old'), 'utf8'), '#!/data/data/com.termux/files/usr/bin/sh\n');
	}

	// -----------------------------------------------------------------------
	console.log('[8] 卸载按清单回收，且不误删别人的同名资源');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r8');
		const extA = makeExt(root, 'a', { 'bin/a-cmd': 'A', 'etc/fonts/fonts.conf': 'A' });
		const extB = makeExt(root, 'b', { 'bin/b-cmd': 'B', 'etc/fonts/fonts.conf': 'B' });

		const linksA = buildViews(root, 'a', extA);
		writeFileSync(join(extA, '.links.json'), JSON.stringify(linksA));
		const linksB = buildViews(root, 'b', extB);
		writeFileSync(join(extB, '.links.json'), JSON.stringify(linksB));

		// 同名**目录**不能整目录覆盖：`root/etc/fonts` 会先被物化成真目录，
		// 各自贡献的条目以软链形式并存在一起。整目录软链会让后装者的树把
		// 先装者的整个遮掉 —— 实测 15 个顶层目录（etc/fonts、share/xml、
		// share/gettext、share/fontconfig…）正属于这种情形，而它们恰恰是
		// fontconfig 与 tesseract 最需要的。
		checkNotLink('root/etc/fonts 被物化成真目录而非整目录软链', join(root, 'etc', 'fonts'));
		check('两个扩展的贡献并存（同名叶子保留先到的 a）', readFileSync(join(root, 'etc', 'fonts', 'fonts.conf'), 'utf8') === 'A', readFileSync(join(root, 'etc', 'fonts', 'fonts.conf'), 'utf8'));
		check('a 的清单已被改写为逐条链接（物化后原整目录条目失效）', JSON.parse(readFileSync(join(extA, '.links.json'), 'utf8')).views.every((v) => v.target !== join(root, 'etc', 'fonts')));
		check('b 把自己那条记成 shadowed（占位者卸载后据此补位）', linksB.views.some((v) => v.shadowed === true && v.target === join(root, 'etc', 'fonts', 'fonts.conf')));

		const res = removeExtension(root, 'a');
		check('卸载成功', res.ok === true);
		equal('回收了 a 的命令', res.removedBins, 1);
		check('a 的命令链接已消失', !existsSync(join(root, 'bin', 'a-cmd')));
		check('b 的命令不受影响', existsSync(join(root, 'bin', 'b-cmd')));
		equal('回收了 a 的那条资源', res.removedViews, 1);
		equal('腾空的位置由 b 补位', res.reclaimed, 1);
		equal('该资源现在读到 b 的内容', readFileSync(join(root, 'etc', 'fonts', 'fonts.conf'), 'utf8'), 'B');
		check('a 的扩展目录已删除', !existsSync(extA));
	}

	// -----------------------------------------------------------------------
	console.log('[9] 卸载自己的独有资源');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r9');
		const ext = makeExt(root, 'solo', { 'bin/solo': 'S', 'share/solo/data': 'D' });
		writeFileSync(join(ext, '.links.json'), JSON.stringify(buildViews(root, 'solo', ext)));

		const res = removeExtension(root, 'solo');
		equal('回收了 1 个命令', res.removedBins, 1);
		equal('回收了 1 项资源', res.removedViews, 1);
		check('资源链接已消失', !existsSync(join(root, 'share', 'solo')));
	}

	// -----------------------------------------------------------------------
	console.log('[10] relinkAll 重建（runtime 升级整体替换 bin/ lib/ 之后）');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r10');
		const extDir = makeExt(root, 'texlive', {
			'bin/texlive/pdftex': 'PDFTEX',
			'etc/fonts/fonts.conf': '<fontconfig/>',
		});
		writeFileSync(join(extDir, '.links.json'), JSON.stringify(buildViews(root, 'texlive', extDir)));

		// 模拟 runtime 升级：整棵 bin/ 与 lib/ 被换掉
		rmSync(join(root, 'bin'), { recursive: true, force: true });
		rmSync(join(root, 'lib'), { recursive: true, force: true });
		rmSync(join(root, 'etc'), { recursive: true, force: true });
		check('升级后命令确实没了', !existsSync(join(root, 'bin', 'pdftex')));

		writeFileSync(join(root, 'extensions', '.relink'), '1');
		const rebuilt = relinkAll(root);

		equal('重建了 1 个扩展', rebuilt, 1);
		check('展平的 pdftex 恢复了', existsSync(join(root, 'bin', 'pdftex')));
		checkLink('展平的 pdftex 指向正确', join(root, 'bin', 'pdftex'), join(extDir, 'bin', 'texlive', 'pdftex'));
		check('目录软链恢复了', existsSync(join(root, 'bin', 'texlive')));
		check('合并视图恢复了', existsSync(join(root, 'etc', 'fonts', 'fonts.conf')));
		check('标记文件已清除', !existsSync(join(root, 'extensions', '.relink')));
	}

	// -----------------------------------------------------------------------
	console.log('[11] 悬空链接也能被识别、回收与重建');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r11');
		const extDir = makeExt(root, 'dangling', { 'bin/cmd': 'C' });
		writeFileSync(join(extDir, '.links.json'), JSON.stringify(buildViews(root, 'dangling', extDir)));

		// 手工把 root/bin/cmd 换成一条悬空链接（模拟扩展目录被移动过）
		rmSync(join(root, 'bin', 'cmd'));
		symlinkSync(join(root, 'nowhere', 'cmd'), join(root, 'bin', 'cmd'));
		check('existsSync 看不见悬空链接（这正是必须用 lstat 的原因）', !existsSync(join(root, 'bin', 'cmd')));
		check('lstat 能看见悬空链接', lstatSync(join(root, 'bin', 'cmd')).isSymbolicLink());

		rmSync(join(root, 'extensions', '.relink'), { force: true });
		writeFileSync(join(root, 'extensions', '.relink'), '1');
		relinkAll(root);
		equal('悬空链接被替换成正确的目标', readlinkSync(join(root, 'bin', 'cmd')), join(extDir, 'bin', 'cmd'));

		const res = removeExtension(root, 'dangling');
		equal('卸载时回收了悬空命令', res.removedBins, 1);
	}
	// -----------------------------------------------------------------------
	console.log('[12] lib/ 子目录合并（rustlib / guile / pkgconfig 与 runtime 同名）');
	// -----------------------------------------------------------------------
	{
		const root = join(workdir, 'r12');
		// runtime 自带 <root>/lib/pkgconfig（实为预装闭包的一部分），
		// 扩展也各带一份 —— 「目标已存在就跳过」会让扩展的 .pc 全丢。
		mkdirSync(join(root, 'lib', 'pkgconfig'), { recursive: true });
		writeFileSync(join(root, 'lib', 'pkgconfig', 'zlib.pc'), 'ZLIB');

		const rust = makeExt(root, 'rust', {
			'bin/rustc': '#!@DSH_ROOT@/bin/sh\n',
			'lib/libLLVM.so': 'LLVM',
			'lib/rustlib/aarch64-linux-android/lib/libstd.rlib': 'STD',
		});
		const texlive = makeExt(root, 'texlive', {
			'lib/pkgconfig/freetype2.pc': 'FREETYPE',
		});
		const gdb = makeExt(root, 'gdb', {
			'lib/guile/3.0/ice-9/boot-9.scm': 'SCM',
		});

		const lr = buildViews(root, 'rust', rust);
		buildViews(root, 'texlive', texlive);
		buildViews(root, 'gdb', gdb);

		check('rustlib 已接入引擎 lib', existsSync(join(root, 'lib', 'rustlib', 'aarch64-linux-android', 'lib', 'libstd.rlib')));
		check('guile 模块树已接入引擎 lib', existsSync(join(root, 'lib', 'guile', '3.0', 'ice-9', 'boot-9.scm')));
		check('runtime 自带的 pkgconfig 内容仍在（未被整目录遮蔽）', existsSync(join(root, 'lib', 'pkgconfig', 'zlib.pc')));
		check('扩展贡献的 .pc 也进来了（互补而非覆盖）', existsSync(join(root, 'lib', 'pkgconfig', 'freetype2.pc')));
		equal('runtime 那份内容没被改写', readFileSync(join(root, 'lib', 'pkgconfig', 'zlib.pc'), 'utf8'), 'ZLIB');
		check('lib/ 子目录计入 views', lr.views.some((v) => v.name === 'lib/rustlib'));

		// 卸载 rust 只该带走自己那棵，不能连 runtime 的 pkgconfig 一起删。
		writeFileSync(join(rust, '.links.json'), JSON.stringify(lr));
		removeExtension(root, 'rust');
		check('卸载后 rustlib 已回收', !existsSync(join(root, 'lib', 'rustlib')));
		check('卸载后 runtime 的 pkgconfig 仍在', existsSync(join(root, 'lib', 'pkgconfig', 'zlib.pc')));
	}

	// -----------------------------------------------------------------------
	console.log('\n[13] 旧装配布局的识别与迁移（问题.txt【4】【6】）');
	// -----------------------------------------------------------------------
	//
	// 真机事实：代码修好后重装 texlive，`bin/` 从 1218 涨到 1629（+411 个 TeX
	// 引擎）；但另外 19 个扩展是**旧代码装的**，目录不会自动重装 ——
	// `RuntimeInstaller` 的自愈只覆盖 runtime.zip 顶层目录，`extensions/` 是
	// 用户态资产，故意不碰。于是 rust 缺 lib/rustlib、perl 的 Config_heavy.pl
	// 仍写着 Termux 前缀。staleExtensions 就是找出这批扩展。
	{
		const root = join(workdir, 'r13');
		// 包池：只有 old / fresh / nopool 三个包可重装，foreign 不在池里
		mkdirSync(join(root, 'ext-pool'), { recursive: true });
		for (const id of ['old', 'fresh', 'nopool']) {
			writeFileSync(join(root, 'ext-pool', `${id}.pool`), 'POOL');
		}
		makeExt(root, 'old', { 'bin/a': 'A' });
		makeExt(root, 'fresh', { 'bin/b': 'B' });
		makeExt(root, 'nopool', { 'bin/c': 'C' });
		makeExt(root, 'foreign', { 'bin/d': 'D' });

		// 旧代码装的：.links.json 里没有 layout 字段
		writeFileSync(join(root, 'extensions', 'old', '.links.json'),
			JSON.stringify({ extId: 'old', bins: [], libs: [], views: [] }));
		// 当前代码装的
		writeFileSync(join(root, 'extensions', 'fresh', '.links.json'),
			JSON.stringify({
				extId: 'fresh', bins: [], libs: [], views: [],
				layout: LAYOUT_VERSION, poolBytes: poolSignature(root, 'fresh'),
			}));
		// 中间版本装的（layout 落后）
		writeFileSync(join(root, 'extensions', 'nopool', '.links.json'),
			JSON.stringify({ extId: 'nopool', bins: [], libs: [], views: [], layout: LAYOUT_VERSION - 1 }));
		// 用户自己从别处装的：没有 .links.json，也不在包池里
		// （makeExt 本身不写 .links.json，这里刻意不写）

		const stale = staleExtensions(root);
		check('旧代码装的被识别出来', stale.includes('old'), `stale=${JSON.stringify(stale)}`);
		check('layout 落后的被识别出来', stale.includes('nopool'), `stale=${JSON.stringify(stale)}`);
		check('当前布局的不必重装', !stale.includes('fresh'), `stale=${JSON.stringify(stale)}`);
		check('包池里没有的不动（用户态资产）', !stale.includes('foreign'), `stale=${JSON.stringify(stale)}`);

		// buildViews 写出的清单必须带 layout 戳，否则下次启动会永远判「落后」
		const freshLinks = buildViews(root, 'fresh', join(root, 'extensions', 'fresh'));
		equal('buildViews 返回的清单带 layout 戳', freshLinks.layout, LAYOUT_VERSION);
		equal('buildViews 记下了池体积指纹', freshLinks.poolBytes, poolSignature(root, 'fresh'));

		// 池内容变了（缺陷 BA 第二层）：layout 没变，但新 APK 换掉了 pool，
		// 设备上解出来的目录已经和池对不上，必须重装。
		// 真机事故：emacs 的 charsets/*.map 修好后 pool 从 53,391,296 B 长到
		// 54,413,123 B，layout 仍是 3，于是 staleExtensions 判「已最新」。
		writeFileSync(join(root, 'ext-pool', 'grown.pool'), 'POOL');
		makeExt(root, 'grown', { 'bin/e': 'E' });
		writeFileSync(join(root, 'extensions', 'grown', '.links.json'),
			JSON.stringify({
				extId: 'grown', bins: [], libs: [], views: [],
				layout: LAYOUT_VERSION, poolBytes: 3,
			}));
		// 池变小（构建期裁掉东西）同样要重装
		writeFileSync(join(root, 'ext-pool', 'shrunk.pool'), 'POOL');
		makeExt(root, 'shrunk', { 'bin/f': 'F' });
		writeFileSync(join(root, 'extensions', 'shrunk', '.links.json'),
			JSON.stringify({
				extId: 'shrunk', bins: [], libs: [], views: [],
				layout: LAYOUT_VERSION, poolBytes: 4096,
			}));
		const stale2 = staleExtensions(root);
		check('池变大后判为需要重装', stale2.includes('grown'), `stale=${JSON.stringify(stale2)}`);
		check('池变小后判为需要重装', stale2.includes('shrunk'), `stale=${JSON.stringify(stale2)}`);
		check('池体积一致时不动', !stale2.includes('fresh'), `stale=${JSON.stringify(stale2)}`);

		// 空 root / 不存在的 extensions 目录都要安全返回
		equal('root 为空时返回空数组', staleExtensions('').length, 0);
		equal('extensions 目录不存在时返回空数组',
			staleExtensions(join(workdir, 'r13-nonexistent')).length, 0);
	}

	// -----------------------------------------------------------------------
	console.log('[EC] wrapper 按自身目录找兄弟文件（yarn 布局，缺陷 EC）');
	// -----------------------------------------------------------------------
	//
	// 真机症状：`yarn --version` → Cannot find module '…/extensions/yarn/bin/yarn.js'，
	// 而真实入口在 share/yarn/bin/yarn.js。wrapper 用 readlink -f 定位到自己
	// 的真实目录，再找同目录的 yarn.js —— 找不到。这里复刻该布局，断言安装器
	// 会补出那条兄弟链接，且补的是**相对**链接（扩展目录整体搬走也不悬空）。
	{
		const root = join(workdir, 'r-ec');
		const ext = join(root, 'extensions', 'yarn');
		mkdirSync(join(ext, 'bin'), { recursive: true });
		mkdirSync(join(ext, 'share', 'yarn', 'bin'), { recursive: true });
		writeFileSync(join(ext, 'share', 'yarn', 'bin', 'yarn.js'), 'console.log("1.22.22")\n');
		writeFileSync(
			join(ext, 'bin', 'yarn'),
			'#!/bin/sh\nbasedir=$(dirname "$(readlink -f "$0")")\nexec node "$basedir/yarn.js" "$@"\n',
			{ mode: 0o755 },
		);

		const links = buildViews(root, 'yarn', ext);
		const bin = links.bins.find((b) => b.name === 'yarn');
		check('<root>/bin/yarn 已接入', Boolean(bin), `bins=${JSON.stringify(links.bins.map((b) => b.name))}`);

		const sibling = join(ext, 'bin', 'yarn.js');
		check('wrapper 旁边补出了 yarn.js 兄弟链接', existsSync(sibling));
		if (existsSync(sibling)) {
			const target = readlinkSync(sibling);
			check('补出的是相对链接（整包搬走不悬空）', !target.startsWith('/') && !/^[A-Za-z]:/.test(target), target);
			check('链接指向 share/yarn/bin/yarn.js', target.includes('share') && target.endsWith('yarn.js'), target);
		}

		// 反向保护：wrapper 引用的文件在扩展内**找不到**时不能瞎建链接。
		const ext2 = join(root, 'extensions', 'noluck');
		mkdirSync(join(ext2, 'bin'), { recursive: true });
		writeFileSync(
			join(ext2, 'bin', 'noluck'),
			'#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/ghost.js" "$@"\n',
			{ mode: 0o755 },
		);
		buildViews(root, 'noluck', ext2);
		check('扩内找不到同名文件时不建空链接', !existsSync(join(ext2, 'bin', 'ghost.js')));
	}

	// -----------------------------------------------------------------------
	console.log('[EH] 已装扩展的接入自愈（healExtensions，缺陷 EC 的另一半）');
	// -----------------------------------------------------------------------
	//
	// 真机现场：代码里 v0.9.18 就有 wrapper 修复，升到 0.9.20 之后
	// `yarn --version` 仍是 Cannot find module '…/extensions/yarn/bin/yarn.js'。
	// 原因不是修复写错了，而是它只挂在**安装那一刻**——那个扩是一年前装的，
	// 之后再没被安装流程碰过。所以自愈必须能对已存在的目录树跑，且幂等。
	//
	// 这里不调 buildViews（模拟"老设备上已经装好的扩展"），直接摆出两种坏形状：
	//   · 悬空软链：bin/yalc → yalc.js，而 yalc.js 在 share/ 下
	//   · 文本 wrapper：bin/ylnk 用 $basedir/ylnk.js 找兄弟文件
	{
		const root = join(workdir, 'r-eh');
		const ext = join(root, 'extensions', 'yalc');
		mkdirSync(join(ext, 'bin'), { recursive: true });
		mkdirSync(join(ext, 'share', 'yalc', 'bin'), { recursive: true });
		writeFileSync(join(ext, 'share', 'yalc', 'bin', 'yalc.js'), 'console.log("ok")\n');
		// 悬空软链（老安装器把 bin/yalc 指到了同目录的 yalc.js）
		symlinkSync('yalc.js', join(ext, 'bin', 'yalc'));
		// 文本 wrapper，兄弟文件缺失
		writeFileSync(
			join(ext, 'bin', 'ylnk'),
			'#!/bin/sh\nbasedir=$(dirname "$(readlink -f "$0")")\nexec node "$basedir/ylnk.js" "$@"\n',
			{ mode: 0o755 },
		);
		writeFileSync(join(ext, 'share', 'yalc', 'bin', 'ylnk.js'), 'console.log("ok")\n');

		const first = healExtensions(root);
		check('扫到了 bin 里的条目', first.scanned >= 2, `scanned=${first.scanned}`);
		equal('两条坏链都被记进 repaired', first.repaired, 2);

		const yalc = join(ext, 'bin', 'yalc');
		let resolves = false;
		try { resolves = existsSync(join(dirname(yalc), readlinkSync(yalc))); } catch { resolves = false; }
		check('悬空软链已改指真身', resolves && existsSync(join(ext, 'bin', 'yalc')));
		check('wrapper 的兄弟文件已补出', existsSync(join(ext, 'bin', 'ylnk.js')));

		const second = healExtensions(root);
		equal('再跑一遍没有可修的东西（幂等）', second.repaired, 0);
		check('幂等时 scanned 仍照常统计', second.scanned >= 2, `scanned=${second.scanned}`);

		// 空根 / 不存在根不能抛
		equal('root 为空串时返回零', healExtensions('').scanned, 0);
		equal('extensions 不存在时返回零', healExtensions(join(workdir, 'r-eh-none')).repaired, 0);

		// 反向保护：指向**扩展外面**的悬空链不碰。
		// 那是占位符回填 / relinkAll 的地盘（`/data/data/com.termux/...` 这类
		// 回填残留），按文件名在扩展里瞎猜一个同名文件只会把坏的改成错的。
		const outLink = join(ext, 'bin', 'youtside');
		symlinkSync('/data/data/com.termux/files/usr/bin/yalc.js', outLink);
		// Windows 会把绝对目标规范化成带盘符的形式，所以比较"改没改"而不是字面值
		const before = readlinkSync(outLink);
		const third = healExtensions(root);
		equal('指向扩展外的悬空链不计入修复', third.repaired, 0);
		check('也不改动它（原样留着交给占位符回填）', readlinkSync(outLink) === before, `now=${readlinkSync(outLink)}`);
	}
	// -----------------------------------------------------------------------
	console.log('[EI] 已装扩展的 libexec 视图（ensureLibexecView，nvim 那条 not found）');
	// -----------------------------------------------------------------------
	//
	// 真机现场：
	//   $ nvim --version
	//   …/engine/bin/nvim: 13: exec: …/engine/libexec/nvim/nvim: not found
	// 而 `extensions/shells/libexec/nvim/nvim --version` 能出 NVIM v0.12.6 ——
	// 载荷是好的，缺的是 `<root>/libexec/nvim` 这条链接（安装期只摊了
	// etc/share/opt/sbin/var，漏了 libexec）。
	//
	// 为什么不能只靠 buildViews：那要用户把扩展**重装**一遍，rust 250 MB、
	// texlive 1600 个文件，为了几条软链不值得 —— 已装扩展要能就地补。
	{
		const root = join(workdir, 'r-ei');
		const ext = makeExt(root, 'shells', {
			'bin/nvim': '#!/system/bin/sh\nexec "<root>/libexec/nvim/nvim" "$@"\n',
			'libexec/nvim/nvim': 'ELF-NVIM',
			'libexec/nvim/vimdiff': 'ELF-VIMDIFF',
			'share/nvim/runtime/syntax/syntax.vim': '" syntax\n',
		});
		// 模拟「v0.9.23 之前装的」：清单里没有 libexec 条目
		writeFileSync(
			join(ext, '.links.json'),
			JSON.stringify({ extId: 'shells', bins: [], libs: [], views: [], layout: 3 }),
		);

		const first = ensureLibexecView(root);
		equal('补出 1 条（libexec/nvim 整目录）', first.added, 1);
		checkLink(
			'<root>/libexec/nvim 指向扩展里的真身',
			join(root, 'libexec', 'nvim'),
			join(ext, 'libexec', 'nvim'),
		);
		check(
			'wrapper 的 exec 目标现在真的存在',
			existsSync(join(root, 'libexec', 'nvim', 'nvim')),
		);

		const manifest = JSON.parse(readFileSync(join(ext, '.links.json'), 'utf8'));
		const view = (manifest.views ?? []).find((v) => v.target === join(root, 'libexec', 'nvim'));
		check('补出的条目写回了清单（卸载能回收、relink 能重建）', Boolean(view), JSON.stringify(manifest.views));
		equal('清单里的名字带 libexec/ 前缀', view?.name, 'libexec/nvim');

		const second = ensureLibexecView(root);
		equal('再跑一遍不重复添加（幂等）', second.added, 0);
		equal('清单也没被写重复', JSON.parse(readFileSync(join(ext, '.links.json'), 'utf8')).views.length, 1);

		// runtime 升级会把 <root>/libexec 里的视图清掉，靠 relinkAll 按清单重建
		rmSync(join(root, 'libexec', 'nvim'), { recursive: true, force: true });
		writeFileSync(join(root, 'extensions', '.relink'), '');
		const rebuilt = relinkAll(root);
		check('relinkAll 能按清单把它重建回来', rebuilt >= 1, `rebuilt=${rebuilt}`);
		check('<root>/libexec/nvim/nvim 又在了', existsSync(join(root, 'libexec', 'nvim', 'nvim')));

		// 新装扩展走 buildViews 时也应该直接摊出来（不需要等自愈）
		{
			const r2 = join(workdir, 'r-ei-new');
			const ext2 = makeExt(r2, 'shells', {
				'bin/nvim': '#!/system/bin/sh\n',
				'libexec/nvim/nvim': 'ELF',
			});
			const links = buildViews(r2, 'shells', ext2);
			check('buildViews 直接摊出 libexec', existsSync(join(r2, 'libexec', 'nvim', 'nvim')));
			check(
				'并登记进 .links.json 的 views',
				(links.views ?? []).some((v) => v.target === join(r2, 'libexec', 'nvim')),
			);
		}

		// 反向保护 1：没有清单 = 不是我们装的（用户自己放的），不动它
		{
			const r3 = join(workdir, 'r-ei-foreign');
			const ext3 = makeExt(r3, 'mytool', { 'libexec/mytool/mytool': 'X' });
			const res = ensureLibexecView(r3);
			equal('没有 .links.json 的扩展不碰', res.added, 0);
			check('也不会替它建链接', !existsSync(join(r3, 'libexec', 'mytool')));
			check('没写清单', !existsSync(join(ext3, '.links.json')));
		}

		// 反向保护 2：同名 libexec 由先到者占，后来者不覆盖
		{
			const r4 = join(workdir, 'r-ei-dup');
			const a = makeExt(r4, 'aa', { 'libexec/tool/tool': 'A' });
			const b = makeExt(r4, 'bb', { 'libexec/tool/tool': 'B' });
			for (const [id, dir] of [['aa', a], ['bb', b]]) {
				writeFileSync(
					join(dir, '.links.json'),
					JSON.stringify({ extId: id, bins: [], libs: [], views: [], layout: 3 }),
				);
			}
			mkdirSync(join(r4, 'libexec'), { recursive: true });
			const ra = ensureLibexecView(r4);
			check('先到者接上了', existsSync(join(r4, 'libexec', 'tool', 'tool')));
			equal('只有一个扩展真正建了链接', ra.added, 1);
			// readdirSync 的顺序不保证（Windows 上是字母序，别的平台不一定），
			// 所以不假设 aa 先到 —— 只看叶子指向这两个里的哪一个。
			//
			// 注意 `root/libexec/tool` 此时可能是**真目录**：第二个扩展进来时
			// mergeEntry 会把前者的整目录软链「物化」再合并（否则写进去的其实是
			// 前一个扩展的目录）。所以判据落在叶子 `tool/tool` 上。
			const owner = readlinkSync(join(r4, 'libexec', 'tool', 'tool'));
			const cands = [join(a, 'libexec', 'tool', 'tool'), join(b, 'libexec', 'tool', 'tool')];
			check('占位者就是其中一个扩展', cands.includes(owner), `owner=${owner}`);
			const loser = owner === cands[0] ? b : a;
			// 后到者**必须**在清单里留下 shadowed 记录 —— 否则占位者卸载后
			// 它的贡献就永久丢了（与 mergeViews 同一条规则）
			const mfLose = JSON.parse(readFileSync(join(loser, '.links.json'), 'utf8'));
			check('后来者在清单里留下 shadowed 记录', (mfLose.views ?? []).some((v) => v.shadowed), JSON.stringify(mfLose.views));
			const second2 = ensureLibexecView(r4);
			equal('再跑一遍谁都不重复添加', second2.added, 0);
		}
	}
} finally {
	rmSync(workdir, { recursive: true, force: true });
}

console.log(`\n扩展安装器装配测试：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
