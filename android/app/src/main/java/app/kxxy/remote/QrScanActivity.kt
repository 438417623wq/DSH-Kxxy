package app.kxxy.remote

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.camera.core.ImageAnalysis
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 扫码页 —— 手机端「连电脑」的第一入口。
 *
 * ## 为什么必须自己解，不能让系统相机代劳
 *
 * 连接串是 `http://192.168.1.23:8080/__kxxy_pair?code=…`。用系统相机扫，
 * 系统会把它当**网址**甩给浏览器：配对页确实能打开、cookie 也确实下发了，
 * 但那份会话在浏览器里，本应用拿不到 —— 用户看到「能打开」却仍然连不上，
 * 这是最难解释的一类失败。
 *
 * ## 只做一件事
 *
 * 解码 → 用 [RemoteLink.parse] 做一次轻校验 → 把文本交回 MainActivity。
 * 保存、去重、进入远程全部在那边复用现有通道，这里不碰设备簿 ——
 * 扫描器和连接逻辑耦合起来，以后换扫码库就会连带改到连接路径。
 *
 * ## 扫错码不退出
 *
 * 用户会拿它扫快递单、付款码、WiFi 码。解出来不是连接串时，只把取景框
 * 下面那行字换掉、并静默 1.5 秒（否则同一帧会被反复提示，像坏了）。
 */
class QrScanActivity : Activity(), LifecycleOwner {

    private val lifecycleRegistry = LifecycleRegistry(this)
    override fun getLifecycle(): Lifecycle = lifecycleRegistry

    private lateinit var previewView: PreviewView
    private lateinit var hintView: TextView
    private lateinit var torchView: TextView
    private lateinit var deniedView: LinearLayout

    private var controller: LifecycleCameraController? = null
    private var cameraStarted = false
    private var torchOn = false

    /** 解码跑在独立线程：相机回调线程上做 zxing 会拖慢预览（画面发涩）。 */
    private val decoderExecutor: ExecutorService by lazy { Executors.newSingleThreadExecutor() }

    /** 同一时刻只解一帧。相机一秒能给 30 帧，全解只会烧 CPU 且更容易糊。 */
    private val decoding = AtomicBoolean(false)

    /** 已经交回结果，后续帧一律忽略。 */
    private val delivered = AtomicBoolean(false)

    /** 失败提示的静默窗口（毫秒时间戳）。 */
    @Volatile
    private var quietUntil = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lifecycleRegistry.currentState = Lifecycle.State.CREATED

        // 相机页固定深色：取景画面本身是黑的，跟随浅色主题会让四周发白发灰，
        // 反而看不清对焦框。这里不走 values-night。
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK

        setContentView(buildLayout())

        if (hasCameraPermission()) {
            startCameraWhenReady()
        } else {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    // ──────────────────────────────────────────────────────────────
    // 布局（全程序化，与项目其余部分一致：没有 XML 布局资源）
    // ──────────────────────────────────────────────────────────────

    private fun buildLayout(): View {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        previewView = PreviewView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        root.addView(previewView)

        // 对焦框：只是一个描边方块。刻意不做四角括号 —— 那需要自定义 onDraw，
        // 而这里它唯一的作用是「告诉用户把码放进这个区域」。
        val frame = View(this).apply {
            background = GradientDrawable().apply {
                setColor(Color.TRANSPARENT)
                setStroke(dp(2), 0xCCFFFFFF.toInt())
                cornerRadius = dp(18).toFloat()
            }
            isClickable = false
            layoutParams = FrameLayout.LayoutParams(dp(240), dp(240), Gravity.CENTER)
        }
        root.addView(frame)

        // 关闭：右上角。没有它，用户唯一的出路是系统返回键 —— 而全面屏手势
        // 下很多人不知道返回手势从哪边划。
        root.addView(
            TextView(this).apply {
                text = "关闭"
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                setPadding(dp(16), dp(12), dp(16), dp(12))
                isClickable = true
                setOnClickListener { finishCanceled() }
            },
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.END,
            ).apply { topMargin = dp(8); marginEnd = dp(8) },
        )

        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(0x99000000.toInt())
            setPadding(dp(20), dp(16), dp(20), dp(24))
        }

        bottom.addView(
            TextView(this).apply {
                text = "扫电脑上的二维码"
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                gravity = Gravity.CENTER
            },
        )

        hintView = TextView(this).apply {
            text = "电脑上打开远程接入面板，二维码就在顶部；扫到就自动连上"
            setTextColor(0xCCFFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, 0)
        }
        bottom.addView(hintView)

