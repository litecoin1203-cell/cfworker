package app.pleat.pleat

import android.content.Context
import android.location.LocationManager
import android.os.Build
import android.provider.Settings
import android.telephony.TelephonyManager
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.security.SecureRandom
import java.util.TimeZone
import libv2ray.CoreCallbackHandler
import libv2ray.CoreController
import libv2ray.Libv2ray
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the world sees of the phone through one exit, for Protect.
 *
 * Every test runs through a throw-away core on a free local port (Pleat is
 * outside its own tunnel), started from the config Dart built: for the
 * Google view the exit alone, for the privacy check the session's own
 * config with its routing rules, so the requests take the same way an
 * app's traffic does. The local port is only open for the few seconds of
 * the test, like the speed test's.
 *
 * Google: the country YouTube gives the address (its INNERTUBE_CONTEXT_GL),
 * whether Gemini opens (Iran is one of the places it is closed to) and
 * whether Search answers with its "unusual traffic" wall: the method of
 * the open-source RegionRestrictionCheck, the same one the Cloud Gold app
 * used. Nothing personal is sent: no account, cookie or address.
 *
 * Blocking; call from a background thread.
 */
object Probe {
    private const val UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    private const val TIMEOUT_MS = 7000
    private const val PAGE_CAP = 1_500_000
    private val rnd = SecureRandom()

    /** The Google view of the exit in [config] (a test config, no inbound). */
    fun google(config: String): JSONObject {
        val out = JSONObject()
        withCore(config) { proxy, _ -> googleInto(out, proxy) }
        return out
    }

    /**
     * The privacy check through the session config in [config], with
     * [dns] the resolver the tun gives apps. Fields are left out when a test
     * got no answer, so Dart can tell "no answer" from "no".
     */
    fun leaks(context: Context, config: String, dns: String): JSONObject {
        val out = JSONObject()
        // The phone's own address, asked outside the tunnel: what must never show through it.
        trace(Proxy.NO_PROXY)?.let { (ip, cc) -> out.put("home_ip", ip).put("home_cc", cc) }
        withCore(config) { proxy, port ->
            googleInto(out, proxy)
            get("https://ipinfo.io/json", proxy, 64_000)?.let { (code, body, _) ->
                if (code == 200) json(body)?.let { j ->
                    out.put("ipinfo_cc", j.optString("country"))
                    out.put("ipinfo_org", j.optString("org"))
                    out.put("ipinfo_ip", j.optString("ip"))
                }
            }
            get("https://ipwho.is/", proxy, 64_000)?.let { (code, body, _) ->
                if (code == 200) json(body)?.let { j ->
                    out.put("ipwho_cc", j.optString("country_code"))
                    j.optJSONObject("connection")?.let { c ->
                        out.put("ipwho_org", c.optString("org").ifEmpty { c.optString("isp") })
                    }
                }
            }
            // DNS: whom the resolver the phone uses sees asking (whoami.cloudflare), and
            // whether anything of the phone's own subnet is passed on (Google's o-o.myaddr).
            dnsTxt(port, dns, "whoami.cloudflare", 3)?.firstOrNull()?.let { out.put("dns_seen", it) }
            dnsTxt(port, dns, "o-o.myaddr.l.google.com", 1)?.let { txt ->
                out.put("dns_ok", true)
                txt.firstOrNull { !it.startsWith("edns0") }?.let { out.put("dns_egress", it) }
                txt.firstOrNull { it.startsWith("edns0-client-subnet") }?.let {
                    out.put("dns_ecs", it.removePrefix("edns0-client-subnet").trim())
                }
            }
            // IPv6: an address the sniffer can't name must be refused, never carried around the exit.
            val v6 = get("https://[2606:4700:4700::1111]/cdn-cgi/trace", proxy, 8_000)
            out.put("v6", if (v6 != null && v6.first == 200) "through" else "blocked")
            if (v6 != null && v6.first == 200) lineOf(v6.second, "ip=")?.let { out.put("v6_ip", it) }
            // WebRTC: what a STUN server sees over UDP, the way calls and browsers find their address.
            stun(port)?.let { out.put("stun_ip", it) }
        }
        phone(context, out)
        return out
    }

