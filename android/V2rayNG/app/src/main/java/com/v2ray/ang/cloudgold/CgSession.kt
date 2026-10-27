package com.v2ray.ang.cloudgold

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import com.tencent.mmkv.MMKV
import java.security.MessageDigest

/** Cloud Gold account session (API tokens) and a stable per-install device id. Lives in the UI process only. */
object CgSession {
    private val kv: MMKV by lazy { MMKV.mmkvWithID("cloudgold_session", MMKV.SINGLE_PROCESS_MODE) }

    private fun put(key: String, value: String?) {
        if (value.isNullOrEmpty()) kv.removeValueForKey(key) else kv.encode(key, value)
    }

    var accessToken: String?
        get() = kv.decodeString("access")
        set(v) = put("access", v)

    var refreshToken: String?
        get() = kv.decodeString("refresh")
        set(v) = put("refresh", v)

    var email: String?
        get() = kv.decodeString("email")
        set(v) = put("email", v)

    /** "direct" or "api": how the subscription was last downloaded successfully. */
    var subRoute: String?
        get() = kv.decodeString("sub_route")
        set(v) = put("sub_route", v)

    val loggedIn: Boolean get() = !refreshToken.isNullOrEmpty()

    fun save(access: String?, refresh: String?, email: String?) {
        accessToken = access
        refreshToken = refresh
        if (!email.isNullOrEmpty()) this.email = email
    }

    fun clear() {
        kv.removeValuesForKeys(arrayOf("access", "refresh", "email"))
    }

    /** A stable id for this phone + this app signing key (ANDROID_ID is already scoped per signing key on Android 8+). */
    @SuppressLint("HardwareIds")
    fun deviceId(ctx: Context): String {
        kv.decodeString("device")?.let { return it }
        val androidId = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        val seed = if (androidId.isNotEmpty()) androidId + ctx.packageName else java.util.UUID.randomUUID().toString()
        val hex = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray())
            .joinToString("") { "%02x".format(it) }.take(32)
        kv.encode("device", hex)
        return hex
    }

    fun deviceModel(): String {
        val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
        val model = Build.MODEL.orEmpty()
        return (if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model").trim().take(120)
    }
}