        torchView = TextView(this).apply {
            text = "打开手电筒"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(dp(14), dp(9), dp(14), dp(9))
            background = GradientDrawable().apply {
                setColor(0x33FFFFFF)
                setStroke(dp(1), 0x66FFFFFF)
                cornerRadius = dp(18).toFloat()
            }
            isClickable = true
            setOnClickListener { toggleTorch() }
        }
        bottom.addView(
            torchView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(14) },
        )

        root.addView(
            bottom,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            ),
        )

        deniedView = buildDeniedView()
        root.addView(deniedView)
        return root
    }

    /**
     * 相机权限被拒后的页面。
     *
     * 两个出口缺一不可：`去设置` 是唯一能真正恢复扫码的路径，而
     * `改用粘贴` 保证用户此刻就能连上电脑 —— 不该因为不给相机权限就
     * 卡死在原地（他的目的从来不是拍照）。
     */
    private fun buildDeniedView(): LinearLayout {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            setPadding(dp(28), dp(28), dp(28), dp(28))
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        box.addView(
            TextView(this).apply {
                text = "需要相机权限才能扫码"
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                gravity = Gravity.CENTER
            },
        )
        box.addView(
            TextView(this).apply {
                text = "不想开也行：回上一页，把连接串粘进输入框，效果一样"
                setTextColor(0xCCFFFFFF.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
                gravity = Gravity.CENTER
                setPadding(0, dp(10), 0, dp(22))
            },
        )
        box.addView(button("去设置里打开") { openAppSettings() })
        box.addView(
            button("改用粘贴连接串") { finishCanceled() }.apply {
                (layoutParams as? LinearLayout.LayoutParams)?.topMargin = dp(10)
            },
        )
        return box
    }

    private fun button(label: String, onClick: () -> Unit): TextView = TextView(this).apply {
        text = label
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        gravity = Gravity.CENTER
        setPadding(dp(22), dp(11), dp(22), dp(11))
        background = GradientDrawable().apply {
            setColor(0x33FFFFFF)
            setStroke(dp(1), 0x66FFFFFF)
            cornerRadius = dp(10).toFloat()
        }
        isClickable = true
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
    }

    // ──────────────────────────────────────────────────────────────
    // 相机
    // ──────────────────────────────────────────────────────────────

    private fun hasCameraPermission(): Boolean =
        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun startCameraWhenReady() {
        if (cameraStarted) return
        cameraStarted = true
        deniedView.visibility = View.GONE

        val c = LifecycleCameraController(this).apply {
            isTapToFocusEnabled = true
            isPinchToZoomEnabled = true
            setImageAnalysisBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        }
        previewView.controller = c
        c.bindToLifecycle(this)
        c.setImageAnalysisAnalyzer(decoderExecutor) { image ->
            try {
                if (delivered.get()) return@setImageAnalysisAnalyzer
                val now = System.currentTimeMillis()
                if (now < quietUntil) return@setImageAnalysisAnalyzer
                if (!decoding.compareAndSet(false, true)) return@setImageAnalysisAnalyzer
                try {
                    val text = QrDecoder.decode(image)
                    if (text != null) onDecoded(text)
                } finally {
                    decoding.set(false)
                }
            } finally {
                // 必须关，否则 ImageAnalysis 的背压队列会一直以为自己还占着一张图，
                // 之后再也不给新帧 —— 症状是「扫了一会儿画面还在动，但就是不识别」。
                image.close()
            }
        }
        controller = c
    }

    private fun toggleTorch() {
        val c = controller ?: return
        val next = !torchOn
        runCatching { c.enableTorch(next) }
            .onSuccess {
                torchOn = next
                torchView.text = if (next) "关闭手电筒" else "打开手电筒"
            }
            .onFailure {
                Log.w(TAG, "torch unavailable: ${it.message}")
                flashHint("这台设备的闪光灯用不了")
            }
    }

    private fun onDecoded(text: String) {
        val parsed = RemoteLink.parse(text)
        if (parsed == null) {
            // 扫到了别的码：不退出、不弹窗，只换一句话并静默一会儿。
            quietUntil = System.currentTimeMillis() + 1_500L
            flashHint("这不是 Kxxy 的连接码，继续对准电脑上的那个")
            return
        }
        if (!delivered.compareAndSet(false, true)) return
        previewView.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        setResult(RESULT_OK, Intent().putExtra(EXTRA_TEXT, text))
        finish()
    }

    private fun flashHint(text: String) {
        runOnUiThread {
            hintView.text = text
            hintView.postDelayed({
                if (!isFinishing) {
                    hintView.text = "电脑上打开远程接入面板，二维码就在顶部；扫到就自动连上"
                }
            }, 2_200L)
        }
    }

    private fun finishCanceled() {
        setResult(RESULT_CANCELED)
        finish()
    }

    private fun openAppSettings() {
        runCatching {
            startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                },
            )
        }.onFailure { Log.w(TAG, "cannot open app settings: ${it.message}") }
    }

    // ──────────────────────────────────────────────────────────────
    // 生命周期：手动转发（本 Activity 继承 android.app.Activity，
    // 不是 ComponentActivity，所以没有现成的 LifecycleOwner —— 
    // 而 CameraX 的 bindToLifecycle 必须要一个）
    // ──────────────────────────────────────────────────────────────

    override fun onStart() {
        super.onStart()
        lifecycleRegistry.currentState = Lifecycle.State.STARTED
        if (hasCameraPermission()) startCameraWhenReady()
    }

    override fun onResume() {
        super.onResume()
        lifecycleRegistry.currentState = Lifecycle.State.RESUMED
        // 从系统设置页回来时权限可能刚被授予，这里再试一次（幂等）。
        if (hasCameraPermission()) startCameraWhenReady()
    }

    override fun onPause() {
        lifecycleRegistry.currentState = Lifecycle.State.STARTED
        super.onPause()
    }

    override fun onStop() {
        lifecycleRegistry.currentState = Lifecycle.State.CREATED
        super.onStop()
    }

    override fun onDestroy() {
        lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
        runCatching { decoderExecutor.shutdown() }
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) {
            startCameraWhenReady()
        } else {
            deniedView.visibility = View.VISIBLE
        }
    }

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density + 0.5f).toInt()

    companion object {
        private const val TAG = "KxxyQrScan"
        private const val REQ_CAMERA = 4310

        /** 解码出的原始文本。由 MainActivity 负责解析与保存。 */
        const val EXTRA_TEXT = "app.kxxy.extra.QR_TEXT"
    }
}
