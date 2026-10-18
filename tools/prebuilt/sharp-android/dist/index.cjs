"use strict";
/**
 * sharp 的 Android 替身实现（缺陷 BF）。
 *
 * 上游 sharp 依赖 libvips 的原生 .node 预编译产物，`dist/libvips.cjs` 的
 * `prebuiltPlatforms` 里根本没有 android-* 项，Node 在 Android 上
 * `process.platform === "android"` ⇒ 解析成 `android-arm64` ⇒ 必抛
 * `Could not load the "sharp" module using the android-arm64 runtime`。
 * runtime 闭包里也没有 `@img/sharp-*` 任何预编译包，因此只能换实现。
 *
 * 这里用引擎自带的 ImageMagick 7（`<root>/bin/magick`，缺陷 AX 已修好
 * MAGICK_CONFIGURE_PATH）实现 dsh-attachment-local 真正用到的那一小片 API：
 *   sharp(buf, {failOn, limitInputPixels}) → Image
 *   image.metadata() / .clone() / .raw().toBuffer()
 *   image.rotate() / .toColourspace("srgb") / .resize({width,height,fit,withoutEnlargement})
 *   image.jpeg({quality}) / .webp({quality,effort}) → .toBuffer({resolveWithObject})
 *
 * 三条硬约束（全部来自 dsh-attachment-local 的调用方语义）：
 *  1. `metadata()` 必须报告**文件里真实的** width/height（未旋转），并把 EXIF
 *     orientation 原样交出 —— 调用方自己按 `orientation >= 5` 交换长宽。
 *     所以方向解析不能交给 ImageMagick（它解析不出 `%[EXIF:Orientation]`），
 *     必须在这里直接扫字节。
 *  2. 编码产物必须是「单帧 + 8bit + sRGB + 无任何元数据」，否则
 *     `verifyNormalizedImage` 的二次 detectImage 会拒收。
 *  3. `raw().toBuffer()` 要真解码（等价 `magick … rgba:-`），不能只读文件头。
 *
 * metadata 不用 `magick identify`：引擎 policy.xml 有
 * `<policy domain="resource" name="width" value="8KP"/>`，超过 8192px 的图
 * 连 identify 都会 `ImproperImageHeader` 失败 —— 而准入检查恰恰要先看到尺寸
 * 才能按 maxDimension 拒收。因此尺寸/格式/帧数/位深全部自己从字节里读。
 */
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

/** 引擎根：本文件位于 <root>/lib/node_modules/sharp/dist/，上溯四级。 */
const ENGINE_ROOT = (() => {
  const fromEnv = process.env.KXXY_ENGINE_ROOT;
  if (fromEnv) return fromEnv;
  return dirname(dirname(dirname(dirname(__dirname))));
})();

const MAGICK = join(ENGINE_ROOT, "bin", "magick");

/**
 * 按魔数判定容器格式。只认 dsh-attachment-local 声明的四种 mediaType。
 * 认不出返回 undefined ⇒ 调用方抛 INVALID_IMAGE（与上游一致）。
 */
function sniffFormat(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("latin1", 0, 3) === "GIF" && buf.toString("latin1", 3, 6) === "89a") return "gif";
  if (buf.length >= 6 && buf.toString("latin1", 0, 3) === "GIF" && buf.toString("latin1", 3, 6) === "87a") return "gif";
  if (
    buf.length >= 16 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return void 0;
}

