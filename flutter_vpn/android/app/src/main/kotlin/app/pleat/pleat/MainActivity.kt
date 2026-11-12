package app.pleat.pleat

import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * Hosts the Flutter UI and the `pleat/tunnel` channel: available, start,
 * stop, state and systemSettings. State changes arrive on
 * `pleat/tunnel/state`.
 */
class MainActivity : FlutterActivity() {
    private companion object {
        const val ASK_VPN = 41
        const val PICK_IMAGE = 42
        const val ASK_NOTES = 43

        /**
         * One server test's budget, counted from when it really starts.
         * The core's own test can't be told a deadline: it tries twice
         * with 12 s each, so a server that never answers held a lane for
         * up to 24 s while the app had given up after 10 s, and the next
         * servers waited in the queue and were reported as timeouts
         * without ever being tried.
         */
        const val PING_BUDGET_MS = 10_000L
        // Read whole (a phone photo can be over 8 MB), then made small by shrink().
        const val MAX_IMAGE = 25 * 1024 * 1024
    }

    private var pendingImage: MethodChannel.Result? = null

    /** Server tests run a few at a time, off the main thread (as many as AppState's lanes). */
    private val tests = Executors.newFixedThreadPool(6)

    /** Server tests only: as many at a time as AppState's lanes, nothing else queued in front of them. */
    private val pings = Executors.newFixedThreadPool(6)

    /**
     * The core's test runs here so a lane can walk away from it at
     * [PING_BUDGET_MS]; a test left behind ends by itself within 24 s.
     */
    private val cores = Executors.newCachedThreadPool()

    /** Download tests run one by one: side by side they would split the line. */
    private val speeds = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    /** A screen the notification asked for, until the app reads it. */
    private var pendingOpen: String? = null
    private var tunnelChannel: MethodChannel? = null

    private var pendingConfig: String? = null
    private var pendingResult: MethodChannel.Result? = null