    // ---- the pieces -------------------------------------------------------

    private fun googleInto(out: JSONObject, proxy: Proxy) {
        trace(proxy)?.let { (ip, cc) -> out.put("ip", ip).put("cc", cc) }
        // SOCS: the cookie-choice answer, so an EU address gets the page and not the consent wall.
        get("https://www.youtube.com/premium", proxy, PAGE_CAP, cookie = "SOCS=CAI")?.let { (_, body, finalUrl) ->
            out.put("reached", true)
            val gl = Regex("\"INNERTUBE_CONTEXT_GL\"\\s*:\\s*\"([A-Z]{2})\"").find(body)?.groupValues?.get(1)
                ?: Regex("[?&]gl=([A-Z]{2})(&|$)").find(finalUrl)?.groupValues?.get(1)
            gl?.let { out.put("google_cc", it) }
        }
        get("https://gemini.google.com", proxy, PAGE_CAP)?.let { (code, body, _) ->
            out.put("reached", true)
            if (code in 200..299 && body.contains("45631641,null,true")) out.put("gemini", true)
        }
        get("https://www.google.com/search?q=weather&hl=en", proxy, 400_000)?.let { (code, body, _) ->
            out.put("reached", true)
            val wall = code == 429 ||
                Regex("unusual traffic from|is blocked|unaddressed abuse", RegexOption.IGNORE_CASE).containsMatchIn(body)
            out.put("google_blocked", wall)
        }
    }