/** PNG：IHDR 给出宽高与位深；acTL 块存在 ⇒ 动图。 */
function pngInfo(buf) {
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let animated = false;
  let animatedFrames = 0;
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = pos + 8;
    if (type === "IHDR" && body + 8 <= buf.length) {
      width = buf.readUInt32BE(body);
      height = buf.readUInt32BE(body + 4);
      bitDepth = buf[body + 8];
      colorType = buf[body + 9];
    } else if (type === "acTL" && body + 8 <= buf.length) {
      animated = true;
      animatedFrames = buf.readUInt32BE(body);
    } else if (type === "IDAT") {
      break;
    }
    pos = body + len + 4;
    if (len > buf.length) break;
  }
  // colorType 0/2/4 无 alpha；3（调色板）可能带 tRNS，按有 alpha 处理更保守但会
  // 让纯调色板图走 webp 通道 —— 上游 sharp 对 palette PNG 也报 hasAlpha=false，
  // 除非真有 tRNS。这里用 tRNS 是否存在来判定。
  let hasAlpha = colorType === 4 || colorType === 6;
  if (colorType === 3 && buf.includes(Buffer.from("tRNS", "latin1"))) hasAlpha = true;
  return {
    format: "png",
    width,
    height,
    pages: animated ? Math.max(1, animatedFrames) : 1,
    depth: bitDepth,
    hasAlpha,
    space: colorType === 0 || colorType === 4 ? "b-w" : "srgb",
    orientation: readExifOrientation(buf),
  };
}

/**
 * 取 JPEG 的下一个段。
 *
 * 关键技术点：JPEG 规范（ITU-T T.81 §B.1.1.2）允许**任意多个 `0xFF` 填充
 * 字节**出现在 marker 之前，真实照片里极常见 —— 量化表内容本身是 0xFF 时，
 * DQT 段尾部到下一个 marker 之间会留下一长串 0xFF。若扫描器写成
 * 「`buf[pos]===0xFF` 就把 `buf[pos+1]` 当 marker」，会把 `FF FF` 误读成
 * 一个长度 65535 的段并直接冲出文件，尺寸扫成 0×0。真机素材
 * `_recon/img/orient6.jpg`（188 字节）就在偏移 125 起有 14 个 0xFF 填充。
 *
 * 返回 `{ marker, body, pos }`：`body` 是段数据起点（长度字段之后），
 * `pos` 是下一个段的扫描起点；格式非法返回 undefined。
 */
function nextJpegSegment(buf, pos) {
  if (pos + 1 >= buf.length) return void 0;
  if (buf[pos] !== 0xff) return void 0;
  let p = pos + 1;
  while (p < buf.length && buf[p] === 0xff) p += 1;
  if (p >= buf.length) return void 0;
  const marker = buf[p];
  if (marker === 0x00) {
    // FF 00 是熵编码数据里的转义，不是 marker。
    return { marker: 0x00, body: p + 1, pos: p + 1 };
  }
  if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
    // 无长度字段的独立 marker。
    return { marker, body: p + 1, pos: p + 1 };
  }
  if (p + 3 > buf.length) return void 0;
  const length = buf.readUInt16BE(p + 1);
  if (length < 2) return void 0;
  return { marker, body: p + 3, pos: p + 1 + length };
}

/** JPEG：扫段。SOF0..SOF15（除 DHT/JPG/DAC）给宽高与分量数；APP1 里的 Exif 给方向。 */
function jpegInfo(buf) {
  let width = 0;
  let height = 0;
  let components = 3;
  let precision = 8;
  let pos = 2;
  while (pos + 2 <= buf.length) {
    // SOS 之后是熵编码数据，不再有元数据段。
    if (buf[pos] === 0xff && buf[pos + 1] === 0xda) break;
    const seg = nextJpegSegment(buf, pos);
    if (seg === void 0) break;
    const { marker, body } = seg;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && body + 6 <= buf.length) {
      precision = buf[body];
      height = buf.readUInt16BE(body + 1);
      width = buf.readUInt16BE(body + 3);
      components = buf[body + 5];
      break;
    }
    pos = seg.pos;
  }
  return {
    format: "jpeg",
    width,
    height,
    pages: 1,
    depth: precision,
    hasAlpha: false,
    space: components === 4 ? "cmyk" : components === 1 ? "b-w" : "srgb",
    orientation: readExifOrientation(buf),
  };
}

