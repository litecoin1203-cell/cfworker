package com.v2ray.ang.cloudgold

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.TrafficStats
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.provider.OpenableColumns
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import com.v2ray.ang.AppConfig
import com.v2ray.ang.BuildConfig
import com.v2ray.ang.R
import com.v2ray.ang.core.CoreServiceManager
import com.v2ray.ang.dto.TestServiceMessage
import com.v2ray.ang.handler.MmkvManager
import com.v2ray.ang.handler.SettingsManager
import com.v2ray.ang.ui.MainActivity
import com.v2ray.ang.util.MessageUtil
import com.v2ray.ang.util.Utils
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/**
 * Cloud Gold launcher screen. Hosts the designed UI (assets/cloudgold) in a WebView and exposes a small bridge,
 * `CGHost.call(id, method, argsJson)`, that answers through `window.__cgResolve(id, ok, json)` and pushes
 * events through `window.__cgEvent(name, json)`. The VPN itself is the stock v2rayNG core and service.
 */
class CloudGoldActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private var pageReady = false
    private var pendingDeepLink: String? = null
    private var vpnRunning = false
    private var stateWaiter: CompletableDeferred<Boolean>? = null
    private var pendingVpnCall: Int? = null
    private var pendingUpload: Pair<Int, JSONObject>? = null
    private val pingRegex by lazy {
        val fmt = getString(R.string.connection_test_available)
        val parts = fmt.split("%d")
        if (parts.size == 2) Regex(Regex.escape(parts[0].trim()) + "\\s*(\\d+)\\s*" + Regex.escape(parts[1].trim()))
        else Regex("(\\d+)\\s*ms")
    }

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val id = pendingVpnCall ?: return@registerForActivityResult
        pendingVpnCall = null
        if (r.resultCode == RESULT_OK) {
            CoreServiceManager.startVService(this)
            resolve(id, true, JSONObject())
        } else {
            resolve(id, true, JSONObject().put("denied", true))
        }
    }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val pickImage = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val (id, args) = pendingUpload ?: return@registerForActivityResult
        pendingUpload = null
        if (uri == null) {
            resolve(id, true, JSONObject().put("cancelled", true))
            return@registerForActivityResult
        }
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { uploadImage(uri, args) }
            resolve(id, result.first, result.second)
        }
    }

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
    }

    // ---------------------------------------------------------------- lifecycle

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.parseColor("#010315")),
        )
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#010315")) }
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#010315"))
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.textZoom = 100 // the layout is drawn to the design grid; system font scale would break it
            settings.mediaPlaybackRequiresUserGesture = true
            addJavascriptInterface(Bridge(), "CGHost")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == "appassets.androidplatform.net") return false
                    openExternal(request.url.toString())
                    return true
                }

                override fun onPageFinished(view: WebView, url: String) {
                    pageReady = true
                    pendingDeepLink?.let { deliverDeepLink(it) }
                    pendingDeepLink = null
                    MessageUtil.sendMsg2Service(this@CloudGoldActivity, AppConfig.MSG_REGISTER_CLIENT, "")
                }
            }
        }
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        // draw under the status bar (the design leaves room for it); keep clear of the nav bar and the keyboard
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.ime()).bottom
            v.setPadding(0, 0, 0, bottom)
            insets
        }

        ContextCompat.registerReceiver(this, stateReceiver, IntentFilter(AppConfig.BROADCAST_ACTION_ACTIVITY), Utils.receiverFlags())

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.__cgBack ? window.__cgBack() : false") { r ->
                    if (r != "true") moveTaskToBack(true)
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        CgTune.applyDefaults(this)
        intent?.data?.let { pendingDeepLink = it.toString() }
        web.loadUrl("https://appassets.androidplatform.net/assets/cloudgold/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.toString()?.let { if (pageReady) deliverDeepLink(it) else pendingDeepLink = it }
    }

    override fun onResume() {
        super.onResume()
        if (pageReady) {
            MessageUtil.sendMsg2Service(this, AppConfig.MSG_REGISTER_CLIENT, "")
            emit("resume", JSONObject())
        }
    }

    override fun onDestroy() {
        try { unregisterReceiver(stateReceiver) } catch (_: Exception) {}
        web.removeJavascriptInterface("CGHost")
        web.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- JS plumbing

    private fun js(script: String) {
        runOnUiThread { if (!isDestroyed) web.evaluateJavascript(script, null) }
    }

    private fun resolve(id: Int, ok: Boolean, payload: Any) {
        js("window.__cgResolve && window.__cgResolve($id, $ok, ${JSONObject.quote(payload.toString())})")
    }

    private fun emit(name: String, payload: JSONObject) {
        js("window.__cgEvent && window.__cgEvent(${JSONObject.quote(name)}, ${JSONObject.quote(payload.toString())})")
    }

    private fun fail(id: Int, code: String, message: String) =
        resolve(id, false, JSONObject().put("code", code).put("message", message))

    private fun deliverDeepLink(url: String) = js("window.__cgDeepLink && window.__cgDeepLink(${JSONObject.quote(url)})")

    inner class Bridge {
        @JavascriptInterface
        fun call(id: Int, method: String, argsJson: String?) {
            val args = try { JSONObject(argsJson ?: "{}") } catch (e: Exception) { JSONObject() }
            lifecycleScope.launch {
                try {
                    handle(id, method, args)
                } catch (e: CgError) {
                    fail(id, e.code, e.message ?: "مشکلی پیش آمد.")
                } catch (e: Exception) {
                    fail(id, "error", e.message ?: e.javaClass.simpleName)
                }
            }
        }
    }

    private suspend fun handle(id: Int, method: String, a: JSONObject) {
        val ctx: Context = this
        when (method) {
            "api" -> {
                val body = a.opt("body").let { if (it == null || it == JSONObject.NULL) null else it.toString() }
                val r = withContext(Dispatchers.IO) { CgApi.request(ctx, a.optString("method", "GET"), a.optString("path"), body) }
                resolve(id, true, r.toJson())
            }
            "session" -> resolve(id, true, JSONObject()
                .put("loggedIn", CgSession.loggedIn)
                .put("email", CgSession.email ?: "")
                .put("version", BuildConfig.VERSION_NAME)
                .put("core", "2.2.6"))
            "setSession" -> {
                CgSession.save(a.optString("access_token"), a.optString("refresh_token"), a.optString("email"))
                resolve(id, true, JSONObject())
            }
            "logout" -> {
                if (vpnRunning) CoreServiceManager.stopVService(ctx)
                withContext(Dispatchers.IO) { MmkvManager.removeSubscription(CgVpn.SUB_ID) }
                CgSession.clear()
                resolve(id, true, JSONObject())
            }
            "device" -> resolve(id, true, JSONObject().put("id", CgSession.deviceId(ctx)).put("model", CgSession.deviceModel()))

            // ---- VPN
            "vpnSync" -> resolve(id, true, withContext(Dispatchers.IO) { CgVpn.sync(ctx) })
            "vpnServers" -> resolve(id, true, withContext(Dispatchers.IO) { CgVpn.servers() })
            "vpnConnect", "vpnSelect" -> {
                val guid = a.optString("guid")
                if (guid.isNotEmpty()) CgVpn.select(guid)
                if (MmkvManager.getSelectServer().isNullOrEmpty()) throw CgError("no_server", "اول یک لوکیشن انتخاب کن.")
                if (vpnRunning) {
                    MessageUtil.sendMsg2Service(ctx, AppConfig.MSG_STATE_RESTART, "")
                    resolve(id, true, JSONObject())
                } else if (SettingsManager.isVpnMode()) {
                    val intent = VpnService.prepare(ctx)
                    if (intent == null) {
                        CoreServiceManager.startVService(ctx)
                        resolve(id, true, JSONObject())
                    } else {
                        pendingVpnCall?.let { resolve(it, true, JSONObject().put("denied", true)) }
                        pendingVpnCall = id
                        vpnPermission.launch(intent)
                    }
                } else {
                    CoreServiceManager.startVService(ctx)
                    resolve(id, true, JSONObject())
                }
            }
            "vpnDisconnect" -> {
                CoreServiceManager.stopVService(ctx)
                resolve(id, true, JSONObject())
            }
            "vpnState" -> {
                val waiter = CompletableDeferred<Boolean>()
                stateWaiter = waiter
                MessageUtil.sendMsg2Service(ctx, AppConfig.MSG_REGISTER_CLIENT, "")
                // the service only answers while it runs, so silence means "not running"
                val running = withTimeoutOrNull(800) { waiter.await() } ?: vpnRunning
                resolve(id, true, JSONObject().put("running", running))
            }
            "vpnPing" -> {
                if (vpnRunning) MessageUtil.sendMsg2Service(ctx, AppConfig.MSG_MEASURE_DELAY, "")
                resolve(id, true, JSONObject())
            }
            "vpnTestAll" -> {
                MessageUtil.sendMsg2TestService(ctx, TestServiceMessage(key = AppConfig.MSG_MEASURE_CONFIG_START, subscriptionId = CgVpn.SUB_ID))
                resolve(id, true, JSONObject())
            }
            "getTune" -> resolve(id, true, JSONObject().put("iranDirect", CgTune.iranDirect()))
            "setTune" -> {
                withContext(Dispatchers.IO) { CgTune.setIranDirect(ctx, a.optBoolean("iranDirect", true)) }
                if (vpnRunning) MessageUtil.sendMsg2Service(ctx, AppConfig.MSG_STATE_RESTART, "")
                resolve(id, true, JSONObject().put("iranDirect", CgTune.iranDirect()))
            }
            "traffic" -> {
                // the core runs in our own uid, so the app's byte counters are the tunnel's throughput
                val uid = Process.myUid()
                val rx = TrafficStats.getUidRxBytes(uid).coerceAtLeast(0L)
                val tx = TrafficStats.getUidTxBytes(uid).coerceAtLeast(0L)
                resolve(id, true, JSONObject().put("rx", rx).put("tx", tx))
            }

            // ---- device helpers
            "uploadReceipt" -> {
                pendingUpload?.let { resolve(it.first, true, JSONObject().put("cancelled", true)) }
                pendingUpload = id to a
                pickImage.launch("image/*")
            }
            "openUrl" -> {
                openExternal(a.optString("url"))
                resolve(id, true, JSONObject())
            }
            "copy" -> {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Cloud Gold", a.optString("text")))
                resolve(id, true, JSONObject())
            }
            "share" -> {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, a.optString("text"))
                startActivity(Intent.createChooser(send, getString(R.string.app_name)))
                resolve(id, true, JSONObject())
            }
            "advanced" -> {
                startActivity(Intent(ctx, MainActivity::class.java))
                resolve(id, true, JSONObject())
            }
            else -> fail(id, "unknown_method", "Unknown bridge method $method")
        }
    }

    private fun openExternal(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme !in setOf("https", "http", "tg", "mailto")) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
        }
    }

    private fun uploadImage(uri: Uri, args: JSONObject): Pair<Boolean, JSONObject> {
        return try {
            val maxBytes = 10 * 1024 * 1024
            val bytes = contentResolver.openInputStream(uri)?.use { input ->
                val buf = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(64 * 1024)
                var total = 0
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    total += n
                    if (total > maxBytes) return false to JSONObject().put("code", "too_large").put("message", "حجم عکس باید کمتر از ۱۰ مگابایت باشد.")
                    buf.write(chunk, 0, n)
                }
                buf.toByteArray()
            } ?: return false to JSONObject().put("code", "bad_file").put("message", "این عکس خوانده نشد.")
            var name = "receipt.jpg"
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0)?.let { name = it }
            }
            val mime = contentResolver.getType(uri) ?: "image/jpeg"
            val r = CgApi.upload(this, args.optString("path"), name, mime, bytes, mapOf("ref" to args.optString("ref")))
            true to r.toJson()
        } catch (e: Exception) {
            false to JSONObject().put("code", "upload_failed").put("message", "ارسال ناموفق بود. اینترنت را بررسی کن و دوباره امتحان کن.")
        }
    }

    // ---------------------------------------------------------------- core service events

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, received: Intent?) {
            val intent = received ?: return
            when (intent.getIntExtra("key", 0)) {
                AppConfig.MSG_STATE_RUNNING, AppConfig.MSG_STATE_START_SUCCESS -> setRunning(true)
                AppConfig.MSG_STATE_NOT_RUNNING, AppConfig.MSG_STATE_STOP_SUCCESS -> setRunning(false)
                AppConfig.MSG_STATE_START_FAILURE -> {
                    val msg = intent.getStringExtra("content").takeUnless { it.isNullOrBlank() } ?: "اتصال به این لوکیشن ممکن نشد. لوکیشن دیگری را امتحان کن."
                    emit("vpnError", JSONObject().put("message", msg))
                    setRunning(false)
                }
                AppConfig.MSG_MEASURE_DELAY_SUCCESS -> onPing(intent.getStringExtra("content").orEmpty())
                AppConfig.MSG_MEASURE_CONFIG_SUCCESS -> {
                    val guid = intent.getStringExtra("content").orEmpty()
                    val ms = MmkvManager.decodeServerAffiliationInfo(guid)?.testDelayMillis ?: 0L
                    emit("serverPing", JSONObject().put("guid", guid).put("ms", ms))
                }
            }
        }
    }

    private fun setRunning(running: Boolean) {
        vpnRunning = running
        stateWaiter?.complete(running)
        stateWaiter = null
        emit("vpn", JSONObject().put("running", running))
    }

    private fun onPing(content: String) {
        val lines = content.lines()
        val ms = pingRegex.find(lines.firstOrNull().orEmpty())?.groupValues?.getOrNull(1)?.toIntOrNull()
        val out = JSONObject().put("ms", ms ?: JSONObject.NULL)
        Regex("\\((\\w+)\\)\\s+(\\S+)").find(lines.getOrNull(1).orEmpty())?.let {
            if (it.groupValues[2] != "unknown") out.put("ip", it.groupValues[2])
            if (it.groupValues[1] != "unknown") out.put("cc", it.groupValues[1].uppercase())
        }
        emit("ping", out)
    }
}
