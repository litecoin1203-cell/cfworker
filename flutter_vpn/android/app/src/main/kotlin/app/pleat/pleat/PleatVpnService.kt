package app.pleat.pleat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import go.Seq
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import libv2ray.CoreCallbackHandler
import libv2ray.CoreController
import libv2ray.Libv2ray

/**
 * The tunnel: a VpnService whose tun goes to hev-socks5-tunnel, which feeds
 * the Xray core's local SOCKS port; the core carries it to the exit.
 *
 * All IPv4 and IPv6 routes and DNS go into the tun, so nothing leaves
 * outside the exit. Pleat itself is left out of the tun (as v2rayNG does),
 * which keeps the core's own sockets off it. "up" is reported only after a
 * probe request has crossed the exit.
 */
class PleatVpnService : VpnService() {
    companion object {
        const val ACTION_START = "app.pleat.START"
        const val ACTION_STOP = "app.pleat.STOP"
        const val EXTRA_CONFIG = "config"
        private const val SOCKS_PORT = 10808
        private const val NOTE_ID = 7
        private const val CHANNEL = "tunnel"
    }

    private var tun: ParcelFileDescriptor? = null
    private var core: CoreController? = null
    private var hevRunning = false
    private var worker: Thread? = null
    private val lock = Any()

    /** Bumped by every start and stop, so a late probe can't revive a stopped tunnel. */
    @Volatile
    private var generation = 0

    /** Last config, kept out of backups, for Android's always-on start. */
    private val lastConfig get() = File(noBackupFilesDir, "last-config.json")

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopTunnel("down")
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG) ?: return START_NOT_STICKY
                lastConfig.writeText(config)
                begin(config)
            }
            else -> {
                // Started by the system (always-on VPN): reuse the last exit.
                val config = lastConfig.takeIf { it.exists() }?.readText()
                if (config == null) {
                    stopTunnel("down")
                    return START_NOT_STICKY
                }
                begin(config)
            }
        }
        return START_STICKY
    }

    private fun begin(config: String) {
        foreground()
        worker?.interrupt()
        val gen = ++generation
        worker = Thread {
            val ok = try {
                synchronized(lock) {
                    teardown()
                    TunnelHub.set("starting")
                    start(config)
                }
                probe()
            } catch (e: Throwable) {
                false
            }
            if (gen != generation) return@Thread
            if (ok) TunnelHub.set("up") else stopTunnel("failed")
        }.apply { start() }
    }

    private fun start(config: String) {
        val iface = Builder()
            .setSession("Pleat")
            .setMtu(1500)
            .addAddress("10.10.14.1", 30)
            .addRoute("0.0.0.0", 0)
            .addAddress("fd66:6c65:6174::1", 126)
            .addRoute("::", 0)
            .addDnsServer("1.1.1.1")
            .addDnsServer("2606:4700:4700::1111")
            .addDisallowedApplication(packageName)
            .apply { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) setMetered(false) }
            .establish() ?: error("VPN permission revoked")
        tun = iface

        Seq.setContext(applicationContext)
        Libv2ray.initCoreEnv(filesDir.absolutePath, "")
        val c = Libv2ray.newCoreController(object : CoreCallbackHandler {
            override fun startup(): Long = 0
            override fun shutdown(): Long = 0
            override fun onEmitStatus(code: Long, message: String?): Long = 0
        })
        core = c
        c.startLoop(config, 0)
        if (!c.isRunning) error("core did not start")

        val yaml = File(filesDir, "hev.yaml")
        yaml.writeText(
            """
            tunnel:
              mtu: 1500
              ipv4: 10.10.14.1
              ipv6: 'fd66:6c65:6174::1'
            socks5:
              port: $SOCKS_PORT
              address: 127.0.0.1
              udp: 'udp'
            misc:
              tcp-read-write-timeout: 300000
              udp-read-write-timeout: 60000
              log-level: error
            """.trimIndent() + "\n"
        )
        TProxyService.TProxyStartService(yaml.absolutePath, iface.fd)
        hevRunning = true
    }

    /** One request through the exit; true when it answers. */
    private fun probe(): Boolean {
        val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", SOCKS_PORT))
        repeat(3) {
            try {
                val conn = URL("https://www.gstatic.com/generate_204").openConnection(proxy) as HttpURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                val code = conn.responseCode
                conn.disconnect()
                if (code == 204 || code == 200) return true
            } catch (e: Exception) {
                Thread.sleep(800)
            }
        }
        return false
    }

    private fun teardown() {
        if (hevRunning) {
            try { TProxyService.TProxyStopService() } catch (e: Exception) {}
            hevRunning = false
        }
        try { core?.stopLoop() } catch (e: Exception) {}
        core = null
        try { tun?.close() } catch (e: Exception) {}
        tun = null
    }

    private fun stopTunnel(state: String) {
        generation++
        synchronized(lock) { teardown() }
        TunnelHub.set(state)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onRevoke() {
        // Another VPN took over, or the person turned Pleat off in Settings.
        stopTunnel("down")
    }

    override fun onDestroy() {
        teardown()
        if (TunnelHub.state != "failed") TunnelHub.set("down")
        super.onDestroy()
    }

    private fun foreground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Tunnel", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val note = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL)
        else @Suppress("DEPRECATION") Notification.Builder(this))
            .setContentTitle("Pleat")
            .setContentText("Tunnel on")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTE_ID, note)
        }
    }
}
