package app.pleat.pleat

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import java.io.File

/**
 * The 4×1 "Status strip" home-screen widget: flag, place, IP and session
 * timer, and a switch. One tap connects or disconnects without opening
 * the app.
 *
 * Connect reuses the last exit's config (the same file Android's
 * always-on start uses), so the service starts straight from the widget.
 * When that can't work (no exit used yet, or Android's VPN permission is
 * not granted to Pleat right now) the tap opens the app, which connects.
 *
 * The widget is redrawn only when the tunnel's state or the exit's details
 * change; the timer is a Chronometer Android counts itself. Colours come
 * from `widget_*` / `note_*` resources with a `values-night` set, so it
 * follows the phone's light or dark mode. Text is English only.
 */
class StatusWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        manager.updateAppWidget(ids, views(context))
    }

    companion object {
        const val ACTION_WIDGET_START = "app.pleat.WIDGET_START"
        private const val PREFS = "pleat_widget"

        /** Wall-clock ms the running session came up; 0 when not up. */
        @Volatile
        var upSince = 0L

        /** Redraws every placed widget. Cheap; safe from any thread. */
        fun refresh(context: Context) {
            val app = context.applicationContext
            try {
                val manager = AppWidgetManager.getInstance(app) ?: return
                val ids = manager.getAppWidgetIds(ComponentName(app, StatusWidget::class.java))
                if (ids.isEmpty()) return
                manager.updateAppWidget(ids, views(app))
            } catch (e: Exception) {
                // No widget host (some launchers, tests): nothing to draw.
            }
        }

        /** The exit the app last named, kept for the "off" line and a widget start. */
        fun remember(context: Context, flag: String, place: String) {
            if (place.isEmpty()) return
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("flag", flag)
                .putString("place", place)
                .apply()
        }

        /** What the notification card shows on a start the app didn't make. */
        fun lastInfo(context: Context): TunnelNote.Info {
            val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return TunnelNote.Info(
                flag = p.getString("flag", "").orEmpty(),
                place = p.getString("place", "").orEmpty(),
            )
        }

        /** Sign-out: no exit is left for the widget to start. */
        fun forget(context: Context) {
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
            try { lastConfig(context).delete() } catch (e: Exception) {}
            refresh(context)
        }

        fun lastConfig(context: Context) = File(context.noBackupFilesDir, "last-config.json")

        /** A tap can start the tunnel by itself: an exit to reuse and Android's consent in hand. */
        private fun canStart(context: Context): Boolean = try {
            lastConfig(context).exists() && VpnService.prepare(context) == null
        } catch (e: Exception) {
            false
        }

        private fun views(context: Context): RemoteViews {
            val v = RemoteViews(context.packageName, R.layout.widget_strip)
            val state = TunnelHub.state
            val info = TunnelNote.info
            val last = lastInfo(context)
            val flag = info.flag.ifEmpty { last.flag }
            val place = info.place.ifEmpty { last.place }
            val now = SystemClock.elapsedRealtime()

            fun face(showFlag: Boolean) {
                val f = showFlag && flag.isNotEmpty()
                v.setViewVisibility(R.id.widget_flag, if (f) View.VISIBLE else View.GONE)
                v.setViewVisibility(R.id.widget_mark, if (f) View.GONE else View.VISIBLE)
                if (f) v.setTextViewText(R.id.widget_flag, flag)
            }

            fun line(text: String) = v.setChronometer(R.id.widget_sub, now, text.replace("%", "%%"), false)

            when (state) {
                "up" -> {
                    face(true)
                    v.setTextViewText(R.id.widget_title, place.ifEmpty { "Protected" })
                    val started = when {
                        info.since > 0 -> info.since
                        upSince > 0 -> upSince
                        else -> System.currentTimeMillis()
                    }
                    val base = now - (System.currentTimeMillis() - started).coerceAtLeast(0)
                    val lead = if (info.ip.isNotEmpty()) "IP ${info.ip}" else "Protected"
                    v.setChronometer(R.id.widget_sub, base, "${lead.replace("%", "%%")} · %s", true)
                    v.setInt(R.id.widget_switch, "setBackgroundResource", R.drawable.widget_switch_on)
                    v.setContentDescription(R.id.widget_switch, "Connected. Tap to disconnect")
                    v.setOnClickPendingIntent(R.id.widget_root, disconnect(context))
                }
                "starting" -> {
                    face(true)
                    v.setTextViewText(R.id.widget_title, "Connecting…")
                    line(place.ifEmpty { "Finding your exit" })
                    v.setInt(R.id.widget_switch, "setBackgroundResource", R.drawable.widget_switch_wait)
                    v.setContentDescription(R.id.widget_switch, "Connecting. Tap to cancel")
                    v.setOnClickPendingIntent(R.id.widget_root, disconnect(context))
                }
                "failed" -> {
                    face(false)
                    v.setTextViewText(R.id.widget_title, "Couldn’t connect")
                    line("Tap to open Pleat")
                    v.setInt(R.id.widget_switch, "setBackgroundResource", R.drawable.widget_switch_off)
                    v.setContentDescription(R.id.widget_switch, "Not connected. Tap to open Pleat")
                    v.setOnClickPendingIntent(R.id.widget_root, openApp(context))
                }
                else -> {
                    face(false)
                    v.setTextViewText(R.id.widget_title, "Not protected")
                    line(if (place.isNotEmpty()) "Tap to connect · $place" else "Tap to connect")
                    v.setInt(R.id.widget_switch, "setBackgroundResource", R.drawable.widget_switch_off)
                    v.setContentDescription(R.id.widget_switch, "Not connected. Tap to connect")
                    v.setOnClickPendingIntent(
                        R.id.widget_root,
                        if (canStart(context)) start(context) else openApp(context)
                    )
                }
            }
            return v
        }

        private const val FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

        private fun start(context: Context): PendingIntent {
            val i = Intent(context, PleatVpnService::class.java).setAction(ACTION_WIDGET_START)
            // A tap on a widget may start a foreground service from the background.
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PendingIntent.getForegroundService(context, 40, i, FLAGS)
            } else {
                PendingIntent.getService(context, 40, i, FLAGS)
            }
        }

        private fun disconnect(context: Context): PendingIntent = PendingIntent.getService(
            context, 41,
            Intent(context, PleatVpnService::class.java).setAction(PleatVpnService.ACTION_DISCONNECT),
            FLAGS
        )

        /** The app opens and connects (first time: Android asks for the VPN permission there). */
        private fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
            context, 42,
            Intent(context, MainActivity::class.java)
                .putExtra(TunnelNote.EXTRA_OPEN, "connect")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            FLAGS
        )
    }
}