/** GIF：逻辑屏幕描述符给宽高；两个以上图像描述符（0x2C）⇒ 动图。 */
function gifInfo(buf) {
  const width = buf.length >= 8 ? buf.readUInt16LE(6) : 0;
  const height = buf.length >= 8 ? buf.readUInt16LE(8) : 0;
  let frames = 0;
  let pos = 13;
  if (buf.length > 10) {
    const flags = buf[10];
    if (flags & 0x80) pos += 3 * (1 << ((flags & 0x07) + 1));
  }
  while (pos < buf.length) {
    const block = buf[pos];
    if (block === 0x2c) {
      frames += 1;
      if (pos + 10 > buf.length) break;
      const lflags = buf[pos + 9];
      pos += 10;
      if (lflags & 0x80) pos += 3 * (1 << ((lflags & 0x07) + 1));
      pos += 1; // LZW minimum code size
      while (pos < buf.length) {
        const size = buf[pos];
        pos += 1 + size;
        if (size === 0) break;
      }
    } else if (block === 0x21) {
      pos += 2;
      while (pos < buf.length) {
        const size = buf[pos];
        pos += 1 + size;
        if (size === 0) break;
      }
    } else if (block === 0x3b) {
      break;
    } else {
      pos += 1;
    }
  }
  return {
    format: "gif",
    width,
    height,
    pages: Math.max(1, frames),
    depth: 8,
    hasAlpha: true,
    space: "srgb",
    orientation: void 0,
  };
}

/** WebP：VP8X 里的画布尺寸；ANIM 块 ⇒ 动图；ALPH 块或 VP8X 的 alpha 位 ⇒ 有 alpha。 */
function webpInfo(buf) {
  let pos = 12;
  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let animated = false;
  let frames = 0;
  while (pos + 8 <= buf.length) {
    const fourcc = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (fourcc === "VP8X" && body + 10 <= buf.length) {
      const flags = buf[body];
      hasAlpha = (flags & 0x10) !== 0;
      animated = (flags & 0x02) !== 0;
      width = 1 + (buf[body + 4] | (buf[body + 5] << 8) | (buf[body + 6] << 16));
      height = 1 + (buf[body + 7] | (buf[body + 8] << 8) | (buf[body + 9] << 16));
    } else if (fourcc === "VP8 " && body + 10 <= buf.length) {
      // 无 VP8X 的简单有损 WebP：3 字节帧标签后是同步码 9d 01 2a，然后 14 位宽高。
      if (!width) {
        width = buf.readUInt16LE(body + 6) & 0x3fff;
        height = buf.readUInt16LE(body + 8) & 0x3fff;
      }
    } else if (fourcc === "VP8L" && body + 5 <= buf.length) {
      // 无损头：14 位 width-1、14 位 height-1、1 位 alpha_is_used、3 位 version。
      const bits = buf.readUInt32LE(body + 1);
      if (!width) {
        width = 1 + (bits & 0x3fff);
        height = 1 + ((bits >> 14) & 0x3fff);
      }
      if (((bits >> 28) & 0x1) === 1) hasAlpha = true;
    } else if (fourcc === "ALPH") {
      hasAlpha = true;
    } else if (fourcc === "ANIM") {
      animated = true;
    } else if (fourcc === "ANMF") {
      frames += 1;
    }
    pos = body + size + (size % 2);
  }
  return {
    format: "webp",
    width,
    height,
    pages: animated ? Math.max(1, frames) : 1,
    depth: 8,
    hasAlpha,
    space: "srgb",
    orientation: readExifOrientation(buf),
  };
}

/**
 * 从字节里读 EXIF orientation。
 *
 * 支持 JPEG（APP1 `Exif\0\0` + TIFF 头）与 PNG（eXIf 块）与 WebP（EXIF chunk）。
 * 读不到返回 undefined —— 这很关键：`imageMetadata` 用
 * `orientation !== void 0 && orientation >= 5` 决定是否交换长宽，而
 * `carriesRetainedMetadata` 用 `orientation !== void 0` 判「带元数据」。
 * 若这里对无 EXIF 的图返回 0/1，会把干净图误判成「带元数据」而强制重编码。
 */
