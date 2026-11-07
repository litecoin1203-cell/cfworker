package app.pleat.pleat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.provider.Settings
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
    private const val CHANNEL = "updates"
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

    /** One system notification for a new build; tapping it opens the update sheet. */
    fun notify(context: Context, title: String, text: String) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val open = PendingIntent.getActivity(
            context, 3,
            Intent(context, MainActivity::class.java)
                .putExtra(TunnelNote.EXTRA_OPEN, "update")
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }
        b.setSmallIcon(R.drawable.ic_note)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
        try {
            nm.notify(NOTE_ID, b.build())
        } catch (e: SecurityException) {
            // Notifications not allowed: the badge in the app still shows it.
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
