package app.pleat.pleat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.drawable.Icon
import android.database.MatrixCursor
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.View
import android.widget.RemoteViews
import java.io.File
import java.security.MessageDigest

/**
 * The native half of Pleat's in-app update (Dart: `lib/state/updater.dart`).
 * Dart downloads the APK into [dir]; this side tells which build and phone
 * type are installed, checks the file's SHA-256, asks for "Install unknown
 * apps" once, and hands the file to Android's installer. Android itself
 * refuses an APK signed with another key, so only Pleat's own builds go in.
 */
object Updates {
    /** A new build: pops up once (high), unlike the old quiet "updates" channel. */
    private const val CHANNEL = "update_news"
    private const val OLD_CHANNEL = "updates"
    private const val NOTE_ID = 8
    private val ABIS = listOf("arm64-v8a", "armeabi-v7a", "x86_64")

    fun dir(context: Context): File = File(context.filesDir, "update").apply { mkdirs() }

    /**
     * versionName, the pubspec build number and the phone type to download.
     * A per-phone-type APK has 1000 x the type's number added to its version
     * code (Flutter's split-per-abi), so the build is the code modulo 1000.
     */
    fun info(context: Context): Map<String, Any> {
        @Suppress("DEPRECATION")
        val p = context.packageManager.getPackageInfo(context.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else p.versionCode.toLong()
        val abi = Build.SUPPORTED_ABIS.firstOrNull { it in ABIS } ?: ""
        return mapOf("version" to (p.versionName ?: ""), "build" to (code % 1000).toInt(), "abi" to abi)
    }

    fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Android 8+ asks once per app before it may open the installer. */
    fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    /** Pleat's own "Install unknown apps" switch. */
    fun allowInstalls(context: Context) {
        val intent = if (Build.VERSION.SDK_INT >= 26) {
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        } else {
            Intent(Settings.ACTION_SECURITY_SETTINGS)
        }
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Opens Android's installer on [file], which must be inside [dir]. */
    fun install(context: Context, file: File): Boolean {
        if (!file.isFile || file.parentFile?.canonicalPath != dir(context).canonicalPath) return false
        val uri = Uri.parse("content://${context.packageName}.apk/${Uri.encode(file.name)}")
        context.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, ApkProvider.MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        return true
    }

    /** Stop on the notification, handed to the Dart side while the app runs. */
    @Volatile
    var onAction: ((String) -> Unit)? = null

    /** Quiet updates while it downloads; the announcement itself may alert. */
    private const val CHANNEL_QUIET = "update_progress"

    /**
     * The update notification (Dart: Updater._note). One card from the
     * announcement to the installer: title, line, the three-part track
     * (Download, Check, Install) with the Pleat mark riding it, and the
     * next step's button. Android 16 draws the track itself as a Live
     * Update (ProgressStyle) with the % in the status bar; older phones get
     * the same track painted by [track].
     */
    fun note(context: Context, a: Map<String, Any?>) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        val stage = a["stage"] as? String ?: "offer"
        if (stage == "cancel") {
            nm.cancel(NOTE_ID)
            return
        }
        val alert = a["alert"] == true
        val title = a["title"] as? String ?: ""
        val text = a["text"] as? String ?: ""
        val side = a["side"] as? String ?: ""
        val action = a["action"] as? String ?: ""
        val from = a["from"] as? String ?: ""
        val to = a["to"] as? String ?: ""
        val pct = (a["pct"] as? Number)?.toInt()?.coerceIn(0, 100) ?: 0
        val stageNo = (a["track"] as? Number)?.toInt()?.coerceIn(0, 2) ?: 0
        val force = a["force"] == true
        val running = stage == "download" || stage == "check"

        if (Build.VERSION.SDK_INT >= 26) {
            nm.deleteNotificationChannel(OLD_CHANNEL)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "New versions", NotificationManager.IMPORTANCE_HIGH)
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_QUIET, "Update progress", NotificationManager.IMPORTANCE_LOW)
            )
        }
        fun open(code: Int, screen: String) = PendingIntent.getActivity(
            context, code,
            Intent(context, MainActivity::class.java)
                .putExtra(TunnelNote.EXTRA_OPEN, screen)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        fun broadcast(code: Int, what: String) = PendingIntent.getBroadcast(
            context, code,
            Intent(context, UpdateActions::class.java).setAction(what),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val sheet = open(3, "update")
        // Stop works in place; every other step needs the app (the download
        // and the installer run there).
        val go = if (running) broadcast(5, UpdateActions.STOP) else open(4, "update_go")
        val later = broadcast(6, UpdateActions.LATER)

        val b = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(context, if (alert) CHANNEL else CHANNEL_QUIET)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }
        b.setSmallIcon(R.drawable.ic_note)
            .setColor(context.getColor(R.color.note_blue))
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(sheet)
            .setOnlyAlertOnce(!alert)
            .setShowWhen(false)
            .setOngoing(running || force)
            .setAutoCancel(!running && !force)
            .setCategory(if (running) Notification.CATEGORY_PROGRESS else Notification.CATEGORY_RECOMMENDATION)
        if (running) b.setSubText("$pct%")

        if (Build.VERSION.SDK_INT >= 36) {
            // Android 16: the system's own segmented line and Live Update chip.
            val blue = context.getColor(R.color.note_blue)
            val style = Notification.ProgressStyle()
                .setStyledByProgress(true)
                .setProgressSegments(
                    listOf(
                        Notification.ProgressStyle.Segment(70).setColor(blue),
                        Notification.ProgressStyle.Segment(15).setColor(blue),
                        Notification.ProgressStyle.Segment(15).setColor(blue),
                    )
                )
                .setProgress(
                    when (stageNo) {
                        0 -> (70 * pct) / 100
                        1 -> 78
                        else -> 100
                    }
                )
                .setProgressTrackerIcon(Icon.createWithResource(context, R.drawable.ic_note_tracker))
            b.setStyle(style)
            if (running) {
                b.setShortCriticalText("$pct%")
                b.extras.putBoolean("android.requestPromotedOngoing", true)
            }
            if (action.isNotEmpty()) {
                b.addAction(Notification.Action.Builder(null as Icon?, action, go).build())
            }
            if (stage == "offer" && !force) {
                b.addAction(Notification.Action.Builder(null as Icon?, "Later", later).build())
            }
        } else if (Build.VERSION.SDK_INT >= 24) {
            val small = RemoteViews(context.packageName, R.layout.note_upd_small).apply {
                setTextViewText(R.id.upd_title, title)
                setTextViewText(R.id.upd_text, if (running && side.isNotEmpty()) "$text · $side" else text)
                if (action.isEmpty()) {
                    setViewVisibility(R.id.upd_pill, View.GONE)
                } else {
                    setTextViewText(R.id.upd_pill, action.uppercase())
                    setOnClickPendingIntent(R.id.upd_pill, go)
                }
            }
            val big = RemoteViews(context.packageName, R.layout.note_upd_big).apply {
                setTextViewText(R.id.upd_title, title)
                setTextViewText(R.id.upd_text, text)
                setTextViewText(R.id.upd_side, side)
                setTextViewText(R.id.upd_from, from)
                setTextViewText(R.id.upd_to, to)
                setImageViewBitmap(R.id.upd_track, track(context, stageNo, pct / 100f))
                if (action.isEmpty()) {
                    setViewVisibility(R.id.upd_go, View.GONE)
                } else {
                    setTextViewText(R.id.upd_go, action)
                    setOnClickPendingIntent(R.id.upd_go, go)
                }
                if (stage == "offer" && !force) {
                    setOnClickPendingIntent(R.id.upd_later, later)
                } else {
                    setViewVisibility(R.id.upd_later, View.GONE)
                }
            }
            b.setStyle(Notification.DecoratedCustomViewStyle())
                .setCustomContentView(small)
                .setCustomBigContentView(big)
                .setCustomHeadsUpContentView(small)
        }
        try {
            nm.notify(NOTE_ID, b.build())
        } catch (e: SecurityException) {
            // Notifications not allowed: the card on Home still shows it.
        }
    }

    /** "Later": the card goes until the next build is announced. */
    fun dismiss(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(NOTE_ID)
    }

    /**
     * The three-part line as a picture: Download (70%), Check, Install,
     * filled to where the update is, with the Pleat mark on a blue dot at
     * the front. The gap around the dot is cut out, so it sits on any
     * shade colour.
     */
    fun track(context: Context, stage: Int, frac: Float): Bitmap {
        val dm = context.resources.displayMetrics
        val dp = dm.density
        val w = (dm.widthPixels - 88 * dp).toInt().coerceAtLeast((200 * dp).toInt())
        val h = (34 * dp).toInt()
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val blue = context.getColor(R.color.note_blue)
        val empty = context.getColor(R.color.note_track)
        val gap = 4 * dp
        val bar = 8 * dp
        val knob = 15 * dp
        val usable = w - 2 * gap
        val parts = floatArrayOf(0.70f, 0.15f, 0.15f)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        val cy = h / 2f
        var x = 0f
        val starts = FloatArray(3)
        for (i in 0..2) {
            val sw = usable * parts[i]
            starts[i] = x
            p.color = if (i < stage) blue else empty
            c.drawRoundRect(RectF(x, cy - bar / 2, x + sw, cy + bar / 2), bar / 2, bar / 2, p)
            if (i == 0 && stage == 0 && frac > 0f) {
                p.color = blue
                c.drawRoundRect(RectF(x, cy - bar / 2, x + sw * frac, cy + bar / 2), bar / 2, bar / 2, p)
            }
            x += sw + gap
        }
        val at = when (stage) {
            0 -> usable * parts[0] * frac
            1 -> starts[1] + usable * parts[1] / 2
            else -> w.toFloat()
        }.coerceIn(knob + 3 * dp, w - knob - 3 * dp)
        // a clear ring, then the dot
        p.xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
        c.drawCircle(at, cy, knob + 3 * dp, p)
        p.xfermode = null
        p.color = blue
        c.drawCircle(at, cy, knob, p)
        context.getDrawable(R.drawable.ic_note)?.let { d ->
            val r = (knob * 0.62f).toInt()
            d.setBounds((at - r).toInt(), (cy - r).toInt(), (at + r).toInt(), (cy + r).toInt())
            d.draw(c)
        }
        return bmp
    }
}

