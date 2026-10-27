package com.v2ray.ang.cloudgold

import android.content.Context
import android.os.Build
import com.v2ray.ang.handler.AngConfigManager
import com.v2ray.ang.handler.MmkvManager
import com.v2ray.ang.dto.entities.SubscriptionItem
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class CgError(val code: String, message: String) : Exception(message)

/**
 * Bridges the user's PasarGuard subscription into the stock v2rayNG storage, so the untouched v2rayNG core,
 * VPN service, routing and settings run it exactly as if the subscription had been added by hand.
 */
object CgVpn {
    /** Fixed v2rayNG subscription id that holds the Cloud Gold servers. */
    const val SUB_ID = "cloudgold"
    /** PasarGuard picks the output format by user agent; present ourselves as the bundled v2rayNG core. */
    private const val CORE_UA = "v2rayNG/2.2.6"

    private val directClient by lazy {
        CgApi.client.newBuilder().connectTimeout(7, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    }

    private fun hasServers() = MmkvManager.decodeServerList(SUB_ID).isNotEmpty()

    /** Download the subscription straight from the panel, with this phone's HWID. null = unreachable. */
    private fun fetchDirect(ctx: Context, url: String): String? {
        val req = Request.Builder().url(url)
            .header("User-Agent", CORE_UA)
            .header("X-HWID", CgSession.deviceId(ctx))
            .header("X-Device-OS", "Android")
            .header("X-Ver-OS", Build.VERSION.RELEASE ?: "")
            .header("X-Device-Model", CgSession.deviceModel())
            .get().build()
        return try {
            directClient.newCall(req).execute().use { resp ->
                if (resp.code == 403 || resp.code == 429) throw CgError("device_limit", "این اشتراک روی حداکثر تعداد گوشی استفاده شده است.")
                if (!resp.isSuccessful) null else resp.body?.string().orEmpty().ifBlank { null }
            }
        } catch (e: CgError) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    /** Same subscription, fetched by our Cloudflare server (works when the panel address is filtered). */
    private fun fetchViaApi(ctx: Context): String? {
        val r = CgApi.request(ctx, "GET", "/vpn/sub", null)
        if (r.status == 403) {
            val (code, msg) = r.errorMessage("این اشتراک روی حداکثر تعداد گوشی استفاده شده است.")
            throw CgError(if (code == "error") "device_limit" else code, msg)
        }
        return if (r.ok && r.body.isNotBlank()) r.body else null
    }

    /**
     * Ask the API for the subscription, download it (directly from the panel, or through our server when the
     * panel is filtered) and import it into v2rayNG. If the network is down but servers were imported before,
     * the stored ones are kept so the user can still connect. Blocking.
     */
    fun sync(ctx: Context): JSONObject {
        val r = CgApi.request(ctx, "GET", "/vpn", null)
        if (!r.ok) {
            if (r.status == 0 && hasServers()) return servers().put("stale", true)
            val (code, msg) = r.errorMessage(if (r.status == 0) "اتصال به سرور برقرار نشد. اینترنت را بررسی کن." else "دریافت اشتراک ممکن نشد.")
            throw CgError(code, msg)
        }
        val sub = JSONObject(r.body).optJSONObject("subscription")
            ?: throw CgError("no_subscription", "برای استفاده از VPN یک پلن بخر یا تست رایگان را فعال کن.")
        val url = sub.optString("sub_url")
        if (url.isBlank()) throw CgError("no_servers", "برای اشتراک شما هنوز سروری تعریف نشده است. با پشتیبانی تماس بگیر.")

        // try the route that worked last time first
        val viaApiFirst = CgSession.subRoute == "api"
        var content: String? = null
        for (useApi in if (viaApiFirst) listOf(true, false) else listOf(false, true)) {
            content = if (useApi) fetchViaApi(ctx) else fetchDirect(ctx, url)
            if (content != null) { CgSession.subRoute = if (useApi) "api" else "direct"; break }
        }
        if (content == null) {
            if (hasServers()) return servers().put("stale", true)
            throw CgError("network", "دریافت لیست سرورها ممکن نشد. اینترنت را بررسی کن و دوباره امتحان کن.")
        }

        // keep the subscription entry so v2rayNG's own screens show it; Cloud Gold refreshes it itself
        val item = MmkvManager.decodeSubscription(SUB_ID) ?: SubscriptionItem()
        item.remarks = "Cloud Gold"
        item.url = url
        item.enabled = true
        item.autoUpdate = false
        item.allowInsecureUrl = url.startsWith("http://")
        item.userAgent = CORE_UA
        item.lastUpdated = System.currentTimeMillis()
        MmkvManager.encodeSubscription(SUB_ID, item)

        val previous = MmkvManager.getSelectServer()
        val (count, _) = AngConfigManager.importBatchConfig(content, SUB_ID, false)
        if (count <= 0 && !hasServers()) {
            throw CgError("no_servers", "برای اشتراک شما هنوز سروری تعریف نشده است. با پشتیبانی تماس بگیر.")
        }
        val list = MmkvManager.decodeServerList(SUB_ID)
        if (previous.isNullOrEmpty() || !list.contains(previous)) {
            list.firstOrNull()?.let { MmkvManager.setSelectServer(it) }
        }
        return servers()
    }

    /** Servers currently stored for the Cloud Gold subscription: {servers:[{guid, remarks, server, port, type, delay}], selected} */
    fun servers(): JSONObject {
        val arr = JSONArray()
        val guids = MmkvManager.decodeServerList(SUB_ID)
        guids.forEach { guid ->
            val p = MmkvManager.decodeServerConfig(guid) ?: return@forEach
            val delay = MmkvManager.decodeServerAffiliationInfo(guid)?.testDelayMillis ?: 0L
            arr.put(
                JSONObject()
                    .put("guid", guid)
                    .put("remarks", p.remarks)
                    .put("server", p.server ?: "")
                    .put("port", p.serverPort ?: "")
                    .put("type", p.configType.name.lowercase())
                    .put("delay", delay)
            )
        }
        var selected = MmkvManager.getSelectServer()
        if (selected.isNullOrEmpty() || !guids.contains(selected)) selected = guids.firstOrNull()
        return JSONObject().put("servers", arr).put("selected", selected ?: JSONObject.NULL)
    }

    fun select(guid: String): Boolean {
        if (!MmkvManager.decodeServerList(SUB_ID).contains(guid)) return false
        MmkvManager.setSelectServer(guid)
        return true
    }

    /** Remove the Cloud Gold servers from v2rayNG storage (on logout). */
    fun forget() {
        MmkvManager.removeServerViaSubid(SUB_ID)
    }
}
