package app.pleat.pleat

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * What only Android can tell the app's health reports (lib/state/health.dart):
 *
 *  - Why the app's process ended last time (Android 11+): a crash in Kotlin,
 *    a native crash (the Xray core runs in this process, so a Go panic shows
 *    here), a freeze (ANR), or Android killing it (low memory, battery
 *    saver, "too much use") while the VPN was running.
 *  - Below Android 11: a marker left by a tunnel that never stopped cleanly.
 *  - The first lines of a Kotlin crash, kept for the next launch.
 *  - Battery: % used per hour over a VPN session of 30+ minutes on battery,
 *    and how much of it the screen was off. Read from Android's own battery
 *    level at the start and the end; no extra wake-ups.
 *  - The core's reason when a start fails (addresses blanked).
 *
 * Everything is kept in a small private prefs file until the app reads it
 * once (collect), then forgotten. No address, link or key is stored.
 */
object Health {
    private const val PREFS = "pleat_health"
    private const val MAX_BATTERY = 5
    private const val MIN_SESSION_MS = 30 * 60 * 1000L

    @Volatile
    private var startError: String? = null

    @Volatile
    private var installed = false

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** No server address, IP, UUID or long key in a text that leaves the phone. */
    fun blank(text: String): String = text
        .replace(Regex("[a-zA-Z][a-zA-Z0-9+.-]{1,15}://\\S+"), "<link>")
        .replace(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"), "<id>")
        .replace(Regex("\\[[0-9a-fA-F:]+\\](:\\d+)?"), "<ip>")
        .replace(Regex("\\b\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?\\b"), "<ip>")
        .replace(Regex("[A-Za-z0-9+/_-]{24,}={0,2}"), "<blob>")
        .replace(Regex("\\b([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(:\\d+)?\\b")) { m ->
            if (CODE.containsMatchIn(m.value) || FILE.containsMatchIn(m.value)) m.value else "<host>"
        }

    private val CODE = Regex("^(java|javax|android|androidx|kotlin|kotlinx|dalvik|io\\.flutter|app\\.pleat|libv2ray|go|com\\.android|org\\.json)\\.")
    private val FILE = Regex("\\.(kt|java|so|go|dart)(:\\d+)?$")

    // ---- why a start failed ------------------------------------------------

    fun startFailed(e: Throwable?) {
        val t = e ?: return
        startError = blank(t.message.orEmpty().ifEmpty { t.javaClass.simpleName }).take(200)
    }

    /** The last start's failure, once. */
    fun takeStartError(): String? = startError.also { startError = null }

    // ---- Kotlin crashes ----------------------------------------------------

    /** Keeps a crash's first lines for the next launch, then lets Android crash as before. */
    @Synchronized
    fun install(ctx: Context) {
        if (installed) return
        installed = true
        val app = ctx.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            try {
                val frames = e.stackTrace.take(8).joinToString(" | ") { "${it.className}.${it.methodName}(${it.fileName}:${it.lineNumber})" }
                val text = blank("${e.javaClass.name}: ${e.message.orEmpty()} @ ${thread.name} | $frames").take(600)
                // commit(): the process is about to end
                prefs(app).edit().putString("java_crash", text).putLong("java_crash_at", System.currentTimeMillis()).commit()
            } catch (x: Throwable) {
                // nothing more can be done here
            }
            previous?.uncaughtException(thread, e)
        }
    }

    // ---- the tunnel's own marker (Android 10 and older) ---------------------

    private fun marker(ctx: Context) = File(ctx.applicationContext.noBackupFilesDir, "tunnel-up")

    fun tunnelUp(ctx: Context) {
        try { marker(ctx).writeText(System.currentTimeMillis().toString()) } catch (e: Exception) {}
    }

    fun tunnelStopped(ctx: Context) {
        try { marker(ctx).delete() } catch (e: Exception) {}
    }

    // ---- battery over a session ---------------------------------------------

    private var screenOffSince = 0L
    private var screenOffMs = 0L
    private var charged = false
    private var receiver: BroadcastReceiver? = null