function readExifOrientation(buf) {
  const tiffStarts = [];
  const fmt = sniffFormat(buf);
  if (fmt === "jpeg") {
    let pos = 2;
    while (pos + 2 <= buf.length) {
      if (buf[pos] === 0xff && buf[pos + 1] === 0xda) break; // SOS 之后没有元数据段
      const seg = nextJpegSegment(buf, pos);
      if (seg === void 0) break;
      if (seg.marker === 0xe1 && buf.length >= seg.body + 6 && buf.toString("latin1", seg.body, seg.body + 4) === "Exif") {
        tiffStarts.push(seg.body + 6);
      }
      pos = seg.pos;
    }
  } else if (fmt === "png") {
    let pos = 8;
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString("latin1", pos + 4, pos + 8);
      if (type === "eXIf") tiffStarts.push(pos + 8);
      if (type === "IDAT") break;
      pos = pos + 8 + len + 4;
      if (len > buf.length) break;
    }
  } else if (fmt === "webp") {
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const fourcc = buf.toString("latin1", pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (fourcc === "EXIF") tiffStarts.push(pos + 8);
      pos = pos + 8 + size + (size % 2);
    }
  }
  for (const start of tiffStarts) {
    const value = orientationFromTiff(buf, start);
    if (value !== void 0) return value;
  }
  return void 0;
}

/** 在 TIFF 头（IFD0）里找 tag 0x0112。 */
function orientationFromTiff(buf, start) {
  if (start + 8 > buf.length) return void 0;
  const order = buf.toString("latin1", start, start + 2);
  const le = order === "II";
  if (!le && order !== "MM") return void 0;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(start + 2) !== 0x002a) return void 0;
  const ifd = start + u32(start + 4);
  if (ifd + 2 > buf.length) return void 0;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > buf.length) return void 0;
    if (u16(entry) !== 0x0112) continue;
    const type = u16(entry + 2);
    const n = u32(entry + 4);
    if (n < 1) return void 0;
    if (type === 3) return u16(entry + 8);
    if (type === 4) return u32(entry + 8);
    return void 0;
  }
  return void 0;
}

/**
 * 是否有任何会让 `carriesRetainedMetadata` 为真、而 `-strip` 之后会消失的东西。
 * 判定与上游 `carriesRetainedMetadata(metadata)` 等价，只是我们只对
 * 「已知会被 strip 掉」的容器段检查 —— 只要存在就触发重编码，代价可控。
 */
function carriesMetadata(buf, info) {
  if (info.orientation !== void 0) return true;
  const fmt = info.format;
  if (fmt === "jpeg") {
    let pos = 2;
    while (pos + 2 <= buf.length) {
      if (buf[pos] === 0xff && buf[pos + 1] === 0xda) break; // SOS 之后没有元数据段
      const seg = nextJpegSegment(buf, pos);
      if (seg === void 0) break;
      // APP1(EXIF/XMP)/APP2(ICC)/APP13(IPTC/Photoshop)/APP14(Adobe) 都会被 -strip 带走。
      // APP0(JFIF) 本身无内容语义，不计入。
      if (seg.marker === 0xe1 || seg.marker === 0xe2 || seg.marker === 0xed || seg.marker === 0xee) {
        return true;
      }
      pos = seg.pos;
    }
    return false;
  }
  if (fmt === "png") {
    let pos = 8;
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString("latin1", pos + 4, pos + 8);
      if (type === "iCCP" || type === "tEXt" || type === "iTXt" || type === "zTXt" || type === "eXIf") return true;
      if (type === "IDAT") break;
      pos = pos + 8 + len + 4;
      if (len > buf.length) break;
    }
    return false;
  }
  if (fmt === "webp") {
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const fourcc = buf.toString("latin1", pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (fourcc === "EXIF" || fourcc === "ICCP" || fourcc === "XMP ") return true;
      pos = pos + 8 + size + (size % 2);
    }
    return false;
  }
  return false;
}

/** 把 sharp 的 resize 参数翻译成 `-resize` 的几何串。 */function resizeGeometry(opts) {
  if (!opts || typeof opts !== "object") return void 0;
  const { width, height, fit, withoutEnlargement } = opts;
  if (width === void 0 && height === void 0) return void 0;
  let spec;
  if (width !== void 0 && height !== void 0) spec = `${width}x${height}`;
  else if (width !== void 0) spec = `${width}x`;
  else spec = `x${height}`;
  if (fit === "inside" || (width !== void 0 && height !== void 0) || withoutEnlargement) spec += ">";
  return spec;
}