    override fun configureFlutterEngine(engine: FlutterEngine) {
        super.configureFlutterEngine(engine)
        Health.install(this)
        TunnelHub.app = applicationContext
        EventChannel(engine.dartExecutor.binaryMessenger, "pleat/tunnel/state")
            .setStreamHandler(TunnelHub.stream)
        pendingOpen = pendingOpen ?: intent?.getStringExtra(TunnelNote.EXTRA_OPEN)
        val updates = MethodChannel(engine.dartExecutor.binaryMessenger, "pleat/update")
        Updates.onAction = { what -> main.post { updates.invokeMethod("action", what) } }
        updates.setMethodCallHandler { call, result ->
            when (call.method) {
                "info" -> result.success(Updates.info(this))
                "dir" -> result.success(Updates.dir(this).absolutePath)
                "sha256" -> background(result, "") { Updates.sha256(java.io.File(call.argument<String>("path").orEmpty())) }
                "canInstall" -> result.success(Updates.canInstall(this))
                "allowInstalls" -> {
                    try {
                        Updates.allowInstalls(this)
                        result.success(true)
                    } catch (e: Exception) {
                        result.success(false)
                    }
                }
                "install" -> {
                    val ok = try {
                        Updates.install(this, java.io.File(call.argument<String>("path").orEmpty()))
                    } catch (e: Exception) {
                        false
                    }
                    result.success(ok)
                }
                "note" -> {
                    @Suppress("UNCHECKED_CAST")
                    val args = (call.arguments as? Map<String, Any?>).orEmpty()
                    try {
                        Updates.note(this, args)
                    } catch (e: Exception) {
                        // a notification that can't be drawn: the Home card still shows it
                    }
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        val channel = MethodChannel(engine.dartExecutor.binaryMessenger, "pleat/tunnel")
        tunnelChannel = channel
        channel
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "available" -> result.success(engineLoads())
                    "engineError" -> result.success(engineError())
                    // the health reports: crashes, kills and battery since the last read; a start's failure
                    "health" -> background(result, mapOf<String, Any>()) { Health.collect(this) }
                    "startError" -> result.success(Health.takeStartError())
                    "state" -> result.success(TunnelHub.state)
                    "note" -> {
                        TunnelNote.info = TunnelNote.Info(
                            flag = call.argument<String>("flag").orEmpty(),
                            place = call.argument<String>("place").orEmpty(),
                            ip = call.argument<String>("ip").orEmpty(),
                            protocol = call.argument<String>("protocol").orEmpty(),
                            since = call.argument<Number>("since")?.toLong() ?: 0L,
                        )
                        PleatVpnService.noteChanged()
                        StatusWidget.remember(this, TunnelNote.info.flag, TunnelNote.info.place)
                        StatusWidget.refresh(this)
                        result.success(null)
                    }
                    // Signed out: the widget can't start the old account's exit.
                    // Exits a widget start tries after the last one (StatusWidget).
                    "spares" -> {
                        @Suppress("UNCHECKED_CAST")
                        val list = (call.argument<List<Any?>>("list") ?: emptyList())
                            .mapNotNull { it as? Map<String, Any?> }
                        StatusWidget.saveSpares(this, list)
                        result.success(null)
                    }
                    "forget" -> {
                        StatusWidget.forget(this)
                        result.success(null)
                    }
                    "pendingOpen" -> {
                        result.success(pendingOpen)
                        pendingOpen = null
                    }
                    "start" -> {
                        val config = call.argument<String>("config")
                        if (config == null) {
                            result.error("bad_config", "no config", null)
                            return@setMethodCallHandler
                        }
                        val ask = VpnService.prepare(this)
                        if (ask == null) {
                            launch(config)
                            result.success(null)
                        } else {
                            pendingResult?.error("replaced", "a newer start came in", null)
                            pendingConfig = config
                            pendingResult = result
                            startActivityForResult(ask, ASK_VPN)
                        }
                    }
                    "stop" -> {
                        startService(Intent(this, PleatVpnService::class.java).setAction(PleatVpnService.ACTION_STOP))
                        result.success(null)
                    }
                    "device" -> {
                        // The same values the Cloud Gold app sends (CgSession.deviceModel, X-Ver-OS).
                        val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
                        val model = Build.MODEL.orEmpty()
                        result.success(
                            mapOf(
                                "model" to if (model.startsWith(maker, true)) model else "$maker $model".trim(),
                                "release" to Build.VERSION.RELEASE.orEmpty(),
                                "hwid" to cloudGoldHwid()
                            )
                        )
                    }
                    "geo" -> background(result, false) { Engine.init(this); Engine.hasGeo(this) }
                    "ping" -> {
                        val config = call.argument<String>("config")
                        if (config == null) {
                            result.success(-1)
                            return@setMethodCallHandler
                        }
                        // The delay in ms, or the core's reason as text (addresses blanked).
                        pings.execute {
                            val value: Any = try {
                                Engine.init(this)
                                val test = cores.submit<Int> {
                                    libv2ray.Libv2ray.measureOutboundDelay(config, Engine.TEST_URL).toInt()
                                }
                                try {
                                    test.get(PING_BUDGET_MS, TimeUnit.MILLISECONDS)
                                } catch (e: TimeoutException) {
                                    test.cancel(true)
                                    "no answer in ${PING_BUDGET_MS / 1000} s (timeout)"
                                } catch (e: java.util.concurrent.ExecutionException) {
                                    val c = e.cause ?: e
                                    blank(c.message.orEmpty().ifEmpty { c.javaClass.simpleName }).take(200)
                                }
                            } catch (e: Throwable) {
                                -1
                            }
                            main.post { result.success(value) }
                        }
                    }
                    "trace" -> {
                        val config = call.argument<String>("config")
                        if (config == null) {
                            result.success(null)
                            return@setMethodCallHandler
                        }
                        // One exit alone, with the core's own log, for the person to send us.
                        background(result, mapOf("ms" to -1, "error" to "trace failed", "log" to "")) {
                            Engine.init(this)
                            trace(config)
                        }
                    }
                    "speed" -> {
                        val config = call.argument<String>("config")
                        if (config == null) {
                            result.success(-1)
                            return@setMethodCallHandler
                        }
                        // One at a time, so exits don't share the line and slow each other.
                        speeds.execute {
                            val kbps = try {
                                Engine.init(this)
                                Speed.measure(config)
                            } catch (e: Throwable) {
                                -1
                            }
                            main.post { result.success(kbps) }
                        }
                    }
                    "metered" -> {
                        // Pleat is outside its own tunnel, so this is the real
                        // network: mobile data, or Wi-Fi marked metered.
                        val cm = getSystemService(android.net.ConnectivityManager::class.java)
                        result.success(cm?.isActiveNetworkMetered ?: false)
                    }
                    "netKind" -> result.success(netKind())
                    "delay" -> background(result) {
                        PleatVpnService.running?.measureDelay(Engine.TEST_URL)?.toInt() ?: -1
                    }
                    "policy" -> {
                        // Android tells only the running service (10 and newer).
                        val svc = PleatVpnService.instance
                        result.success(
                            if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                mapOf("known" to true, "alwaysOn" to svc.isAlwaysOn, "lockdown" to svc.isLockdownEnabled)
                            } else {
                                mapOf("known" to false)
                            }
                        )
                    }
                    "openUrl" -> {
                        val url = call.argument<String>("url").orEmpty()
                        val ok = (url.startsWith("https://") || url.startsWith("http://") || url.startsWith("tg://")) &&
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                                true
                            } catch (e: Exception) {
                                false
                            }
                        result.success(ok)
                    }
                    "share" -> {
                        val text = call.argument<String>("text").orEmpty()
                        startActivity(
                            Intent.createChooser(
                                Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text),
                                null
                            )
                        )
                        result.success(null)
                    }
                    "bridgeStart" -> {
                        val config = call.argument<String>("config")
                        if (config == null) {
                            result.success(false)
                            return@setMethodCallHandler
                        }
                        background(result, false) { Bridge.start(this, config) }
                    }
                    "bridgeStop" -> background(result, false) { Bridge.stop(); true }
                    "filesDir" -> result.success(filesDir.absolutePath)
                    "pickImage" -> {
                        pendingImage?.success(null)
                        pendingImage = result
                        startActivityForResult(
                            Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE),
                            PICK_IMAGE
                        )
                    }
                    // Route > Split route: the apps a person can keep out of the tunnel
                    "apps" -> background(result, emptyList<Map<String, Any>>()) { Apps.list(this) }
                    // Route > Stay in one country: a question while Pleat isn't on screen
                    "alert" -> {
                        try {
                            Alert.show(this, call.argument<String>("title").orEmpty(), call.argument<String>("text").orEmpty())
                        } catch (e: Exception) {
                            // no notification: the popup still waits in the app
                        }
                        result.success(null)
                    }
                    "alertClear" -> {
                        Alert.clear(this)
                        result.success(null)
                    }
                    "systemSettings" -> {
                        startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    /** Runs [work] on the test pool and answers on the main thread; a failure answers [fallback]. */
    /**
     * How the phone itself reaches the internet: "wifi", "cell" (mobile
     * data), "other" (ethernet, USB ...) or "" when offline. Pleat's own
     * tunnel is skipped, so a connected phone still says Wi-Fi or mobile
     * data. Only the transport is read: no SSID, no SIM, no permission
     * beyond network state.
     */
    private fun netKind(): String {
        val cm = getSystemService(android.net.ConnectivityManager::class.java) ?: return ""
        fun kindOf(caps: android.net.NetworkCapabilities?): String? = when {
            caps == null || caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN) -> null
            !caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) -> null
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "cell"
            else -> "other"
        }
        return try {
            // The default network when no VPN is up; with one up, the
            // network under it (Android prefers Wi-Fi when both are on).
            kindOf(cm.getNetworkCapabilities(cm.activeNetwork))
                ?: run {
                    @Suppress("DEPRECATION")
                    val kinds = cm.allNetworks.mapNotNull { kindOf(cm.getNetworkCapabilities(it)) }
                    when {
                        "wifi" in kinds -> "wifi"
                        "cell" in kinds -> "cell"
                        kinds.isNotEmpty() -> "other"
                        else -> ""
                    }
                }
        } catch (e: Throwable) {
            ""
        }
    }

    private fun background(result: MethodChannel.Result, fallback: Any = -1, work: () -> Any) {
        tests.execute {
            val value: Any = try {
                work()
            } catch (e: Throwable) {
                fallback
            }
            main.post { result.success(value) }
        }
    }

    @Deprecated("Activity result API is not used by FlutterActivity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PICK_IMAGE) {
            val result = pendingImage ?: return
            pendingImage = null
            val uri = data?.data
            if (resultCode != RESULT_OK || uri == null) {
                result.success(null)
                return
            }
            // Read off the main thread; a photo can be several MB.
            tests.execute {
                val bytes = try {
                    contentResolver.openInputStream(uri)?.use { input ->
                        val buf = java.io.ByteArrayOutputStream()
                        val chunk = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(chunk)
                            if (n < 0) break
                            buf.write(chunk, 0, n)
                            if (buf.size() > MAX_IMAGE) break
                        }
                        buf.toByteArray()
                    }
                } catch (e: Exception) {
                    null
                }
                val small = bytes?.let { shrink(it) ?: it }
                main.post { result.success(small) }
            }
            return
        }
        if (requestCode != ASK_VPN) return
        val result = pendingResult ?: return
        val config = pendingConfig
        pendingResult = null
        pendingConfig = null
        if (resultCode == RESULT_OK && config != null) {
            launch(config)
            result.success(null)
        } else {
            result.error("denied", "VPN permission refused", null)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val target = intent.getStringExtra(TunnelNote.EXTRA_OPEN) ?: return
        val channel = tunnelChannel
        if (channel == null) {
            pendingOpen = target
        } else {
            channel.invokeMethod("open", target)
        }
    }

    /**
     * Android 13+ hides a service's notification until this is allowed, and
     * the card carries the Disconnect button. Asked once, on the first connect.
     */
    private fun askNotes() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return
        val prefs = getSharedPreferences("pleat_native", MODE_PRIVATE)
        if (prefs.getBoolean("asked_notes", false)) return
        prefs.edit().putBoolean("asked_notes", true).apply()
        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), ASK_NOTES)
    }

    private fun launch(config: String) {
        askNotes()
        startService(
            Intent(this, PleatVpnService::class.java)
                .setAction(PleatVpnService.ACTION_START)
                .putExtra(PleatVpnService.EXTRA_CONFIG, config)
        )
    }

    /**
     * The device id the Cloud Gold app sends for this phone (CgSession.deviceId):
     * SHA-256 of ANDROID_ID + its package name, 32 hex. ANDROID_ID is the same
     * for apps signed with the same key, and Pleat is signed with Cloud Gold's
     * key, so the Worker and the panel's HWID limit see the same phone, not a
     * second device. Empty when Android gives no ANDROID_ID.
     */
    private fun cloudGoldHwid(): String {
        val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
        if (androidId.isEmpty()) return ""
        return java.security.MessageDigest.getInstance("SHA-256")
            .digest((androidId + "com.cloudgold.vpn").toByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(32)
    }

    /** The core's errors name the server; never show an address or a host. */
    /**
     * Tests one exit like "ping" with the core logging everything to a file,
     * and returns the delay or the core's reason plus the log's last lines,
     * with addresses, keys and ids blanked.
     */
    private fun trace(config: String): Map<String, Any?> {
        val file = java.io.File(cacheDir, "trace.log")
        file.delete()
        val json = org.json.JSONObject(config)
        json.put(
            "log",
            org.json.JSONObject()
                .put("loglevel", "debug")
                .put("error", file.absolutePath)
                .put("access", "none")
                .put("dnsLog", true)
        )
        val started = System.currentTimeMillis()
        var error: String? = null
        val ms = try {
            libv2ray.Libv2ray.measureOutboundDelay(json.toString(), Engine.TEST_URL).toInt()
        } catch (e: Exception) {
            error = blank(e.message.orEmpty().ifEmpty { e.javaClass.simpleName }).take(400)
            -1
        }
        val took = System.currentTimeMillis() - started
        val lines = try { file.readLines() } catch (e: Exception) { emptyList() }
        file.delete()
        val log = lines.takeLast(150).joinToString("\n") { secretless(blank(it)).take(300) }
        return mapOf("ms" to ms, "error" to error, "took" to took.toInt(), "log" to log)
    }

    /** UUIDs and base64 keys out of a log line. */
    private fun secretless(text: String): String = text
        .replace(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"), "<id>")
        .replace(Regex("[A-Za-z0-9+/_-]{40,}={0,2}"), "<key>")
        .replace(Regex("\\b[0-9a-fA-F]{64}\\b"), "<key>")

    private fun blank(text: String): String = text
        .replace(Regex("\\[[0-9a-fA-F:]+\\](:\\d+)?"), "…")
        .replace(Regex("\\b\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?\\b"), "…")
        .replace(Regex("\\b([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(:\\d+)?\\b"), "…")

    /**
     * A receipt photo made small enough for a slow, filtered line: at most
     * 1600 px on the long side, JPEG at quality 82 (a bank receipt stays
     * readable; usually 150 to 400 KB instead of several MB). Null when the
     * bytes aren't an image Android can read, so the original is sent.
     */
    private fun shrink(bytes: ByteArray): ByteArray? = try {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val long = maxOf(bounds.outWidth, bounds.outHeight)
        if (long <= 0) {
            null
        } else {
            var sample = 1
            while (long / (sample * 2) >= 1600) sample *= 2
            val opts = android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
            val decoded = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            if (decoded == null) {
                null
            } else {
                val side = maxOf(decoded.width, decoded.height)
                val scaled = if (side > 1600) {
                    val k = 1600f / side
                    android.graphics.Bitmap.createScaledBitmap(
                        decoded, (decoded.width * k).toInt().coerceAtLeast(1), (decoded.height * k).toInt().coerceAtLeast(1), true
                    ).also { if (it !== decoded) decoded.recycle() }
                } else decoded
                // A camera photo keeps its turn in EXIF, which a re-encode drops.
                val turn = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) try {
                    when (android.media.ExifInterface(java.io.ByteArrayInputStream(bytes)).getAttributeInt(
                        android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL
                    )) {
                        android.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                        android.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                        android.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                        else -> 0f
                    }
                } catch (e: Exception) { 0f } else 0f
                val bmp = if (turn != 0f) {
                    android.graphics.Bitmap.createBitmap(
                        scaled, 0, 0, scaled.width, scaled.height,
                        android.graphics.Matrix().apply { postRotate(turn) }, true
                    ).also { if (it !== scaled) scaled.recycle() }
                } else scaled
                val out = java.io.ByteArrayOutputStream()
                bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, out)
                bmp.recycle()
                val jpeg = out.toByteArray()
                // Already small (a screenshot, say): keep whichever is smaller.
                if (jpeg.isNotEmpty() && jpeg.size < bytes.size) jpeg else null
            }
        }
    } catch (e: Throwable) {
        null
    }

    /** True when this build ships the core and the tun library. */
    private fun engineLoads(): Boolean = engineError() == null

    /** Why the engine doesn't load (class and message), or null when it does. */
    private fun engineError(): String? = try {
        Class.forName("libv2ray.Libv2ray")
        System.loadLibrary("hev-socks5-tunnel")
        Engine.init(this)
        null
    } catch (e: Throwable) {
        "${e.javaClass.simpleName}: ${e.message.orEmpty().take(160)}"
    }
}
