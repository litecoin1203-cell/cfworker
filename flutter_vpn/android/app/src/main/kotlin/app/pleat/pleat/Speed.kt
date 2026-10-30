package app.pleat.pleat

import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.URL
import libv2ray.CoreCallbackHandler
import libv2ray.Libv2ray
import org.json.JSONArray
import org.json.JSONObject

/**
 * Download speed through one exit, the way the person will feel it: a
 * throw-away core on a free local port, then about 1 MB fetched through it
 * on the phone's own network (Pleat is outside its own tunnel, so a running
 * session doesn't carry the test).
 */
object Speed {
    private const val URL_1MB = "https://speed.cloudflare.com/__down?bytes=1000000"
    private const val LIMIT_MS = 8000L

    /** Kilobits per second, or -1 when nothing came through. */
    fun measure(config: String): Int {
        val port = ServerSocket(0).use { it.localPort }
        val json = JSONObject(config)
        json.put(
            "inbounds",
            JSONArray().put(
                JSONObject()
                    .put("tag", "speed")
                    .put("listen", "127.0.0.1")
                    .put("port", port)
                    .put("protocol", "socks")
                    .put("settings", JSONObject().put("auth", "noauth").put("udp", false))
            )
        )
        val core = Libv2ray.newCoreController(object : CoreCallbackHandler {
            override fun startup(): Long = 0
            override fun shutdown(): Long = 0
            override fun onEmitStatus(code: Long, message: String?): Long = 0
        })
        core.startLoop(json.toString(), 0)
        try {
            if (!core.isRunning) return -1
            val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port))
            val conn = URL(URL_1MB).openConnection(proxy) as HttpURLConnection
            conn.connectTimeout = 6000
            conn.readTimeout = 6000
            conn.useCaches = false
            try {
                // The clock starts with the first byte, so the handshake (which
                // the ping already shows) doesn't count against the speed.
                val input = conn.inputStream
                val buf = ByteArray(32 * 1024)
                var bytes = 0L
                var start = 0L
                val deadline = System.currentTimeMillis() + LIMIT_MS
                while (System.currentTimeMillis() < deadline) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (start == 0L) start = System.nanoTime()
                    bytes += n
                }
                input.close()
                if (start == 0L || bytes < 16 * 1024) return -1
                val ms = ((System.nanoTime() - start) / 1_000_000).coerceAtLeast(1)
                return (bytes * 8 / ms).toInt()
            } finally {
                conn.disconnect()
            }
        } finally {
            try { core.stopLoop() } catch (e: Exception) {}
        }
    }
}
