package app.pleat.pleat

import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
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

        /** Disconnect from the notification: the app reads "off", not a drop. */
        const val ACTION_DISCONNECT = "app.pleat.DISCONNECT"
        const val EXTRA_CONFIG = "config"
        private const val SOCKS_PORT = 10808

        /** The running core, for live delay checks from the app. */
        @Volatile
        var running: CoreController? = null
            private set

        /** The live service, for Android's always-on and lockdown flags. */
        @Volatile
        var instance: PleatVpnService? = null
            private set

        /** The app said more about the exit (place, IP): redraw the card. */
        fun noteChanged() {
            instance?.let { s -> s.main.post { s.redraw() } }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    private var tun: ParcelFileDescriptor? = null

    /**
     * As v2rayNG 2.2.6's CoreVpnService: follow THE default network (not
     * the VPN itself) and hand it to Android as the tunnel's underlying
     * network, so Wi-Fi / mobile switches keep working and Android shows
     * the right network type.
     */
    private val connectivity by lazy { getSystemService(ConnectivityManager::class.java) }
    private var watching = false

    /** The network last handed to Android, so signal changes on it aren't handed over again. */
    @Volatile
    private var handed: Network? = null
    private val underlying = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            hand(network)
        }

        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            // Fires on every signal-strength change. Android follows the
            // capabilities of the network it was handed by itself, so only
            // a different network needs handing over.
            hand(network)
        }

        override fun onLost(network: Network) {
            handed = null
            setUnderlyingNetworks(null)
        }
    }

    private fun hand(network: Network) {
        if (network == handed) return
        handed = network
        setUnderlyingNetworks(arrayOf(network))
    }
    private var core: CoreController? = null
    private var hevRunning = false

    /**
     * Starting and stopping the core and the tun can take seconds, so they
     * run here, one at a time and in order, never on the main thread: a
     * Cancel pressed mid-start used to wait on the start and froze the app.
     */
    private val ops = java.util.concurrent.Executors.newSingleThreadExecutor()

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
            ACTION_DISCONNECT -> {
                stopTunnel("off")
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
        up = false
        upSince = 0
        foreground()
        val gen = ++generation
        // Said at once, so the app knows any later "down" or "failed" is
        // about this attempt.
        TunnelHub.set("starting")
        ops.execute {
            if (gen != generation) return@execute
            val ok = try {
                teardown()
                start(config)
                probe { gen == generation }
            } catch (e: Throwable) {
                false
            }
            if (gen != generation) return@execute
            if (ok) {
                TunnelHub.set("up")
                main.post {
                    if (gen != generation) return@post
                    up = true
                    upSince = System.currentTimeMillis()
                    redraw()
                }
            } else stopTunnel("failed")
        }
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && !watching) {
            try {
                connectivity.requestNetwork(
                    NetworkRequest.Builder()
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
                        .build(),
                    underlying
                )
                watching = true
            } catch (e: Exception) {
                // Without it Android picks the underlying network itself.
            }
        }

        Engine.init(this)
        val c = Libv2ray.newCoreController(object : CoreCallbackHandler {
            override fun startup(): Long = 0
            override fun shutdown(): Long = 0
            override fun onEmitStatus(code: Long, message: String?): Long = 0
        })
        core = c
        c.startLoop(config, 0)
        if (!c.isRunning) error("core did not start")
        running = c

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

    /** One request through the exit; true when it answers. Gives up early once [current] turns false. */
    private fun probe(current: () -> Boolean): Boolean {
        val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", SOCKS_PORT))
        repeat(3) {
            if (!current()) return false
            try {
                val conn = URL(Engine.TEST_URL).openConnection(proxy) as HttpURLConnection
                conn.connectTimeout = 6000
                conn.readTimeout = 6000
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
        if (watching) {
            try { connectivity.unregisterNetworkCallback(underlying) } catch (e: Exception) {}
            watching = false
            handed = null
        }
        if (hevRunning) {
            try { TProxyService.TProxyStopService() } catch (e: Exception) {}
            hevRunning = false
        }
        running = null
        try { core?.stopLoop() } catch (e: Exception) {}
        core = null
        try { tun?.close() } catch (e: Exception) {}
        tun = null
    }

    private fun stopTunnel(state: String) {
        val gen = ++generation
        ops.execute {
            teardown()
            // A newer start may have come in meanwhile; it owns the service now.
            if (gen != generation) return@execute
            TunnelHub.set(state)
            main.post {
                if (gen != generation) return@post
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    /** Main thread only: the card says Protected once the probe passed. */
    private var up = false
    private var upSince = 0L

    override fun onRevoke() {
        // Another VPN took over, or the person turned Pleat off in Settings.
        stopTunnel("down")
    }

    override fun onDestroy() {
        instance = null
        generation++
        val wasUp = TunnelHub.state == "up"
        ops.execute {
            teardown()
            // Killed while running. Otherwise the stop has already said
            // so, and a newer service may be starting.
            if (wasUp) TunnelHub.set("down")
        }
        ops.shutdown()
        super.onDestroy()
    }

    private fun foreground() {
        val note = TunnelNote.build(this, up, upSince)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(TunnelNote.ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(TunnelNote.ID, note)
        }
    }

    /** Rebuilt only when the state or the exit's details change; the timer counts itself. */
    private fun redraw() {
        if (instance !== this) return
        // A stop already took the card down (or is about to): don't bring it back.
        if (TunnelHub.state != "up" && TunnelHub.state != "starting") return
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(TunnelNote.ID, TunnelNote.build(this, up, upSince))
    }
}
