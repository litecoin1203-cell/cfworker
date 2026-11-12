package app.pleat.pleat

import android.content.Context
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.EventChannel

/**
 * The tunnel's state for the Flutter side: down | starting | up | failed.
 * The service sets it; the `pleat/tunnel/state` event channel reads it.
 */
object TunnelHub {
    @Volatile
    var state: String = "down"
        private set

    private val main = Handler(Looper.getMainLooper())
    private var sink: EventChannel.EventSink? = null

    /** For redrawing the home-screen widget; set by the service and the activity. */
    @Volatile
    var app: Context? = null

    fun set(next: String) {
        state = next
        main.post {
            sink?.success(next)
            app?.let { StatusWidget.refresh(it) }
        }
    }

    val stream = object : EventChannel.StreamHandler {
        override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
            sink = events
            events.success(state)
        }

        override fun onCancel(arguments: Any?) {
            sink = null
        }
    }
}