    private fun battery(ctx: Context): Pair<Int, Boolean>? = try {
        val i = ctx.applicationContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val plugged = (i?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        if (level < 0 || scale <= 0) null else Pair(level * 100 / scale, plugged)
    } catch (e: Exception) {
        null
    }

    /** The tunnel came up: the session's battery starts here (only on battery). */
    @Synchronized
    fun sessionStart(ctx: Context) {
        val p = prefs(ctx)
        if (p.getLong("s_at", 0L) != 0L) return // already counting (an exit swap)
        val b = battery(ctx) ?: return
        if (b.second) return
        val power = ctx.applicationContext.getSystemService(PowerManager::class.java)
        screenOffMs = 0L
        screenOffSince = if (power != null && !power.isInteractive) SystemClock.elapsedRealtime() else 0L
        charged = false
        p.edit().putLong("s_at", SystemClock.elapsedRealtime()).putInt("s_level", b.first).apply()
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                when (i.action) {
                    Intent.ACTION_SCREEN_OFF -> if (screenOffSince == 0L) screenOffSince = SystemClock.elapsedRealtime()
                    Intent.ACTION_SCREEN_ON -> if (screenOffSince != 0L) {
                        screenOffMs += SystemClock.elapsedRealtime() - screenOffSince
                        screenOffSince = 0L
                    }
                    Intent.ACTION_POWER_CONNECTED -> charged = true
                }
            }
        }
        val f = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_POWER_CONNECTED)
        }
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                ctx.applicationContext.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED)
            } else {
                ctx.applicationContext.registerReceiver(r, f)
            }
            receiver = r
        } catch (e: Exception) {
            receiver = null
        }
    }

    /** The tunnel stopped: a session of 30+ minutes, all on battery, is kept. */
    @Synchronized
    fun sessionEnd(ctx: Context) {
        val p = prefs(ctx)
        val at = p.getLong("s_at", 0L)
        val level0 = p.getInt("s_level", -1)
        p.edit().remove("s_at").remove("s_level").apply()
        receiver?.let { try { ctx.applicationContext.unregisterReceiver(it) } catch (e: Exception) {} }
        receiver = null
        if (at == 0L || level0 < 0) return
        val now = SystemClock.elapsedRealtime()
        if (screenOffSince != 0L) screenOffMs += now - screenOffSince
        screenOffSince = 0L
        val ms = now - at
        val b = battery(ctx) ?: return
        if (charged || b.second || ms < MIN_SESSION_MS || ms > 48 * 3600 * 1000L) return
        val drop = level0 - b.first
        if (drop < 0) return
        val minutes = (ms / 60000L).toInt()
        val power = ctx.applicationContext.getSystemService(PowerManager::class.java)
        val optimized = power != null && !power.isIgnoringBatteryOptimizations(ctx.packageName)
        val one = JSONObject()
            .put("rate", Math.round(drop * 600.0 / minutes) / 10.0)
            .put("drop", drop)
            .put("min", minutes)
            .put("off", (screenOffMs * 100 / ms).toInt().coerceIn(0, 100))
            .put("opt", optimized)
        val list = try { JSONArray(p.getString("battery", "[]")) } catch (e: Exception) { JSONArray() }
        list.put(one)
        while (list.length() > MAX_BATTERY) list.remove(0)
        p.edit().putString("battery", list.toString()).apply()
    }

    // ---- read once by the app ------------------------------------------------

    /**
     * Everything noted since the last read: {"exits": [...], "battery": [...]}.
     * Each exit is {t: crash|killed, c: cause, d: {...}}.
     */
    @Synchronized
    fun collect(ctx: Context): Map<String, Any> {
        val app = ctx.applicationContext
        val p = prefs(app)
        val exits = mutableListOf<Map<String, Any>>()
        val javaCrash = p.getString("java_crash", null)
        var javaUsed = false
        if (Build.VERSION.SDK_INT >= 30) {
            javaUsed = exitsSince(app, javaCrash, exits)
        } else {
            val m = marker(app)
            val boot = System.currentTimeMillis() - SystemClock.elapsedRealtime()
            if (m.exists() && PleatVpnService.instance == null && m.lastModified() > boot) {
                exits.add(mapOf("t" to "killed", "c" to "unclean", "d" to mapOf("tunnel" to true)))
                tunnelStopped(app)
            }
        }
        if (javaCrash != null && !javaUsed) {
            exits.add(mapOf("t" to "crash", "c" to "java", "d" to mapOf("trace" to javaCrash)))
        }
        val battery = mutableListOf<Map<String, Any>>()
        try {
            val list = JSONArray(p.getString("battery", "[]"))
            for (i in 0 until list.length()) {
                val o = list.getJSONObject(i)
                battery.add(mapOf(
                    "rate" to o.optDouble("rate", 0.0), "drop" to o.optInt("drop"), "min" to o.optInt("min"),
                    "off" to o.optInt("off"), "opt" to o.optBoolean("opt"),
                ))
            }
        } catch (e: Exception) {}
        p.edit().remove("java_crash").remove("java_crash_at").remove("battery").apply()
        return mapOf("exits" to exits, "battery" to battery)
    }

    /** Android 11+: the process exits since the last read, into [out]; true when the Kotlin crash was used. */
    @android.annotation.TargetApi(30)
    private fun exitsSince(app: Context, javaCrash: String?, out: MutableList<Map<String, Any>>): Boolean {
        var javaUsed = false
        val p = prefs(app)
        try {
            val am = app.getSystemService(ActivityManager::class.java)
            val infos = am?.getHistoricalProcessExitReasons(app.packageName, 0, 8).orEmpty()
            val newest = infos.maxOfOrNull { it.timestamp } ?: 0L
            if (!p.contains("exit_seen")) {
                // first run of this feature: the old history is not news
                p.edit().putLong("exit_seen", maxOf(newest, 1L)).apply()
                return false
            }
            val seen = p.getLong("exit_seen", 0L)
            for (info in infos.filter { it.timestamp > seen }.sortedBy { it.timestamp }) {
                val e = exitOf(info, javaCrash) ?: continue
                if (e["c"] == "java" && javaCrash != null) javaUsed = true
                out.add(e)
            }
            if (newest > seen) p.edit().putLong("exit_seen", newest).apply()
        } catch (e: Exception) {
            // no history on this phone
        }
        return javaUsed
    }

    @android.annotation.TargetApi(30)
    private fun exitOf(info: ApplicationExitInfo, javaCrash: String?): Map<String, Any>? {
        // the VPN (a foreground service) or the screen was running when the process ended
        val running = info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE
        val d = mutableMapOf<String, Any>(
            "reason" to info.reason,
            "status" to info.status,
            "tunnel" to running,
            "pss" to (info.pss / 1024).toInt(),
        )
        info.description?.let { d["what"] = blank(it).take(120) }
        val (t, c) = when (info.reason) {
            ApplicationExitInfo.REASON_CRASH -> "crash" to "java"
            ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash" to "native"
            ApplicationExitInfo.REASON_ANR -> "crash" to "anr"
            ApplicationExitInfo.REASON_LOW_MEMORY -> "killed" to "low_memory"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "killed" to "excessive"
            ApplicationExitInfo.REASON_SIGNALED -> "killed" to "signaled"
            ApplicationExitInfo.REASON_OTHER -> "killed" to "other"
            14 /* REASON_FREEZER, Android 13 */ -> "killed" to "other"
            else -> return null // the app's own exit, a force stop, an update ...
        }
        // Android ending a process that showed nothing is normal; only a running VPN counts
        if (t == "killed" && !running) return null
        if (c == "java" && javaCrash != null) d["trace"] = javaCrash
        if (c == "anr") anrTrace(info)?.let { d["trace"] = it }
        return mapOf("t" to t, "c" to c, "d" to d)
    }

    /** The main thread's first frames from an ANR report. */
    @android.annotation.TargetApi(30)
    private fun anrTrace(info: ApplicationExitInfo): String? = try {
        info.traceInputStream?.bufferedReader()?.use { r ->
            val lines = r.readLines().take(4000)
            val i = lines.indexOfFirst { it.startsWith("\"main\"") }
            if (i < 0) null else blank(lines.drop(i).take(10).joinToString(" | ") { it.trim() }).take(400)
        }
    } catch (e: Exception) {
        null
    }
}
