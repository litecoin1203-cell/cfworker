package app.pleat.pleat

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import java.io.File

/**
 * Every step of a widget start, written to disk as it happens, so the next
 * app launch can say exactly where a widget start stopped, even when the
 * process was killed (not crashed) and Android's crash records say nothing.
 *
 * A trail opens on the widget tap and lives at most [LIVE_MS]; steps outside
 * one are not written. On the next read: a trail that never reached "up" is
 * reported (crash · widget) with its steps and Android's raw exit records
 * since the tap, unfiltered. Step names only; never an address or a key.
 */
object WidgetTrail {
    private const val LIVE_MS = 3 * 60_000L
    private fun file(ctx: Context) = File(ctx.applicationContext.noBackupFilesDir, "widget-trail.txt")

    @Synchronized
    fun begin(ctx: Context) {
        try { file(ctx).writeText("${System.currentTimeMillis()}\ntap+0\n") } catch (e: Exception) {}
    }

    @Synchronized
    fun step(ctx: Context, name: String) {
        try {
            val f = file(ctx)
            if (!f.exists()) return
            val start = f.bufferedReader().use { it.readLine() }?.toLongOrNull() ?: return
            val ms = System.currentTimeMillis() - start
            if (ms > LIVE_MS) return
            f.appendText("${name.take(48).replace(Regex("[^A-Za-z0-9_:.+-]"), "_")}+$ms\n")
        } catch (e: Exception) {}
    }

    fun step(ctx: Context, name: String, e: Throwable) = step(ctx, "$name:${e.javaClass.simpleName}")

    /** Once, by the app: the last widget start, if it never came up. */
    @Synchronized
    fun collect(ctx: Context, out: MutableList<Map<String, Any>>) {
        val f = file(ctx)
        if (!f.exists()) return
        // still going (the app opened mid-start): read it next time
        val age = System.currentTimeMillis() - f.lastModified()
        if (PleatVpnService.instance != null && age < LIVE_MS) return
        val lines = try { f.readLines() } catch (e: Exception) { emptyList() }
        try { f.delete() } catch (e: Exception) {}
        val start = lines.firstOrNull()?.toLongOrNull() ?: return
        val steps = lines.drop(1).filter { it.isNotBlank() }
        if (steps.any { it.startsWith("up+") }) return
        val d = linkedMapOf<String, Any>(
            "stage" to (steps.lastOrNull()?.substringBefore('+') ?: "tap"),
            "trace" to "widget: " + steps.joinToString(" "),
        )
        exitsSince(ctx, start)?.let { d["what"] = it }
        d["tunnel"] = false
        out.add(mapOf("t" to "crash", "c" to "widget", "d" to d))
    }

    /** Android's own records of how the process ended since [start], raw: reason/status/importance. */
    private fun exitsSince(ctx: Context, start: Long): String? {
        if (Build.VERSION.SDK_INT < 30) return null
        return try {
            val am = ctx.applicationContext.getSystemService(ActivityManager::class.java) ?: return null
            am.getHistoricalProcessExitReasons(ctx.packageName, 0, 8)
                .filter { it.timestamp >= start - 1000 }
                .sortedBy { it.timestamp }
                .joinToString(" ; ") { i ->
                    "r${i.reason}/s${i.status}/i${i.importance} +${i.timestamp - start}ms ${i.description.orEmpty().take(40)}"
                }
                .ifEmpty { "no exit record" }
        } catch (e: Exception) {
            null
        }
    }
}
