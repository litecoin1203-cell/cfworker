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

        init {
            System.loadLibrary("hev-socks5-tunnel")
        }
    }
}
