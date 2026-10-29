package app.pleat.pleat

import android.content.Context
import go.Seq
import java.io.File
import libv2ray.Libv2ray

/**
 * One-time core setup shared by the tunnel and the server tests: the geo
 * files go next to the core (v2rayNG does the same), then the core is told
 * where they are.
 */
object Engine {
    const val TEST_URL = "https://www.gstatic.com/generate_204"
    private val GEO = listOf("geoip.dat", "geosite.dat")

    @Volatile
    private var ready = false

    @Synchronized
    fun init(ctx: Context) {
        if (ready) return
        val app = ctx.applicationContext
        for (name in GEO) {
            try {
                val out = File(app.filesDir, name)
                app.assets.openFd("geo/$name").use { fd ->
                    if (out.length() == fd.length) return@use
                    fd.createInputStream().use { input -> out.outputStream().use { input.copyTo(it) } }
                }
            } catch (e: Exception) {
                // Not in this build: the rules that need it are left out.
            }
        }
        Seq.setContext(app)
        Libv2ray.initCoreEnv(app.filesDir.absolutePath, "")
        ready = true
    }

    fun hasGeo(ctx: Context): Boolean =
        GEO.all { File(ctx.applicationContext.filesDir, it).length() > 0 }
}
