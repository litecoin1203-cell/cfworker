package com.v2ray.ang.cloudgold

import android.content.Context
import android.os.Build
import android.util.Log
import com.v2ray.ang.BuildConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.json.JSONTokener
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * HTTP client for the Cloud Gold API (a Cloudflare Worker). Adds the bearer token and device headers and
 * refreshes an expired access token once. CG_API_BASE may list several addresses separated by commas; if the
 * first cannot be reached (e.g. filtered), the next is tried and the one that answers is remembered.
 * The app's own traffic is excluded from the VPN, so these calls go out directly.
 */
object CgApi {
    private val bases: List<String> =
        BuildConfig.CG_API_BASE.split(",").map { it.trim().trimEnd('/') }.filter { it.isNotEmpty() }
            .ifEmpty { listOf("https://api.cloudgold.example") }

    @Volatile private var activeBase: String = bases.first()
    val base: String get() = activeBase

    private val JSON = "application/json; charset=utf-8".toMediaType()

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .apply { systemOnlyTls()?.let { (factory, trust) -> sslSocketFactory(factory, trust) } }
            .build()
    }

    /**
     * TLS that trusts only the CAs shipped with Android, never a certificate the user (or another app) installed,
     * so a network that pushes its own CA onto phones cannot read or change the login tokens. Null keeps the
     * platform default if the system store cannot be read.
     */
    private fun systemOnlyTls(): Pair<SSLSocketFactory, X509TrustManager>? = try {
        val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
        val anchors = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
        for (alias in store.aliases().toList()) {
            if (alias.startsWith("system:")) anchors.setCertificateEntry(alias, store.getCertificate(alias))
        }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(anchors) }
        val trust = tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        tls.socketFactory to trust
    } catch (e: Exception) {
        Log.w("CgApi", "system-only TLS unavailable, using the platform default", e)
        null
    }

    class Result(val status: Int, val body: String) {
        fun toJson(): JSONObject {
            val data: Any = try {
                if (body.isBlank()) JSONObject.NULL else JSONTokener(body).nextValue()
            } catch (e: Exception) { body }
            return JSONObject().put("status", status).put("data", data)
        }

        val ok get() = status in 200..299

        fun errorMessage(fallback: String): Pair<String, String> {
            return try {
                val detail = JSONObject(body).opt("detail")
                when (detail) {
                    is JSONObject -> detail.optString("code", "error") to detail.optString("message", fallback)
                    is String -> "error" to detail
                    else -> "error" to fallback
                }
            } catch (e: Exception) {
                (if (status == 0) "network" else "error") to fallback
            }
        }
    }

    private fun build(ctx: Context, base: String, method: String, path: String, body: RequestBody?): Request {
        val b = Request.Builder()
            .url(base + "/api/v1" + path)
            .header("X-Device-Id", CgSession.deviceId(ctx))
            .header("X-Device-Model", CgSession.deviceModel())
            .header("X-HWID", CgSession.deviceId(ctx))
            .header("X-Device-OS", "Android")
            .header("X-Ver-OS", Build.VERSION.RELEASE ?: "")
            .header("X-App-Version", "${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE})")
            .header("Accept", "application/json")
        CgSession.accessToken?.let { b.header("Authorization", "Bearer $it") }
        val m = method.uppercase()
        val payload = body ?: if (m == "POST" || m == "PUT" || m == "PATCH") "".toRequestBody(JSON) else null
        return b.method(m, payload).build()
    }

    private fun once(req: Request): Result =
        try { client.newCall(req).execute().use { r -> Result(r.code, r.body?.string() ?: "") } }
        catch (e: Exception) { Result(0, "") }

    // try the known-good base first, then the others; the first one that answers at all becomes active
    private fun baseOrder(): List<String> =
        if (bases.size <= 1) bases else listOf(activeBase) + bases.filter { it != activeBase }

    private fun attempt(ctx: Context, method: String, path: String, body: () -> RequestBody?): Result {
        var last = Result(0, "")
        for (b in baseOrder()) {
            val r = once(build(ctx, b, method, path, body()))
            if (r.status != 0) { activeBase = b; return r }
            last = r
        }
        return last
    }

    private val refreshLock = Any()

    private fun refresh(ctx: Context, usedAccess: String?): Boolean = synchronized(refreshLock) {
        if (CgSession.accessToken != usedAccess && !CgSession.accessToken.isNullOrEmpty()) return true
        val rt = CgSession.refreshToken ?: return false
        val body = JSONObject().put("refresh_token", rt).toString().toRequestBody(JSON)
        val r = once(build(ctx, activeBase, "POST", "/auth/refresh", body))
        if (r.ok) {
            val t = JSONObject(r.body)
            CgSession.save(t.optString("access_token"), t.optString("refresh_token"), null)
            return true
        }
        if (r.status == 401) CgSession.clear()
        return false
    }

    /** Blocking; call from a background thread. */
    fun request(ctx: Context, method: String, path: String, jsonBody: String?): Result {
        val body = jsonBody?.toRequestBody(JSON)
        return send(ctx, method, path) { body }
    }

    fun upload(ctx: Context, path: String, fileName: String, mime: String, bytes: ByteArray, fields: Map<String, String>): Result {
        return send(ctx, "POST", path) {
            val mb = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("file", fileName, bytes.toRequestBody(mime.toMediaType()))
            fields.forEach { (k, v) -> mb.addFormDataPart(k, v) }
            mb.build()
        }
    }

    private fun send(ctx: Context, method: String, path: String, body: () -> RequestBody?): Result {
        val used = CgSession.accessToken
        val first = attempt(ctx, method, path, body)
        if (first.status == 401 && !path.startsWith("/auth/") && CgSession.loggedIn) {
            if (refresh(ctx, used)) return attempt(ctx, method, path, body)
        }
        return first
    }
}
