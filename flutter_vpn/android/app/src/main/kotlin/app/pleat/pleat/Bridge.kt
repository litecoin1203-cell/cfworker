package app.pleat.pleat

import android.content.Context
import libv2ray.CoreCallbackHandler
import libv2ray.CoreController
import libv2ray.Libv2ray

/**
 * The bridge: a second core with no tun, started only while the app can't
 * reach the Worker on the open line and the tunnel is off. It listens on a
 * password-locked local HTTP port and lets only the Worker's own hosts
 * through (the config, built in Dart, says so). The app stops it after a
 * short idle time.
 */
object Bridge {
    @Volatile
    private var core: CoreController? = null

    /** Starts [config], replacing a running bridge; true when the core runs. */
    @Synchronized
    fun start(ctx: Context, config: String): Boolean {
        stop()
        Engine.init(ctx)
        val c = Libv2ray.newCoreController(object : CoreCallbackHandler {
            override fun startup(): Long = 0
            override fun shutdown(): Long = 0
            override fun onEmitStatus(code: Long, message: String?): Long = 0
        })
        c.startLoop(config, 0)
        if (!c.isRunning) {
            try { c.stopLoop() } catch (e: Exception) {}
            return false
        }
        core = c
        return true
    }

    @Synchronized
    fun stop() {
        try { core?.stopLoop() } catch (e: Exception) {}
        core = null
    }
}
