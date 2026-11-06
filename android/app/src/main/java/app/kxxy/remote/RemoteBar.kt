package app.kxxy.remote

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import app.kxxy.R

/**
 * 远程会话顶部的「设备条」。
 *
 * ## 为什么必须有它，且必须是原生的
 *
 * 进入远程模式后，WebView 里加载的是**电脑上那台 DSH 的前端**。它和本机
 * 前端长得一模一样 —— 同一个模型选择器、同一个会话列表、同一套输入框。
 * 如果不标出来，用户会以为自己在本机上操作，于是出现两类必然的困惑：
 *
 *   1. 「我刚改的文件在哪？」—— 在电脑上，不在手机里。
 *   2. 「怎么退回去？」—— 远端页面没有任何入口能回到本机的宿主管理页。
 *
 * 第二条是硬约束：远端页面是官方前端，我们既改不了它、也不该依赖它的版本。
 * 所以这条设备条只能用原生控件叠在 WebView 之上；它同时也是**唯一可靠的
 * 逃生通道** —— 远端连不上时页面是一片白，设备条仍然在，随时能断开。
 *
 * ## 视觉
 *
 * 复刻设计稿（`docs/mockups/2026-11-06-远程控制界面.html` 第 ④ 屏）：
 * 50dp 高、左侧 3dp 蓝色竖条、两行文案、右侧「断开」。颜色全部走
 * `values{,-night}/colors.xml`，深浅色主题自动跟随。
 */
@SuppressLint("ViewConstructor")
class RemoteBar(context: Context) : LinearLayout(context) {

    private val labelView: TextView
    private val subView: TextView
    private val actionView: TextView

    var onDisconnect: (() -> Unit)? = null

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setBackgroundColor(context.getColor(R.color.kxxy_window_bg))

        // 顶部 1dp 分隔线 + 左侧 3dp 强调条，与设计稿一致
        addView(
            View(context).apply { setBackgroundColor(context.getColor(R.color.kxxy_accent)) },
            LayoutParams(dp(3), LayoutParams.MATCH_PARENT),
        )

        val texts = LinearLayout(context).apply {
            orientation = VERTICAL
            gravity = Gravity.CENTER_VERTICAL
        }
        labelView = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(context.getColor(R.color.kxxy_boot_title))
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        subView = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 10.5f)
            setTextColor(context.getColor(R.color.kxxy_boot_status))
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        texts.addView(labelView)
        texts.addView(subView)

        addView(
            texts,
            LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(10)
                marginEnd = dp(8)
            },
        )

        actionView = TextView(context).apply {
            text = "断开"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(context.getColor(R.color.kxxy_accent))
            setPadding(dp(12), dp(7), dp(12), dp(7))
            isClickable = true
            setOnClickListener { onDisconnect?.invoke() }
        }
        addView(actionView, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
            marginEnd = dp(8)
        })
    }

    fun bind(device: RemoteStore.Device) {
        labelView.text = device.label
        val where = if (device.kind == "lan") "局域网" else "隧道"
        subView.text = where + " · " + device.displayHost
    }

    /**
     * 临时把副标题换成一条提示，若干毫秒后恢复。
     *
     * 存在理由：远程模式下「返回键」有两个候选语义（关闭远端页内的弹层 /
     * 断开远程），而远端页面的内部状态我们完全看不到。折中成「第一次按只
     * 提示、第二次才断」，就必须有个地方把这句提示显示出来 —— 那就是这里。
     * 用副标题而不是 Toast，是因为它不会遮挡内容，且视线本来就在这条上。
     */
    fun flashHint(text: String, durationMs: Long = 2_000L) {
        val previous = subView.text.toString()
        subView.text = text
        postDelayed({
            if (isAttachedToWindow && subView.text == text) subView.text = previous
        }, durationMs)
    }

    /**
     * 叠加到 WebView 之上，并把 WebView 往下让出这条的高度。
     *
     * 不用 `alignParentTop` 直接压上去：远端页面自己的顶栏（会话标题、
     * 侧栏按钮）会被遮住，而那些按钮没有别的入口。
     */
    fun attachTo(root: FrameLayout, web: View) {
        val height = dp(50)
        root.addView(
            this,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, height).apply {
                gravity = Gravity.TOP
            },
        )
        (web.layoutParams as? FrameLayout.LayoutParams)?.let { lp ->
            lp.topMargin = height
            web.layoutParams = lp
        }
        visibility = View.GONE
    }

    fun show() {
        visibility = View.VISIBLE
        actionView.isEnabled = true
    }

    fun hide() {
        visibility = View.GONE
    }

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density + 0.5f).toInt()
}
