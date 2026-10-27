package com.v2ray.ang.cloudgold

import android.content.Context
import android.os.Build
import com.v2ray.ang.handler.AngConfigManager
import com.v2ray.ang.handler.MmkvManager
import com.v2ray.ang.dto.entities.SubscriptionItem
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

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

    /** Ask the API for the subscription, download it with this phone's HWID, and import it. Blocking. */
    fun sync(ctx: Context): JSONObject {
        val r = CgApi.request(ctx, "GET", "/vpn", null)
        if (!r.ok) {
            val (code, msg) = r.errorMessage(if (r.status == 0) "No connection to the server" else "Could not load your plan")
            throw CgError(code, msg)
        }
        val sub = JSONObject(r.body).optJSONObject("subscription")
            ?: throw CgError("no_subscription", "Buy a plan to start using the VPN")
        val url = sub.optString("sub_url")
        if (url.isBlank()) throw CgError("no_servers", "Your plan has no servers yet. Please contact support.")

        val req = Request.Builder().url(url)
            .header("User-Agent", CORE_UA)
            .header("X-HWID", CgSession.deviceId(ctx))
            .header("X-Device-OS", "Android")
            .header("X-Ver-OS", Build.VERSION.RELEASE ?: "")
            .header("X-Device-Model", CgSession.deviceModel())
            .get().build()
        val content = try {
            CgApi.client.newCall(req).execute().use { resp ->
                if (resp.code == 403 || resp.code == 429) throw CgError("device_limit", "This plan is already used on the maximum number of phones")
                if (!resp.isSuccessful) throw CgError("panel_error", "Servers are not reachable right now (${resp.code})")
                resp.body?.string().orEmpty()
            }
        } catch (e: CgError) {
            throw e
        } catch (e: Exception) {
            throw CgError("network", "Could not reach the servers. Check your internet and try again.")
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
        if (count <= 0 && MmkvManager.decodeServerList(SUB_ID).isEmpty()) {
            throw CgError("no_servers", "Your plan has no servers yet. Please contact support.")
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