/** Stop and Later on the update notification. Not exported. */
class UpdateActions : BroadcastReceiver() {
    companion object {
        const val STOP = "app.pleat.pleat.update.STOP"
        const val LATER = "app.pleat.pleat.update.LATER"
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            STOP -> Updates.onAction?.invoke("stop")
            LATER -> Updates.dismiss(context)
        }
    }
}

/**
 * Serves the downloaded APK to Android's installer, read-only and only
 * from `files/update` (no androidx FileProvider needed). Not exported:
 * the installer reads it through the one-time grant on the intent.
 */
class ApkProvider : ContentProvider() {
    companion object {
        const val MIME = "application/vnd.android.package-archive"
    }

    private fun fileOf(uri: Uri): File? {
        val ctx = context ?: return null
        val name = uri.lastPathSegment ?: return null
        if (!name.endsWith(".apk") || name.contains('/')) return null
        val f = File(Updates.dir(ctx), name)
        return f.takeIf { it.isFile && it.parentFile?.canonicalPath == Updates.dir(ctx).canonicalPath }
    }

    override fun onCreate() = true

    override fun getType(uri: Uri) = MIME

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        if (mode != "r") throw SecurityException("read only")
        val f = fileOf(uri) ?: throw java.io.FileNotFoundException(uri.toString())
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? {
        val f = fileOf(uri) ?: return null
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(cols, 1).apply {
            addRow(cols.map { if (it == OpenableColumns.SIZE) f.length() else if (it == OpenableColumns.DISPLAY_NAME) f.name else null })
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
}
