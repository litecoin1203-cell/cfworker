package app.pleat.pleat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import java.io.ByteArrayOutputStream

/**
 * The apps on this phone a person can open (launcher apps), for Route >
 * Split route > Apps that skip the VPN: package, name and a small icon.
 * Only launcher apps are visible to Pleat (the manifest's <queries>), which
 * is all a person would pick from; nothing is sent anywhere.
 */
object Apps {
    private const val ICON_PX = 72

    fun list(context: Context): List<Map<String, Any>> {
        val pm = context.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        @Suppress("DEPRECATION")
        val found = pm.queryIntentActivities(launcher, 0)
        val seen = HashSet<String>()
        val out = ArrayList<Map<String, Any>>()
        for (ri in found) {
            val pkg = ri.activityInfo?.packageName ?: continue
            if (pkg == context.packageName || !seen.add(pkg)) continue
            val name = try { ri.loadLabel(pm).toString() } catch (e: Exception) { pkg }
            val icon = try { png(ri.loadIcon(pm)) } catch (e: Throwable) { ByteArray(0) }
            out.add(mapOf("id" to pkg, "name" to name, "icon" to icon))
        }
        out.sortBy { (it["name"] as String).lowercase() }
        return out
    }

    private fun png(d: android.graphics.drawable.Drawable): ByteArray {
        val bmp = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        d.setBounds(0, 0, ICON_PX, ICON_PX)
        d.draw(c)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        return out.toByteArray()
    }
}

/**
 * A question from Pleat when it isn't on screen: "No Germany exit
 * answered. Use the Netherlands?" Tapping it opens the app on Home's
 * Route, where the same question waits as a popup. English only.
 */
object Alert {
    const val ID = 9
    private const val CHANNEL = "ask"

    fun show(context: Context, title: String, text: String) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Questions from Pleat", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        val open = PendingIntent.getActivity(
            context, 3,
            Intent(context, MainActivity::class.java)
                .putExtra(TunnelNote.EXTRA_OPEN, "route")
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
        }
        nm.notify(
            ID,
            b.setSmallIcon(R.drawable.ic_note)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
        )
    }

    fun clear(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(ID)
    }
}
