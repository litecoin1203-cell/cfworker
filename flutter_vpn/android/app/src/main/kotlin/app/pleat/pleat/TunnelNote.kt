package app.pleat.pleat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.widget.RemoteViews

/**
 * The ongoing notification while the tunnel runs: the "Pleat card".
 *
 * Collapsed: flag tile, a green "Protected" dot, "City, Country" and the
 * session timer, and a round Disconnect button. Expanded: the same top
 * row, the exit's public IP and protocol, and Disconnect / Change
 * location buttons, with Pleat's blue shard along the right edge.
 *
 * Colours come from `note_*` resources with a `values-night` set, so the
 * card follows the phone's own light or dark shade. The timer is a
 * Chronometer that Android counts itself: the card is rebuilt only when
 * the tunnel's state or the exit's details change, never on a timer.
 */
object TunnelNote {
    const val ID = 7

    /** Extra on the activity intent: which screen the card's button asked for. */
    const val EXTRA_OPEN = "app.pleat.OPEN"
    private const val CHANNEL = "tunnel"

    /** What the app last said about the exit in use. Text is English only. */
    data class Info(
        val flag: String = "",
        val place: String = "",
        val ip: String = "",
        val protocol: String = "",
        /** Wall-clock ms the session came up; 0 when not known. */
        val since: Long = 0,
    )

    @Volatile
    var info = Info()

    fun channel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "VPN status", NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
            }
        )
    }

    /** [up] is false while connecting: the card says so and the button cancels. */
    fun build(context: Context, up: Boolean, upSince: Long): Notification {
        channel(context)
        val i = info
        val flag = i.flag.ifEmpty { "🌐" }
        val place = i.place.ifEmpty { "Finding your exit" }
        val title = if (up) "Protected" else "Connecting"
        // Chronometer counts from an elapsedRealtime() base.
        val started = if (i.since > 0) i.since else upSince
        val base = SystemClock.elapsedRealtime() - (System.currentTimeMillis() - started).coerceAtLeast(0)

        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val disconnect = PendingIntent.getService(
            context, 1,
            Intent(context, PleatVpnService::class.java).setAction(PleatVpnService.ACTION_DISCONNECT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val locations = PendingIntent.getActivity(
            context, 2,
            Intent(context, MainActivity::class.java)
                .putExtra(EXTRA_OPEN, "locations")
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        fun RemoteViews.top() {
            setTextViewText(R.id.note_flag, flag)
            setTextViewText(R.id.note_title, title)
            setImageViewResource(R.id.note_dot, if (up) R.drawable.note_dot else R.drawable.note_dot_wait)
            // The Chronometer's format carries the place, so the timer sits
            // right after it in one line.
            val safe = place.replace("%", "%%")
            if (up) setChronometer(R.id.note_place, base, "$safe · %s", true)
            else setChronometer(R.id.note_place, base, safe, false)
        }

        val small = RemoteViews(context.packageName, R.layout.note_small).apply {
            top()
            setOnClickPendingIntent(R.id.note_power, disconnect)
            setContentDescription(R.id.note_power, if (up) "Disconnect" else "Cancel")
        }
        val big = RemoteViews(context.packageName, R.layout.note_big).apply {
            top()
            setTextViewText(R.id.note_ip, i.ip.ifEmpty { "Checking…" })
            setTextViewText(R.id.note_protocol, i.protocol.ifEmpty { "—" })
            setTextViewText(R.id.note_disconnect_label, if (up) "Disconnect" else "Cancel")
            setOnClickPendingIntent(R.id.note_disconnect, disconnect)
            setOnClickPendingIntent(R.id.note_locations, locations)
        }

        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL)
        else @Suppress("DEPRECATION") Notification.Builder(context)
        b.setSmallIcon(R.drawable.ic_note)
            .setColor(context.getColor(R.color.note_blue))
            .setContentTitle(if (up) "Protected · $place" else "Connecting")
            .setContentText(if (up && i.ip.isNotEmpty()) "IP ${i.ip}" else place)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            b.setStyle(Notification.DecoratedCustomViewStyle())
                .setCustomContentView(small)
                .setCustomBigContentView(big)
        } else {
            @Suppress("DEPRECATION")
            b.setContent(small)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        return b.build()
    }
}