/** 执行 magick，收集 stdout/stderr。stdin 用给定 Buffer。 */
function runMagick(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(MAGICK, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.stdin.on("error", () => {}); // 子进程提前退出时避免 EPIPE 崩栈
    child.stdin.end(input);
  });
}

/** 编码链里永远加的选项：单帧、sRGB、8bit、剥元数据。 */
function commonEncodeArgs(fromSpec, toSpec) {
  return [
    fromSpec,
    "-auto-orient",
    "-colorspace",
    "sRGB",
    "-strip",
    "-depth",
    "8",
  ];
}

function encodeArgs(toSpec, quality) {
  if (quality !== void 0) return ["-quality", String(quality)];
  return [];
}

/** 把一个 sharp 风格的 format 名翻成 magick 的容器前缀。 */
function formatSpec(format, buf) {
  return `${format}:-`;
}

class Image {
  constructor(data, options) {
    this._src = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this._ops = [];
    this._options = options || {};
    this._info = void 0;
    const fmt = sniffFormat(this._src);
    if (fmt === void 0) {
      throw new Error("Input buffer is not a supported image format (png/jpeg/webp/gif)");
    }
    this._format = fmt;
  }

  _clone() {
    const copy = Object.create(Image.prototype);
    copy._src = this._src;
    copy._ops = this._ops.slice();
    copy._options = this._options;
    copy._info = this._info;
    copy._format = this._format;
    return copy;
  }

  clone() {
    return this._clone();
  }

  rotate() {
    const next = this._clone();
    next._ops.push({ kind: "rotate" });
    return next;
  }

  toColourspace(space) {
    const next = this._clone();
    next._ops.push({ kind: "colourspace", space });
    return next;
  }

  resize(opts) {
    const next = this._clone();
    const geometry = resizeGeometry(opts);
    if (geometry !== void 0) next._ops.push({ kind: "resize", geometry });
    return next;
  }

  raw() {
    const next = this._clone();
    next._ops.push({ kind: "raw" });
    return next;
  }

  jpeg(opts) {
    const next = this._clone();
    next._ops.push({ kind: "encode", format: "jpeg", quality: (opts && opts.quality) ?? 80 });
    return next;
  }

  webp(opts) {
    const next = this._clone();
    next._ops.push({ kind: "encode", format: "webp", quality: (opts && opts.quality) ?? 80 });
    return next;
  }

  png(opts) {
    const next = this._clone();
    next._ops.push({ kind: "encode", format: "png", quality: void 0 });
    return next;
  }

  _parsed() {
    if (this._info !== void 0) return this._info;
    const fmt = this._format;
    const info =
      fmt === "png"
        ? pngInfo(this._src)
        : fmt === "jpeg"
          ? jpegInfo(this._src)
          : fmt === "gif"
            ? gifInfo(this._src)
            : webpInfo(this._src);
    info.carriesMetadata = carriesMetadata(this._src, info);
    this._info = info;
    return info;
  }

  async metadata() {
    const info = this._parsed();
    const metadata = {
      format: info.format,
      width: info.width,
      height: info.height,
      space: info.space,
      channels: info.hasAlpha ? 4 : 3,
      depth: info.depth === 16 ? "ushort" : "uchar",
      hasAlpha: info.hasAlpha,
      orientation: info.orientation,
      pages: info.pages,
    };
    // 只在确实存在时给字段，保持与上游一致的「undefined 即没有」语义。
    if (info.pages > 1) metadata.pageHeight = info.height;
    return metadata;
  }

  /**
   * 真正的解码校验。上游 `detectImage` 用它确认「这批字节能完整解码」，
   * 所以必须让 magick 走一遍全量解码 —— `rgba:-` 恒为 w*h*4 字节。
   */
  async _decodeCheck() {
    const { code, stderr } = await runMagick(
      [`${this._format}:-`, "-depth", "8", "rgba:-"],
      this._src,
    );
    if (code !== 0) {
      throw new Error(`image decode failed: ${stderr.trim() || `magick exited ${code}`}`);
    }
  }

