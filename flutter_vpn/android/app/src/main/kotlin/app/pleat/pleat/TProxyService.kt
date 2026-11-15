package app.pleat.pleat

/**
 * JNI entry points of hev-socks5-tunnel, built with PKGNAME=app/pleat/pleat
 * (see compile-hevtun.sh). It reads packets from the tun fd and hands them
 * to the core's local SOCKS port.
 */
class TProxyService {
    companion object {
        @JvmStatic
        @Suppress("FunctionName")
        external fun TProxyStartService(configPath: String, fd: Int)

        @JvmStatic
        @Suppress("FunctionName")
        external fun TProxyStopService()

        /** The service whose tun hev serves now; hev is one per process. */
        private var owner: Any? = null

        /**
         * Starts hev for [owner]. hev ignores a start while it runs, so one
         * still running for an older service (its teardown not done yet) is
         * stopped first (AND-06).
         */
        @JvmStatic
        fun start(owner: Any, configPath: String, fd: Int) = synchronized(this) {
            if (this.owner != null) {
                try { TProxyStopService() } catch (e: Exception) {}
            }
            TProxyStartService(configPath, fd)
            this.owner = owner
        }

        /**
         * Stops hev only when [owner] started it last: an old service that
         * tears down late must not stop a newer one's (AND-06).
         */
        @JvmStatic
        fun stop(owner: Any) = synchronized(this) {
            if (this.owner === owner) {
                try { TProxyStopService() } catch (e: Exception) {}
                this.owner = null
            }
        }

        init {
            System.loadLibrary("hev-socks5-tunnel")
        }
    }
}
