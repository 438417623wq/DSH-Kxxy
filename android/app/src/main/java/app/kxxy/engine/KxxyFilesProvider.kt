package app.kxxy.engine

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.util.Log
import java.io.File
import java.io.FileNotFoundException

/**
 * 只读的文件 ContentProvider（缺陷 BE 的一部分）。
 *
 * ## 为什么需要它
 *
 * `termux-share <file>` 要把一个**文件**交给别的应用（微信、相册、编辑器…）。
 * 从 Android 7（targetSdk >= 24）起，把 `file://` URI 放进 Intent 会直接抛
 * `FileUriExposedException` 并崩掉整个应用 —— 因为接收方拿 file:// 就等于拿到
 * 了本应用私有目录的任意读权限。唯一合规路径是 `content://` + 临时 URI 授权。
 *
 * 本工程的 `targetSdk = 28`（刻意锁定，见 `build.gradle.kts` 里的说明），
 * 同样在限制范围内；而工程没有引入 androidx，用不了 `androidx.core.content.
 * FileProvider`。所以这里实现一个等价的最小版本：只读、只允许引擎根目录内
 * 的文件、URI 由本应用签发并随 Intent 授出临时读权限。
 *
 * ## URI 形式
 *
 * ```
 * content://app.kxxy.files/engine/<相对 engineRoot 的路径>
 * ```
 *
 * 只接受 `engine/` 前缀 —— 不接受绝对路径，避免把 `/data/data/app.kxxy/`
 * 下的其他内容（比如 `tapi/` 通道、`kxxy-home/` 里的凭据）暴露出去。
 *
 * ## 安全
 *
 * - `exported="false"`：其他应用**不能**主动查询本 provider；
 * - `grantUriPermissions="true"`：只能通过我们签发的 Intent 拿到**单个 URI**
 *   的临时读权限（`FLAG_GRANT_READ_URI_PERMISSION`），权限随接收方任务结束
 *   而失效；
 * - 路径做规范化 + 前缀校验，挡住 `../` 穿越。
 */
class KxxyFilesProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    private fun engineRoot(): File = EngineConfig.engineRoot(requireNotNull(context))

    /**
     * 把 URI 还原成受控的 File，越界返回 null。
     *
     * 必须先 `canonicalPath` 再比前缀：`engine/../../shared_prefs/x.xml` 这种
     * 未经规范化的路径字面上是以 `engine/` 开头的。
     */
    private fun resolve(uri: Uri): File? {
        val segs = uri.pathSegments
        if (segs.size < 2 || segs[0] != "engine") return null
        val root = engineRoot().canonicalFile
        val rel = segs.drop(1).joinToString(File.separator)
        val f = File(root, rel).canonicalFile
        return if (f.path == root.path || f.path.startsWith(root.path + File.separator)) f else null
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        // 只读：写模式一律拒绝。分享场景不需要写，放开只会扩大攻击面。
        if (mode != "r") throw FileNotFoundException("只支持只读访问：$mode")
        val f = resolve(uri) ?: throw FileNotFoundException("URI 越界或格式错误：$uri")
        if (!f.isFile) throw FileNotFoundException("不是文件：$f")
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri): String {
        val f = resolve(uri) ?: return "application/octet-stream"
        val name = f.name
        val ext = name.substringAfterLast('.', "").lowercase()
        return MIME[ext] ?: "application/octet-stream"
    }

    /**
     * 供接收方读取文件名与大小。
     *
     * 不实现这个的话，微信/相册这类应用拿到的文件名会是 URI 的最后一段
     * （往往是数字或哈希），用户看到的就是「未知文件」。
     */
    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? {
        val f = resolve(uri) ?: return null
        if (!f.isFile) return null
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val row = arrayOfNulls<Any>(cols.size)
        for (i in cols.indices) {
            row[i] = when (cols[i]) {
                OpenableColumns.DISPLAY_NAME -> f.name
                OpenableColumns.SIZE -> f.length()
                else -> null
            }
        }
        return MatrixCursor(cols, 1).apply { addRow(row) }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0

    companion object {
        private const val TAG = "KxxyFiles"

        /** 与 `AndroidManifest.xml` 里 `<provider android:authorities>` 必须一致。 */
        const val AUTHORITY = "app.kxxy.files"

        /**
         * 构造一个指向 `<engineRoot>/<rel>` 的 URI；越界或文件不存在返回 null。
         *
         * 调用方（[TermuxApiServer.share]）负责把它放进 Intent 并加
         * `FLAG_GRANT_READ_URI_PERMISSION`。
         */
        fun uriFor(rel: String): Uri? {
            val clean = rel.trimStart('/', '\\')
            if (clean.isEmpty()) return null
            return Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                // 逐段编码：文件名里可能有空格、括号、中文，整串 encode 会把
                // 分隔符也编掉。
                .apply { clean.split(File.separatorChar, '/').forEach { appendPath(it) } }
                .build()
        }

        /**
         * 常用扩展名 → MIME。
         *
         * 只覆盖「分享到别的应用时会因为 MIME 不对而拒绝接收」的高频类型；
         * 其余一律 `application/octet-stream`，接收方至少能当二进制收下。
         * 不查 `MimeTypeMap`：它在部分 ROM 上对 `md`/`log`/`toml` 返回 null，
         * 而且不认无扩展名的常见文本文件。
         */
        private val MIME = mapOf(
            "txt" to "text/plain", "log" to "text/plain", "md" to "text/markdown",
            "json" to "application/json", "xml" to "text/xml", "csv" to "text/csv",
            "html" to "text/html", "htm" to "text/html", "css" to "text/css",
            "js" to "application/javascript", "ts" to "text/plain",
            "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
            "gif" to "image/gif", "webp" to "image/webp", "bmp" to "image/bmp",
            "svg" to "image/svg+xml", "heic" to "image/heic",
            "pdf" to "application/pdf",
            "zip" to "application/zip", "gz" to "application/gzip",
            "tar" to "application/x-tar", "xz" to "application/x-xz",
            "7z" to "application/x-7z-compressed",
            "mp3" to "audio/mpeg", "wav" to "audio/wav", "ogg" to "audio/ogg",
            "m4a" to "audio/mp4", "flac" to "audio/flac", "aac" to "audio/aac",
            "mp4" to "video/mp4", "mkv" to "video/x-matroska", "webm" to "video/webm",
            "mov" to "video/quicktime", "avi" to "video/x-msvideo",
            "sh" to "text/x-shellscript", "py" to "text/x-python",
        )
    }
}