  async _encode(resolveWithObject) {
    const encodeOp = [...this._ops].reverse().find((op) => op.kind === "encode");
    if (encodeOp === void 0) throw new Error("no output format was set; call .jpeg()/.webp()/.png() first");
    const targetFormat = encodeOp.format;
    const args = [formatSpec(this._format), "-auto-orient", "-colorspace", "sRGB"];
    let resized = false;
    for (const op of this._ops) {
      if (op.kind === "resize") {
        args.push("-resize", op.geometry);
        resized = true;
      } else if (op.kind === "colourspace") {
        args.push("-colorspace", op.space === "srgb" ? "sRGB" : op.space);
      } else if (op.kind === "rotate") {
        args.push("-auto-orient");
      }
    }
    // alpha 与目标格式：webp 保 alpha，jpeg 必须去 alpha 否则 magick 直接失败。
    args.push("-type", targetFormat === "webp" ? "TrueColorAlpha" : "TrueColor");
    args.push("-strip", "-depth", "8");
    if (encodeOp.quality !== void 0) args.push("-quality", String(encodeOp.quality));
    // 单帧：动图输入取第一帧，否则多帧编码到 jpeg 会输出 0 字节。
    const inputSpec = `${this._format}:-[0]`;
    args[0] = inputSpec;
    args.push(`${targetFormat}:-`);

    const { code, stdout, stderr } = await runMagick(args, this._src);
    if (code !== 0 || stdout.length === 0) {
      throw new Error(`image encode failed: ${stderr.trim() || `magick exited ${code}`}`);
    }
    if (!resolveWithObject) return stdout;
    // 尺寸必须与产出字节严格一致：重新解析这份字节，而不是相信算出来的值。
    const info =
      targetFormat === "jpeg" ? jpegInfo(stdout) : targetFormat === "webp" ? webpInfo(stdout) : pngInfo(stdout);
    if (info.width === 0 || info.height === 0) {
      throw new Error("image encode produced unreadable output");
    }
    return {
      data: stdout,
      info: {
        format: targetFormat,
        width: info.width,
        height: info.height,
        size: stdout.length,
        channels: info.hasAlpha ? 4 : 3,
        depth: "uchar",
        space: "srgb",
        hasAlpha: info.hasAlpha,
      },
    };
  }

  async toBuffer(opts) {
    const resolveWithObject = Boolean(opts && opts.resolveWithObject);
    const hasEncode = this._ops.some((op) => op.kind === "encode");
    if (!hasEncode) {
      // raw() 路径：全量解码校验后返回原始像素（w*h*4 的 RGBA）。
      const raw = this._ops.some((op) => op.kind === "raw");
      if (raw) {
        const { code, stdout, stderr } = await runMagick(
          [`${this._format}:-[0]`, "-depth", "8", "rgba:-"],
          this._src,
        );
        if (code !== 0) throw new Error(`image decode failed: ${stderr.trim() || `magick exited ${code}`}`);
        const info = this._parsed();
        if (!resolveWithObject) return stdout;
        return {
          data: stdout,
          info: {
            format: "raw",
            width: info.width,
            height: info.height,
            channels: 4,
            depth: "uchar",
            space: "srgb",
            hasAlpha: info.hasAlpha,
          },
        };
      }
      throw new Error("no output format was set; call .jpeg()/.webp()/.png()/.raw() first");
    }
    return this._encode(resolveWithObject);
  }
}

/** sharp 的入口：与上游签名一致，返回可链式的 Image。 */
function sharp(input, options) {
  if (!Buffer.isBuffer(input) && !ArrayBuffer.isView(input)) {
    throw new Error("sharp substitute requires a Buffer input on Android");
  }
  return new Image(input, options);
}

sharp.cache = () => {};
sharp.concurrency = () => 1;
sharp.simd = () => false;
sharp.versions = { vips: "substitute-imagemagick", sharp: "0.35.5-android-substitute" };
sharp.format = { jpeg: {}, png: {}, webp: {}, gif: {} };
sharp.default = sharp;

module.exports = sharp;
module.exports.default = sharp;
