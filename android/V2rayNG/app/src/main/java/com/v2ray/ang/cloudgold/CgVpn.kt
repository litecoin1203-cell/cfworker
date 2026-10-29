package com.v2ray.ang.cloudgold

import android.content.Context
import com.v2ray.ang.handler.AngConfigManager
import com.v2ray.ang.handler.MmkvManager
import com.v2ray.ang.dto.entities.SubscriptionItem
import org.json.JSONArray
import org.json.JSONObject

class CgError(val code: String, message: String) : Exception(message)

/**
 * Bridges the user's Cloud Gold server list into the stock v2rayNG storage, so the untouched v2rayNG core,
 * VPN service, routing and settings run it exactly as if the subscription had been added by hand.
 */
object CgVpn {
    /** Fixed v2rayNG subscription id that holds the Cloud Gold servers. */
    const val SUB_ID = "cloudgold"
    /** User agent of the bundled v2rayNG core, kept on the stored subscription entry. */
    private const val CORE_UA = "v2rayNG/2.2.6"

    private fun hasServers() = MmkvManager.decodeServerList(SUB_ID).isNotEmpty()

    /**
     * The one merged server list, built by our Cloudflare server from every panel the account is on. The app
     * never talks to a panel and never learns its address. null = could not be downloaded now.
     */
    private fun fetchList(ctx: Context): String? {
        val r = CgApi.request(ctx, "GET", "/vpn/sub", null)
        if (r.status == 403) {
            val (code, msg) = r.errorMessage("این اشتراک روی حداکثر تعداد گوشی استفاده شده است.")
            throw CgError(if (code == "error") "device_limit" else code, msg)
        }
        if (r.status == 404 || r.status == 410) {
            val (code, msg) = r.errorMessage("برای اشتراک شما هنوز سروری تعریف نشده است. با پشتیبانی تماس بگیر.")
            throw CgError(code, msg)
        }
        return if (r.ok && r.body.isNotBlank()) r.body else null
    }

    /**
     * Check the subscription, download the server list through our server and import it into v2rayNG. If the
     * network is down but servers were imported before, the stored ones are kept so the user can still connect.
     * Blocking.
     */
    fun sync(ctx: Context): JSONObject {
        val r = CgApi.request(ctx, "GET", "/vpn", null)
        if (!r.ok) {
            if (r.status == 0 && hasServers()) return servers().put("stale", true)
            val (code, msg) = r.errorMessage(if (r.status == 0) "اتصال به سرور برقرار نشد. اینترنت را بررسی کن." else "دریافت اشتراک ممکن نشد.")
            throw CgError(code, msg)
        }
        JSONObject(r.body).optJSONObject("subscription")
            ?: throw CgError("no_subscription", "برای استفاده از VPN یک پلن بخر یا تست رایگان را فعال کن.")

        val content = fetchList(ctx)
        if (content == null) {
            if (hasServers()) return servers().put("stale", true)
            throw CgError("network", "دریافت لیست سرورها ممکن نشد. اینترنت را بررسی کن و دوباره امتحان کن.")
        }

        // keep the subscription entry so v2rayNG's own screens show it; it points at our server, never a panel,
        // and Cloud Gold refreshes it itself
        val item = MmkvManager.decodeSubscription(SUB_ID) ?: SubscriptionItem()
        item.remarks = "Cloud Gold"
        item.url = CgApi.base + "/api/v1/vpn/sub"
        item.enabled = true
        item.autoUpdate = false
        item.allowInsecureUrl = false
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

    /**
     * Servers currently stored for the Cloud Gold subscription: {servers:[{guid, remarks, k, type, delay}], selected}.
     * The page never gets a server's address or port: `k` is a stable, anonymous key for favorites and the
     * per-operator statistics.
     */
    fun servers(): JSONObject {
        val arr = JSONArray()
        val guids = MmkvManager.decodeServerList(SUB_ID)
        guids.forEach { guid ->
            val p = MmkvManager.decodeServerConfig(guid) ?: return@forEach
            val delay = MmkvManager.decodeServerAffiliationInfo(guid)?.testDelayMillis ?: 0L
            val type = p.configType.name.lowercase()
            arr.put(
                JSONObject()
                    .put("guid", guid)
                    .put("remarks", p.remarks)
                    .put("k", serverKey(type, p.server.orEmpty(), p.serverPort.orEmpty()))
                    .put("type", type)
                    .put("delay", delay)
            )
        }
        var selected = MmkvManager.getSelectServer()
        if (selected.isNullOrEmpty() || !guids.contains(selected)) selected = guids.firstOrNull()
        return JSONObject().put("servers", arr).put("selected", selected ?: JSONObject.NULL)
    }

    /**
     * "k" + FNV-1a (32-bit, over UTF-16 units) of "type|host|port" in lower case, as 8 hex digits. Must stay equal to
     * the key older app pages computed (app-web core.js serverKey) so saved statistics and favorites keep matching.
     */
    fun serverKey(type: String, host: String, port: String): String {
        var h = 0x811c9dc5.toInt()
        for (c in "$type|$host|$port".lowercase()) {
            h = h xor c.code
            h *= 0x01000193
        }
        return "k" + Integer.toHexString(h).padStart(8, '0')
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
