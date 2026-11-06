package app.kxxy.remote

import androidx.camera.core.ImageProxy
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * 二维码解码 —— 纯函数，没有 Android UI 依赖，方便单独推理与替换。
 *
 * ## 为什么用 zxing 而不是 ML Kit
 *
 * ML Kit 的扫码要拉 `play-services-mlkit-barcode-scanning`（bundled 版还要
 * 再塞 3~5 MB 模型，且版本跟着 Google 走）。我们只解**自己生成的**一种码：
 * 纠错级别 M、屏幕直出、内容是一串 URL。这种条件下 zxing 的
 * `QRCodeReader` 早就是够用的，而它只有纯 JVM 代码、不加 native、不依赖
 * GMS —— 对本项目（离线、sideload、包体已经很大）更合适。
 *
 * ## 只取 Y 平面
 *
 * `ImageProxy` 默认输出 YUV_420_888，亮度信息全在 plane[0]（Y）里。二维码
 * 是黑白图，只靠亮度就能判位，不需要做 YUV→RGB 的逐像素转换 —— 那是解码
 * 路径上最贵的一步，省掉它意味着同一颗 CPU 上能多试几帧。
 *
 * 真正需要小心的是 **rowStride 可能大于宽度**（相机硬件按 16/32 字节对齐
 * 时会发生）。把带 padding 的行直接按紧凑布局交给 zxing，图像会沿对角线
 * 越错越歪，症状是「能看见码但永远解不出来」—— 所以这里显式按行搬运。
 */
object QrDecoder {

    private val hints: Map<DecodeHintType, Any> = mapOf(
        // 只认二维码。不写这条时 MultiFormatReader 会顺带试一维码，白费 CPU。
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        // 中文电脑名（label）要能原样取回来。
        DecodeHintType.CHARACTER_SET to "UTF-8",
    )

    /** 解码成功返回文本；不是码 / 解不出返回 null（不抛异常）。 */
    fun decode(image: ImageProxy): String? {
        val width = image.width
        val height = image.height
        if (width <= 0 || height <= 0) return null

        val luminance = packedLuminance(image, width, height) ?: return null
        val source = PlanarYUVLuminanceSource(luminance, width, height, 0, 0, width, height, false)
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        return try {
            QRCodeReader().decode(bitmap, hints)?.text
        } catch (_: NotFoundException) {
            // 绝大多数帧都会走到这里（没对准/正在对焦）—— 这是正常路径，不是错误。
            null
        } catch (_: Exception) {
            null
        }
    }

    /**
     * 把 Y 平面搬成紧凑的 `width × height` 字节数组。
     *
     * `rowStride == width` 时是一次 `get`（常见情况，零拷贝开销最小）；
     * 否则逐行搬运，丢掉每行末尾的 padding。
     */
    private fun packedLuminance(image: ImageProxy, width: Int, height: Int): ByteArray? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        val rowStride = plane.rowStride
        val size = width * height
        val out = ByteArray(size)

        if (rowStride == width) {
            val n = minOf(size, buffer.remaining())
            if (n <= 0) return null
            buffer.get(out, 0, n)
            return out
        }

        val row = ByteArray(rowStride)
        var written = 0
        for (y in 0 until height) {
            val remain = buffer.remaining()
            if (remain < width) break
            val toRead = minOf(rowStride, remain)
            buffer.get(row, 0, toRead)
            if (toRead < width) break
            System.arraycopy(row, 0, out, written, width)
            written += width
        }
        return if (written == size) out else null
    }
}
