package app.pleat.pleat

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Bundle

/**
 * Invisible: it shows only Android's own VPN consent dialog for a widget
 * tap (the dialog needs an activity), starts the tunnel when the person
 * allows it, and closes. Pleat's own screens never open.
 */
class WidgetConnect : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        WidgetTrail.begin(this)
        val ask = try {
            VpnService.prepare(this)
        } catch (e: Exception) {
            WidgetTrail.step(this, "prepare_err", e)
            null
        }
        if (ask == null) {
            WidgetTrail.step(this, "consent_ok")
            go()
            finish()
        } else {
            WidgetTrail.step(this, "consent_ask")
            @Suppress("DEPRECATION")
            startActivityForResult(ask, ASK)
        }
    }

    @Deprecated("Activity result API is not used here")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        WidgetTrail.step(this, "consent_result_$resultCode")
        if (requestCode == ASK && resultCode == RESULT_OK) go()
        finish()
    }

    private fun go() {
        val i = Intent(this, PleatVpnService::class.java).setAction(StatusWidget.ACTION_WIDGET_START)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
            WidgetTrail.step(this, "fgs_sent")
        } catch (e: Exception) {
            // Android refused even from the front: noted, never a crash
            WidgetTrail.step(this, "fgs_err", e)
            Health.startRefused(this, e)
        }
    }

    override fun finish() {
        super.finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    private companion object {
        const val ASK = 71
    }
}
