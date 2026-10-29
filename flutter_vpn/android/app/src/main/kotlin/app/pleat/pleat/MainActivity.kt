package app.pleat.pleat

import android.content.Intent
import android.net.VpnService
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * Hosts the Flutter UI and the `pleat/tunnel` channel: available, start,
 * stop, state and systemSettings. State changes arrive on
 * `pleat/tunnel/state`.
 */
class MainActivity : FlutterActivity() {
    private companion object {
        const val ASK_VPN = 41
    }

    private var pendingConfig: String? = null
    private var pendingResult: MethodChannel.Result? = null

    override fun configureFlutterEngine(engine: FlutterEngine) {
        super.configureFlutterEngine(engine)
        EventChannel(engine.dartExecutor.binaryMessenger, "pleat/tunnel/state")
            .setStreamHandler(TunnelHub.stream)
        MethodChannel(engine.dartExecutor.binaryMessenger, "pleat/tunnel")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "available" -> result.success(engineLoads())
                    "state" -> result.success(TunnelHub.state)
                    "start" -> {
                        val config = call.argument<String>("config")
                        if (config == null) {
                            result.error("bad_config", "no config", null)
                            return@setMethodCallHandler
                        }
                        val ask = VpnService.prepare(this)
                        if (ask == null) {
                            launch(config)
                            result.success(null)
                        } else {
                            pendingResult?.error("replaced", "a newer start came in", null)
                            pendingConfig = config
                            pendingResult = result
                            startActivityForResult(ask, ASK_VPN)
                        }
                    }
                    "stop" -> {
                        startService(Intent(this, PleatVpnService::class.java).setAction(PleatVpnService.ACTION_STOP))
                        result.success(null)
                    }
                    "systemSettings" -> {
                        startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    @Deprecated("Activity result API is not used by FlutterActivity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != ASK_VPN) return
        val result = pendingResult ?: return
        val config = pendingConfig
        pendingResult = null
        pendingConfig = null
        if (resultCode == RESULT_OK && config != null) {
            launch(config)
            result.success(null)
        } else {
            result.error("denied", "VPN permission refused", null)
        }
    }

    private fun launch(config: String) {
        startService(
            Intent(this, PleatVpnService::class.java)
                .setAction(PleatVpnService.ACTION_START)
                .putExtra(PleatVpnService.EXTRA_CONFIG, config)
        )
    }

    /** True when this build ships the core and the tun library. */
    private fun engineLoads(): Boolean = try {
        Class.forName("libv2ray.Libv2ray")
        System.loadLibrary("hev-socks5-tunnel")
        true
    } catch (e: Throwable) {
        false
    }
}
