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
import java.security.SecureRandom
import org.json.JSONArray
import org.json.JSONObject
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

        /** How long a failed start keeps the tun (blocking) for the app's next try. */
        private const val FAILED_HOLD_MS = 20_000L

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
        Health.install(this)
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
        // for a crash report: which exit and protocol, and that it was starting
        val note = exitNoteOf(config)
        Health.tunnelState(this, "starting", note.first, note.second)
        // Said at once, so the app knows any later "down" or "failed" is
        // about this attempt.
        TunnelHub.set("starting")
        ops.execute {
            if (gen != generation) return@execute
            // A switch to another exit (or a retry) keeps the running tun
            // until the new one is up: closing it first let every app on
            // the phone leave outside the VPN, with the real IP, for as long
            // as the new exit took to answer. Android hands the routes to the
            // new tun in place, so there is never a moment without one.
            val old = tun
            tun = null
            val ok = try {
                stopEngine()
                start(config)
                probe { gen == generation }
            } catch (e: Throwable) {
                Health.startFailed(e)
                false
            } finally {
                // The new tun took over: the old one goes. No new tun (the
                // start failed before it): the old one stays, blocking.
                if (old != null && old !== tun) {
                    if (tun != null) {
                        try { old.close() } catch (e: Exception) {}
                    } else {
                        tun = old
                    }
                }
            }
            if (gen != generation) return@execute
            if (ok) {
                // for the health reports: a marker of a running tunnel, and the session's battery
                Health.tunnelUp(this)
                Health.tunnelState(this, "up")
                Health.sessionStart(this)
                TunnelHub.set("up")
                main.post {
                    if (gen != generation) return@post
                    up = true
                    upSince = System.currentTimeMillis()
                    redraw()
                }
            } else if (tun != null) {
                // The tun stays, blocking: the app either tries the next exit
                // (another begin, which takes this tun over) or stops. If
                // neither comes (the app isn't running, an always-on start),
                // it is closed after a while as before.
                TunnelHub.set("failed")
                main.postDelayed({ if (gen == generation) stopTunnel("failed") }, FAILED_HOLD_MS)
            } else stopTunnel("failed")
        }
    }

    private fun start(config: String) {
        Health.trimStderr(this)
        // Apps the person sends past the VPN (Route > Split route): kept out
        // of the tun entirely, so they use the phone's own network and IP.
        val bypass = bypassOf(config)
        val iface = Builder()
            .setSession("Pleat")
            .setMtu(1500)
            .addAddress("10.10.14.1", 30)
            .addRoute("0.0.0.0", 0)
            .addAddress("fd66:6c65:6174::1", 126)
            .addRoute("::", 0)
            // IPv4 only: a query to an IPv6 resolver would be an address the
            // sniffer cannot name, which the core refuses so apps fall back to
            // IPv4 at once. The names it answers with may still be IPv6; those
            // reach the exit by name.
            .addDnsServer("1.1.1.1")
            .addDnsServer("1.0.0.1")
            .addDisallowedApplication(packageName)
            .apply {
                for (p in bypass) {
                    if (p == packageName) continue
                    // an app uninstalled since it was picked: nothing to keep out
                    try { addDisallowedApplication(p) } catch (e: Exception) {}
                }
            }
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

        // A fresh login for the local SOCKS port, known only to the core and
        // hev: without it any app on the phone could use the exit.
        val user = randomToken(12)
        val pass = randomToken(24)
        val locked = lockSocks(config, user, pass)

        Engine.init(this)
        val c = Libv2ray.newCoreController(object : CoreCallbackHandler {
            override fun startup(): Long = 0
            override fun shutdown(): Long = 0
            override fun onEmitStatus(code: Long, message: String?): Long = 0
        })
        core = c
        c.startLoop(locked, 0)
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
              username: '$user'
              password: '$pass'
            misc:
              tcp-read-write-timeout: 300000
              udp-read-write-timeout: 60000
              log-level: error
              log-file: /dev/null
            """.trimIndent() + "\n"
        )
        TProxyService.TProxyStartService(yaml.absolutePath, iface.fd)
        hevRunning = true
    }

    /**
     * One request through the exit, made by the core itself (the same routes
     * as the tun's traffic; the SOCKS port now wants a login). True when it
     * answers. Gives up early once [current] turns false.
     */
    private fun probe(current: () -> Boolean): Boolean {
        var why: Throwable? = null
        repeat(3) {
            if (!current()) return false
            try {
                val ms = core?.measureDelay(Engine.TEST_URL) ?: -1L
                if (ms >= 0) return true
            } catch (e: Exception) {
                // no answer this time; the core's reason goes to the health report
                why = e
            }
            Thread.sleep(800)
        }
        Health.startFailed(why ?: Exception("no answer through the exit (timeout)"))
        return false
    }

    /** Letters and digits only, so the value is safe in hev's YAML and the core's JSON. */
    private fun randomToken(n: Int): String {
        val abc = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val rnd = SecureRandom()
        return String(CharArray(n) { abc[rnd.nextInt(abc.length)] })
    }

    /** The exit's anonymous key and protocol under the config's "pleat" key, for the health reports. */
    private fun exitNoteOf(config: String): Pair<String, String> = try {
        val exit = JSONObject(config).optJSONObject("pleat")?.optJSONObject("exit")
        Pair(exit?.optString("k").orEmpty(), exit?.optString("p").orEmpty())
    } catch (e: Exception) {
        Pair("", "")
    }

    /** Packages under the config's "pleat" key: the apps that skip the VPN. */
    private fun bypassOf(config: String): List<String> = try {
        val list = JSONObject(config).optJSONObject("pleat")?.optJSONArray("bypass")
        if (list == null) emptyList() else List(list.length()) { list.optString(it) }.filter { it.isNotBlank() }
    } catch (e: Exception) {
        emptyList()
    }

    /**
     * The config with [user]/[pass] as the only login of its "socks" inbound,
     * and without Pleat's own "pleat" key, which is not the core's.
     */
    private fun lockSocks(config: String, user: String, pass: String): String {
        val json = JSONObject(config)
        json.remove("pleat")
        val inbounds = json.optJSONArray("inbounds") ?: return json.toString()
        for (i in 0 until inbounds.length()) {
            val ib = inbounds.optJSONObject(i) ?: continue
            if (ib.optString("tag") != "socks") continue
            val settings = ib.optJSONObject("settings") ?: JSONObject().also { ib.put("settings", it) }
            settings.put("auth", "password")
            settings.put("accounts", JSONArray().put(JSONObject().put("user", user).put("pass", pass)))
        }
        return json.toString()
    }

    /** The core and hev only; the tun and the network watch stay. */
    private fun stopEngine() {
        if (hevRunning) {
            try { TProxyService.TProxyStopService() } catch (e: Exception) {}
            hevRunning = false
        }
        running = null
        try { core?.stopLoop() } catch (e: Exception) {}
        core = null
    }

    private fun teardown() {
        if (watching) {
            try { connectivity.unregisterNetworkCallback(underlying) } catch (e: Exception) {}
            watching = false
            handed = null
        }
        stopEngine()
        try { tun?.close() } catch (e: Exception) {}
        tun = null
    }

    private fun stopTunnel(state: String) {
        val gen = ++generation
        Health.tunnelState(this, "stopping")
        ops.execute {
            teardown()
            // a newer start already noted "starting"
            if (gen == generation) Health.tunnelState(this, "off")
            Health.tunnelStopped(this)
            Health.sessionEnd(this)
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
        Health.tunnelState(this, "stopping")
        ops.execute {
            teardown()
            Health.tunnelState(this, "off")
            Health.tunnelStopped(this)
            Health.sessionEnd(this)
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
