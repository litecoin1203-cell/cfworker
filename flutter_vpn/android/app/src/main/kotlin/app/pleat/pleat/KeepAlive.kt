package app.pleat.pleat

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Keeping the tunnel alive against the phone's own battery savers. Android
 * may close a VPN to save battery unless Pleat runs without limits, and
 * Xiaomi phones (MIUI / HyperOS) add a cleaner ("OneKeyClean", the Clear all
 * button in Recents) and an Autostart switch that close it as well. Only the
 * person can lift these; this opens the right page.
 */
object KeepAlive {
    /** True when Android lets Pleat run without battery limits. */
    fun exempt(ctx: Context): Boolean = try {
        val pm = ctx.applicationContext.getSystemService(PowerManager::class.java)
        pm == null || pm.isIgnoringBatteryOptimizations(ctx.packageName)
    } catch (e: Exception) {
        true
    }

    /** Xiaomi, Redmi and POCO all run Xiaomi's cleaner and Autostart switch. */
    fun xiaomi(): Boolean = listOf(Build.MANUFACTURER, Build.BRAND).any {
        it.equals("Xiaomi", true) || it.equals("Redmi", true) || it.equals("POCO", true)
    }

    /** Android's own "let this app run in the background?" question; its battery list when that can't open. */
    @SuppressLint("BatteryLife") // a VPN is the case Android names for this request
    fun askExempt(a: Activity) {
        val tries = listOf(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + a.packageName)),
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            appPage(a),
        )
        open(a, tries)
    }

    /** Xiaomi's Autostart list; Pleat's own app page (where Autostart also sits on newer HyperOS) otherwise. */
    fun openAutostart(a: Activity) {
        val tries = listOf(
            Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")),
            Intent("miui.intent.action.OP_AUTO_START").addCategory(Intent.CATEGORY_DEFAULT),
            appPage(a),
        )
        open(a, tries)
    }

    private fun appPage(a: Activity) =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + a.packageName))

    private fun open(a: Activity, tries: List<Intent>) {
        for (i in tries) {
            try {
                a.startActivity(i)
                return
            } catch (e: Exception) {
                // not on this phone: the next one
            }
        }
    }
}