    private fun phone(context: Context, out: JSONObject) {
        out.put("tz", TimeZone.getDefault().id)
        try {
            val tm = context.getSystemService(TelephonyManager::class.java)
            tm?.simCountryIso?.uppercase()?.takeIf { it.length == 2 }?.let { out.put("sim_cc", it) }
        } catch (e: Exception) {
        }
        try {
            val on = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                context.getSystemService(LocationManager::class.java)?.isLocationEnabled
            } else {
                @Suppress("DEPRECATION")
                Settings.Secure.getInt(context.contentResolver, Settings.Secure.LOCATION_MODE, 0) != 0
            }
            on?.let { out.put("location_on", it) }
        } catch (e: Exception) {
        }
    }

    /** Runs [work] with a throw-away core of [config] behind a no-login socks port. */
    private fun withCore(config: String, work: (Proxy, Int) -> Unit) {
        val port = ServerSocket(0).use { it.localPort }
        val json = JSONObject(config)
        json.remove("pleat")
        json.put(
            "inbounds",
            JSONArray().put(
                JSONObject()
                    .put("tag", "socks")
                    .put("listen", "127.0.0.1")
                    .put("port", port)
                    .put("protocol", "socks")
                    .put("settings", JSONObject().put("auth", "noauth").put("udp", true).put("ip", "127.0.0.1"))
                    .put(
                        "sniffing",
                        JSONObject().put("enabled", true)
                            .put("destOverride", JSONArray().put("http").put("tls").put("quic"))
                            .put("routeOnly", false)
                    )
            )
        )
        val core: CoreController = Libv2ray.newCoreController(object : CoreCallbackHandler {
            override fun startup(): Long = 0
            override fun shutdown(): Long = 0
            override fun onEmitStatus(code: Long, message: String?): Long = 0
        })
        core.startLoop(json.toString(), 0)
        try {
            if (!core.isRunning) return
            work(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port)), port)
        } finally {
            try { core.stopLoop() } catch (e: Exception) {}
        }
    }

    /** Cloudflare's trace: the address a site sees and where Cloudflare places it. */
    private fun trace(proxy: Proxy): Pair<String, String>? {
        val (code, body, _) = get("https://www.cloudflare.com/cdn-cgi/trace", proxy, 8_000) ?: return null
        if (code != 200) return null
        val ip = lineOf(body, "ip=") ?: return null
        return Pair(ip, lineOf(body, "loc=").orEmpty())
    }

    private fun lineOf(body: String, key: String): String? =
        body.lineSequence().firstOrNull { it.startsWith(key) }?.substring(key.length)?.trim()?.takeIf { it.isNotEmpty() }

    private fun json(body: String): JSONObject? = try { JSONObject(body) } catch (e: Exception) { null }

    /** A GET: status, at most [cap] bytes of the body, and the URL it ended on. Null when nothing answered. */
    private fun get(url: String, proxy: Proxy, cap: Int, cookie: String? = null): Triple<Int, String, String>? = try {
        val conn = URL(url).openConnection(proxy) as HttpURLConnection
        conn.connectTimeout = TIMEOUT_MS
        conn.readTimeout = TIMEOUT_MS
        conn.useCaches = false
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", UA)
        conn.setRequestProperty("Accept", "text/html,application/json;q=0.9,*/*;q=0.8")
        conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9")
        if (cookie != null) conn.setRequestProperty("Cookie", cookie)
        try {
            val code = conn.responseCode
            val stream: InputStream? = if (code >= 400) conn.errorStream else conn.inputStream
            val body = stream?.use { readCapped(it, cap) }.orEmpty()
            Triple(code, body, conn.url.toString())
        } finally {
            conn.disconnect()
        }
    } catch (e: Exception) {
        null
    }

    private fun readCapped(input: InputStream, cap: Int): String {
        val buf = ByteArray(16 * 1024)
        val out = ByteArrayOutputStream()
        while (out.size() < cap) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toString("UTF-8")
    }

    // ---- DNS over TCP through the socks port ------------------------------

    /** TXT answers for [name] (class 1 IN, 3 CH) asked of [server] through the core; null on no answer. */
    private fun dnsTxt(port: Int, server: String, name: String, qclass: Int): List<String>? = try {
        Socket(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port))).use { s ->
            s.soTimeout = TIMEOUT_MS
            s.connect(InetSocketAddress(InetAddress.getByName(server), 53), TIMEOUT_MS)
            val q = dnsQuery(name, 16, qclass)
            val o = s.getOutputStream()
            o.write(byteArrayOf((q.size shr 8).toByte(), q.size.toByte()))
            o.write(q)
            o.flush()
            val i = DataInputStream(s.getInputStream())
            val len = i.readUnsignedShort()
            val r = ByteArray(len)
            i.readFully(r)
            txtOf(r)
        }
    } catch (e: Exception) {
        null
    }

    private fun dnsQuery(name: String, qtype: Int, qclass: Int): ByteArray {
        val b = ByteArrayOutputStream()
        val id = rnd.nextInt(0xffff)
        b.write(byteArrayOf((id shr 8).toByte(), id.toByte(), 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0))
        for (label in name.split('.')) {
            b.write(label.length)
            b.write(label.toByteArray())
        }
        b.write(0)
        b.write(byteArrayOf((qtype shr 8).toByte(), qtype.toByte(), (qclass shr 8).toByte(), qclass.toByte()))
        return b.toByteArray()
    }

    private fun txtOf(r: ByteArray): List<String> {
        fun u16(p: Int) = ((r[p].toInt() and 0xff) shl 8) or (r[p + 1].toInt() and 0xff)
        fun skipName(start: Int): Int {
            var p = start
            while (true) {
                val l = r[p].toInt() and 0xff
                if (l == 0) return p + 1
                if (l and 0xc0 == 0xc0) return p + 2
                p += l + 1
            }
        }
        val qd = u16(4)
        val an = u16(6)
        var p = 12
        repeat(qd) { p = skipName(p) + 4 }
        val out = mutableListOf<String>()
        repeat(an) {
            p = skipName(p)
            val type = u16(p)
            val rdlen = u16(p + 8)
            val data = p + 10
            if (type == 16) {
                var q = data
                val sb = StringBuilder()
                while (q < data + rdlen) {
                    val l = r[q].toInt() and 0xff
                    sb.append(String(r, q + 1, l, Charsets.UTF_8))
                    q += l + 1
                }
                out.add(sb.toString())
            }
            p = data + rdlen
        }
        return out
    }

    // ---- STUN over the socks port's UDP -----------------------------------

    /** The address Google's STUN server sees, over SOCKS5 UDP ASSOCIATE; null when UDP got no answer. */
    private fun stun(port: Int): String? {
        try {
            return stunOnce(port)
        } catch (e: Exception) {
            return null
        }
    }

    private fun stunOnce(port: Int): String? {
        Socket().use { ctl ->
            ctl.soTimeout = TIMEOUT_MS
            ctl.connect(InetSocketAddress("127.0.0.1", port), TIMEOUT_MS)
            val o = ctl.getOutputStream()
            val i = DataInputStream(ctl.getInputStream())
            o.write(byteArrayOf(5, 1, 0))
            o.flush()
            if (i.readUnsignedByte() != 5 || i.readUnsignedByte() != 0) return null
            o.write(byteArrayOf(5, 3, 0, 1, 0, 0, 0, 0, 0, 0))
            o.flush()
            if (i.readUnsignedByte() != 5 || i.readUnsignedByte() != 0) return null
            i.readUnsignedByte()
            val relayHost = when (i.readUnsignedByte()) {
                1 -> ByteArray(4).also { i.readFully(it) }.let { InetAddress.getByAddress(it) }
                4 -> ByteArray(16).also { i.readFully(it) }.let { InetAddress.getByAddress(it) }
                3 -> ByteArray(i.readUnsignedByte()).also { i.readFully(it) }.let { InetAddress.getByName(String(it)) }
                else -> return null
            }
            val relayPort = i.readUnsignedShort()
            val relay = InetSocketAddress(
                if (relayHost.isAnyLocalAddress) InetAddress.getByName("127.0.0.1") else relayHost,
                relayPort
            )
            DatagramSocket().use { udp ->
                udp.soTimeout = TIMEOUT_MS
                val host = "stun.l.google.com".toByteArray()
                val tx = ByteArray(12).also { rnd.nextBytes(it) }
                val req = ByteArrayOutputStream().apply {
                    write(byteArrayOf(0, 0, 0, 3, host.size.toByte()))
                    write(host)
                    write(byteArrayOf((19302 shr 8).toByte(), 19302.toByte()))
                    write(byteArrayOf(0, 1, 0, 0, 0x21, 0x12, 0xa4.toByte(), 0x42))
                    write(tx)
                }.toByteArray()
                val buf = ByteArray(1500)
                // UDP may drop one: three tries
                repeat(3) {
                    udp.send(DatagramPacket(req, req.size, relay))
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        udp.receive(pkt)
                    } catch (e: java.net.SocketTimeoutException) {
                        return@repeat
                    }
                    stunMapped(buf, pkt.length, tx)?.let { return it }
                }
                return null
            }
        }
        @Suppress("UNREACHABLE_CODE")
        return null
    }

    /** XOR-MAPPED-ADDRESS (or MAPPED-ADDRESS) of a binding answer behind a SOCKS5 UDP header. */
    private fun stunMapped(b: ByteArray, n: Int, tx: ByteArray): String? {
        if (n < 10) return null
        var p = when (b[3].toInt()) {
            1 -> 10
            4 -> 22
            3 -> 7 + (b[4].toInt() and 0xff)
            else -> return null
        }
        if (n < p + 20) return null
        fun u16(q: Int) = ((b[q].toInt() and 0xff) shl 8) or (b[q + 1].toInt() and 0xff)
        if (u16(p) != 0x0101) return null
        for (k in 0 until 12) if (b[p + 8 + k] != tx[k]) return null
        val end = p + 20 + u16(p + 2)
        p += 20
        val magic = byteArrayOf(0x21, 0x12, 0xa4.toByte(), 0x42)
        var plain: String? = null
        while (p + 4 <= minOf(end, n)) {
            val type = u16(p)
            val len = u16(p + 2)
            val v = p + 4
            if ((type == 0x0020 || type == 0x0001) && len >= 8 && b[v + 1].toInt() == 1) {
                val a = ByteArray(4) { k -> if (type == 0x0020) (b[v + 4 + k].toInt() xor magic[k].toInt()).toByte() else b[v + 4 + k] }
                val ip = InetAddress.getByAddress(a).hostAddress
                if (type == 0x0020) return ip
                plain = ip
            }
            p = v + ((len + 3) / 4) * 4
        }
        return plain
    }
}
