package app.pleat.pleat

import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import java.util.concurrent.Executors
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

    /** Server tests run a few at a time, off the main thread. */
    private val tests = Executors.newFixedThreadPool(4)
    private val main = Handler(Looper.getMainLooper())

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
                    "device" -> {
                        val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
                        val model = Build.MODEL.orEmpty()
                        result.success(if (model.startsWith(maker, true)) model else "$maker $model".trim())
                    }
                    "geo" -> background(result, false) { Engine.init(this); Engine.hasGeo(this) }
                    "ping" -> {
                        val config = call.argument<String>("config")
                        if (config == null) {
                            result.success(-1)
                            return@setMethodCallHandler
                        }
                        background(result) {
                            Engine.init(this)
                            libv2ray.Libv2ray.measureOutboundDelay(config, Engine.TEST_URL).toInt()
                        }
                    }
                    "delay" -> background(result) {
                        PleatVpnService.running?.measureDelay(Engine.TEST_URL)?.toInt() ?: -1
                    }
                    "policy" -> {
                        // Android tells only the running service (10 and newer).
                        val svc = PleatVpnService.instance
                        result.success(
                            if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                mapOf("known" to true, "alwaysOn" to svc.isAlwaysOn, "lockdown" to svc.isLockdownEnabled)
                            } else {
                                mapOf("known" to false)
                            }
                        )
                    }
                    "systemSettings" -> {
                        startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    /** Runs [work] on the test pool and answers on the main thread; a failure answers [fallback]. */
    private fun background(result: MethodChannel.Result, fallback: Any = -1, work: () -> Any) {
        tests.execute {
            val value: Any = try {
                work()
            } catch (e: Throwable) {
                fallback
            }
            main.post { result.success(value) }
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
