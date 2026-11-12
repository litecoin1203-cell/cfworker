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
import android.system.Os
import android.system.OsConstants
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
 *  - For a native crash (the Xray core, the tun, Flutter's engine): what
 *    the crash itself says (CrashNotes): the signal, libc's abort message,
 *    the library and functions it died in, and Go's panic line, from
 *    Android's tombstone (12+) and from the core's own stderr, which is
 *    kept in a file for that (it went nowhere before). Plus what the tunnel
 *    was doing then: the exit's protocol, starting / up / stopping, and for
 *    how long it had been up.
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

    /**
     * Code names only (a tombstone's library and function names): links, ids
     * and addresses still go, but "runtime.raise" or a long C function name
     * is not a host or a key and stays readable.
     */
    fun blankCode(text: String): String = text
        .replace(Regex("[a-zA-Z][a-zA-Z0-9+.-]{1,15}://\\S+"), "<link>")
        .replace(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"), "<id>")
        .replace(Regex("\\[[0-9a-fA-F:]+\\](:\\d+)?"), "<ip>")
        .replace(Regex("\\b\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?\\b"), "<ip>")

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

    /**
     * Android refused to let the tunnel's service come to the front. Not a
     * crash any more, but reported like one (crash · java) with its text,
     * so the health report shows why a widget start did nothing.
     */
    fun startRefused(ctx: Context, e: Throwable) {
        startFailed(e)
        try {
            val text = blank("start refused: ${e.javaClass.name}: ${e.message.orEmpty()}").take(600)
            prefs(ctx.applicationContext).edit()
                .putString("java_crash", text)
                .putLong("java_crash_at", System.currentTimeMillis())
                .apply()
        } catch (x: Exception) {}
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
        captureStderr(app)
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

    // ---- the core's stderr: Go's crash text ----------------------------------

    private const val STDERR_CAP = 1L shl 20

    private fun stderrFile(ctx: Context) = File(ctx.applicationContext.noBackupFilesDir, "core-stderr.log")

    /**
     * Go writes why it crashed (an unhandled panic in the core aborts the
     * whole app) to stderr, which on Android goes nowhere. Pointed at a file
     * instead; the last process's file is read here first: a Go crash in it
     * is kept for the next report, then the file starts empty. Only the
     * core's few start notes and a crash ever land in it (Xray's own log is
     * stdout, hev's goes to /dev/null).
     */
    private fun captureStderr(app: Context) {
        val file = stderrFile(app)
        try {
            if (file.length() > 0) {
                val text = file.inputStream().use { input ->
                    val buf = ByteArray(minOf(file.length(), STDERR_CAP).toInt())
                    var n = 0
                    while (n < buf.size) {
                        val r = input.read(buf, n, buf.size - n)
                        if (r < 0) break
                        n += r
                    }
                    String(buf, 0, n, Charsets.UTF_8)
                }
                CrashNotes.goPanic(text)?.let { line ->
                    prefs(app).edit()
                        .putString("go_crash", blank(line).take(300))
                        .putLong("go_crash_at", file.lastModified())
                        .commit()
                }
            }
        } catch (e: Exception) {
            // nothing to learn from it
        }
        try {
            val fd = Os.open(
                file.absolutePath,
                OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_TRUNC or OsConstants.O_APPEND,
                0x180, // 0600
            )
            try {
                Os.dup2(fd, 2)
            } finally {
                Os.close(fd)
            }
        } catch (e: Exception) {
            // stderr stays where it was; only Go's crash line is missed
        }
    }

    /** Called at each tunnel start: the file never grows past a megabyte. */
    fun trimStderr(ctx: Context) {
        try {
            if (stderrFile(ctx).length() > STDERR_CAP) Os.ftruncate(java.io.FileDescriptor.err, 0)
        } catch (e: Exception) {}
    }

    // ---- what the tunnel was doing ------------------------------------------

    /**
     * The tunnel's state, kept on disk at each change, so a crash report can
     * say which exit (its anonymous key), which protocol, and whether it was
     * starting, up (for how long) or stopping. [key] and [proto] only from
     * the app's own "pleat" note in the config; never an address.
     */
    fun tunnelState(ctx: Context, op: String, key: String? = null, proto: String? = null) {
        try {
            val e = prefs(ctx).edit().putString("t_op", op).putLong("t_at", System.currentTimeMillis())
            if (key != null) e.putString("t_k", key.takeIf { KEY.matches(it) } ?: "")
            if (proto != null) e.putString("t_p", proto.takeIf { PROTO.matches(it) } ?: "")
            if (op == "up") e.putLong("t_up", System.currentTimeMillis())
            e.apply()
        } catch (e: Exception) {}
    }

    private val KEY = Regex("^[a-z0-9]{6,16}$")
    private val PROTO = Regex("^[a-z0-9/ ,+-]{1,80}$")

    /** What the tunnel was doing at [at] (an exit's time), into [d]. */
    private fun tunnelAt(app: Context, at: Long, d: MutableMap<String, Any>) {
        val p = prefs(app)
        val since = p.getLong("t_at", 0L)
        if (since == 0L || since > at) return // nothing noted before it ended
        val op = p.getString("t_op", "").orEmpty()
        if (op.isEmpty()) return
        d["op"] = op
        p.getString("t_p", "")?.takeIf { it.isNotEmpty() }?.let { d["proto"] = it }
        if (op != "off") p.getString("t_k", "")?.takeIf { it.isNotEmpty() }?.let { d["k"] = it }
        val up = p.getLong("t_up", 0L)
        if (op == "up" && up in 1..at) d["up_s"] = ((at - up) / 1000).toInt()
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
        install(app)
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
        val goCrash = p.getString("go_crash", null)
        if (goCrash != null && exits.none { it["c"] == "native" }) {
            // a Go crash Android named no exit for (below 11, or history gone): still a crash
            exits.add(mapOf("t" to "crash", "c" to "native", "d" to mapOf("go" to goCrash)))
        }
        p.edit().remove("java_crash").remove("java_crash_at").remove("go_crash").remove("go_crash_at").remove("battery").apply()
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
            // Once: native crashes of the last week that were reported before
            // their tombstone was read (Pleat 1.2.35 to 1.2.37), with what it says now.
            if (!p.contains("native_back")) {
                p.edit().putBoolean("native_back", true).apply()
                val week = System.currentTimeMillis() - 7 * 86400_000L
                // all Android still keeps, not just the last 8: other exits (a swipe, an update) push it down
                val kept = try { am?.getHistoricalProcessExitReasons(app.packageName, 0, 0).orEmpty() } catch (e: Exception) { infos }
                for (info in kept.filter { it.timestamp in week..seen && it.reason == ApplicationExitInfo.REASON_CRASH_NATIVE }) {
                    val e = exitOf(app, info, null, earlier = true) ?: continue
                    out.add(e)
                }
            }
            for (info in infos.filter { it.timestamp > seen }.sortedBy { it.timestamp }) {
                val e = exitOf(app, info, javaCrash) ?: continue
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
    private fun exitOf(app: Context, info: ApplicationExitInfo, javaCrash: String?, earlier: Boolean = false): Map<String, Any>? {
        // the VPN (a foreground service) or the screen was running when the process ended
        val running = info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE
        // most telling first: the Worker drops the last ones when it runs out of room
        val d = linkedMapOf<String, Any>(
            "reason" to info.reason,
            "status" to info.status,
        )
        if (info.reason == ApplicationExitInfo.REASON_CRASH_NATIVE) nativeCrash(app, info, d)
        d["tunnel"] = running
        d["pss"] = (info.pss / 1024).toInt()
        info.description?.let { d["what"] = blank(it).take(120) }
        tunnelAt(app, info.timestamp, d)
        if (earlier) d["earlier"] = true
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

    /**
     * What a native crash says about itself: the signal by name, then (12+)
     * the tombstone's abort message, library, functions and Go panic line,
     * and Go's own line from stderr when it ended at the same time.
     */
    @android.annotation.TargetApi(30)
    private fun nativeCrash(app: Context, info: ApplicationExitInfo, d: MutableMap<String, Any>) {
        CrashNotes.SIGNALS[info.status]?.let { d["sig"] = it }
        if (Build.VERSION.SDK_INT >= 31) {
            // "tomb" says what Android gave, so a report without details tells
            // "Android kept no tombstone" apart from "Pleat could not read it"
            try {
                val input = info.traceInputStream
                if (input == null) {
                    d["tomb"] = "none"
                } else input.use {
                    // usually well under 2 MB; a bigger one is read as far as
                    // 4 MB, and the signal and abort message come first
                    val bytes = ByteArray(4 shl 20)
                    var n = 0
                    while (n < bytes.size) {
                        val r = it.read(bytes, n, bytes.size - n)
                        if (r < 0) break
                        n += r
                    }
                    val notes = CrashNotes.tombstone(CrashNotes.unpack(bytes.copyOf(n)))
                    d["tomb"] = CrashNotes.tombState(bytes.copyOf(minOf(n, 4)), n, notes.size)
                    for ((k, v) in notes) {
                        d[k] = when (k) {
                            "frames" -> blankCode(v).take(400)
                            "go" -> blank(v).take(300)
                            "thread", "lib" -> blankCode(v).take(40)
                            else -> blank(v).take(160)
                        }
                    }
                }
            } catch (e: Exception) {
                d["tomb"] = "error ${e.javaClass.simpleName}".take(40)
            }
        }
        val p = prefs(app)
        val go = p.getString("go_crash", null)
        val at = p.getLong("go_crash_at", 0L)
        // the stderr file was last written as the process died
        if (go != null && Math.abs(at - info.timestamp) < 120_000L) d["go"] = go
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
