package com.v2ray.ang.cloudgold

import com.v2ray.ang.handler.SettingsManager
import okhttp3.Credentials
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit

/**
 * Looks at the CONNECTED server the way Google does. Cloud Gold's own traffic is excluded from the VPN, so
 * every request here goes through the core's local proxy port: it leaves from exactly the same exit IP that
 * the user's apps use. Checks (same method as the open-source RegionRestrictionCheck):
 *  - exit IP + country (Cloudflare trace)
 *  - the country Google assigns to that IP (YouTube's INNERTUBE_CONTEXT_GL)
 *  - Gemini availability (marker in gemini.google.com) + Gemini's region code
 *  - whether Google Search shows the "unusual traffic" wall for that IP
 * Blocking; call from a background thread.
 */
object CgProbe {
    private const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

    private fun client(): OkHttpClient? {
        val port = SettingsManager.getHttpPort()
        if (port <= 0) return null
        val b = CgApi.client.newBuilder()
            .proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", port)))
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .callTimeout(25, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
        val user = SettingsManager.getSocksUsername()
        val pass = SettingsManager.getSocksPassword()
        if (!user.isNullOrEmpty() && !pass.isNullOrEmpty()) {
            b.proxyAuthenticator { _, response ->
                response.request.newBuilder().header("Proxy-Authorization", Credentials.basic(user, pass)).build()
            }
        }
        return b.build()
    }

    private fun fetch(c: OkHttpClient, url: String): Pair<Int, String>? = try {
        val req = Request.Builder().url(url)
            .header("User-Agent", UA)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .header("Accept-Language", "en-US,en;q=0.9")
            .get().build()
        c.newCall(req).execute().use { r -> r.code to (r.body?.string() ?: "") }
    } catch (e: Exception) {
        null
    }

    fun run(): JSONObject {
        val out = JSONObject()
        val c = client() ?: return out.put("error", "not_running")
        var reached = false

        fetch(c, "https://www.cloudflare.com/cdn-cgi/trace")?.let { (code, body) ->
            if (code == 200) {
                reached = true
                body.lineSequence().forEach { line ->
                    if (line.startsWith("ip=")) out.put("ip", line.substring(3).trim())
                    if (line.startsWith("loc=")) out.put("cc", line.substring(4).trim())
                }
            }
        }

        fetch(c, "https://www.youtube.com/premium")?.let { (_, body) ->
            reached = true
            Regex("\"INNERTUBE_CONTEXT_GL\"\\s*:\\s*\"([A-Z]{2})\"").find(body)?.let { out.put("google_cc", it.groupValues[1]) }
        }

        fetch(c, "https://gemini.google.com")?.let { (code, body) ->
            reached = true
            if (code in 200..299 && body.isNotEmpty()) {
                if (body.contains("45631641,null,true")) out.put("gemini", true)
                Regex(",2,1,200,\"([A-Z]{3})\"").find(body)?.let { out.put("gemini_region", it.groupValues[1]) }
            }
        }

        fetch(c, "https://www.google.com/search?q=cloud+gold&hl=en")?.let { (code, body) ->
            reached = true
            val wall = code == 429 || Regex("unusual traffic from|is blocked|unaddressed abuse", RegexOption.IGNORE_CASE).containsMatchIn(body)
            out.put("google_blocked", wall)
        }

        if (!reached) out.put("error", "no_network")
        return out
    }
}
