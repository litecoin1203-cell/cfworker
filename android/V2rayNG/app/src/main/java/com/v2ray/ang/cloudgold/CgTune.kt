package com.v2ray.ang.cloudgold

import android.content.Context
import com.v2ray.ang.handler.MmkvManager
import com.v2ray.ang.handler.SettingsManager

/**
 * Connection tuning applied once on first launch (and switchable from the app):
 * Iranian sites and IPs go direct (faster, they often block foreign IPs, and they don't use the user's plan
 * data), QUIC on UDP 443 is blocked so apps fall back to TCP, which is far steadier through the tunnel.
 * Uses v2rayNG's own "white_iran" routing preset, so the stock core handles it.
 */
object CgTune {
    private const val APPLIED = "cg_tune_applied_v1"
    private const val IRAN = "cg_iran_direct"
    private const val PRESET_DEFAULT = 0   // RoutingType.WHITE
    private const val PRESET_IRAN = 3      // RoutingType.WHITE_IRAN

    fun applyDefaults(ctx: Context) {
        if (MmkvManager.decodeSettingsBool(APPLIED, false)) return
        try { setIranDirect(ctx, true) } catch (_: Exception) {}
        MmkvManager.encodeSettings(APPLIED, true)
    }

    fun iranDirect(): Boolean = MmkvManager.decodeSettingsBool(IRAN, false)

    fun setIranDirect(ctx: Context, on: Boolean) {
        SettingsManager.resetRoutingRulesetsFromPresets(ctx, if (on) PRESET_IRAN else PRESET_DEFAULT)
        MmkvManager.encodeSettings(IRAN, on)
    }
}
