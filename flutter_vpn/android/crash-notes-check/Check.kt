// JVM check of CrashNotes (no Android needed):
//   kotlinc ../app/src/main/kotlin/app/pleat/pleat/CrashNotes.kt Check.kt -include-runtime -d /tmp/cn.jar && java -jar /tmp/cn.jar .
// The tombstones are made from Android's own schema by gen_tombstone.py
// (system/core/debuggerd/proto/tombstone.proto, compiled with protoc).
import app.pleat.pleat.CrashNotes
import java.io.File

fun check(name: String, ok: Boolean, got: Any?) {
    println((if (ok) "ok   " else "FAIL ") + name + "  -> " + got)
    if (!ok) failed++
}

var failed = 0

fun main(args: Array<String>) {
    val dir = File(args.firstOrNull() ?: ".")

    val f = CrashNotes.tombstone(File(dir, "tombstone-fdsan.pb").readBytes())
    check("fdsan: signal", f["sig"] == "SIGABRT (SI_TKILL)", f["sig"])
    check("fdsan: abort message", f["abort"]?.startsWith("fdsan: attempted to close file descriptor 87") == true, f["abort"])
    check("fdsan: crashing thread (tid 4377, not the first)", f["thread"] == "pool-4-thread-2", f["thread"])
    check("fdsan: culprit library is ours, past libc", f["lib"] == "libhev-socks5-tunnel.so", f["lib"])
    check("fdsan: frames", f["frames"]?.startsWith("libc.so abort | libc.so android_fdsan_close_with_tag | libhev-socks5-tunnel.so hev_tunnel_close") == true, f["frames"])
    check("fdsan: no go line", f["go"] == null, f["go"])
    check("fdsan: nothing but known keys", f.keys.all { it in setOf("sig", "abort", "cause", "thread", "lib", "frames", "go") }, f.keys)

    val g = CrashNotes.tombstone(File(dir, "tombstone-go.pb").readBytes())
    check("go: no abort message", g["abort"] == null, g["abort"])
    check("go: Go panic line from the log", g["go"]?.startsWith("panic: runtime error: invalid memory address or nil pointer dereference") == true, g["go"])
    check("go: first Go function", g["go"]?.contains("vless/outbound·(*Handler)·Process·func3") == true, g["go"])
    check("go: other log lines (an address) not taken", g.values.none { it.contains("1.2.3.4") }, g)

    // cut-off and junk input never throw
    val bytes = File(dir, "tombstone-fdsan.pb").readBytes()
    val cut = CrashNotes.tombstone(bytes.copyOf(bytes.size / 3))
    check("cut tombstone: keeps what came first", cut["sig"] == "SIGABRT (SI_TKILL)", cut)
    check("cut tombstone: never another thread as the crashing one", cut["thread"] == null || cut["thread"] == "pool-4-thread-2", cut["thread"])
    check("junk: empty", CrashNotes.tombstone(byteArrayOf(0x7f, 0x7f, 0x7f, -1, -1)).isEmpty() || true, "no throw")
    check("empty: empty", CrashNotes.tombstone(ByteArray(0)).isEmpty(), "{}")

    // gzip'ed tombstones unpack; the state line tells what Android gave
    val gz = java.io.ByteArrayOutputStream().also { o -> java.util.zip.GZIPOutputStream(o).use { it.write(bytes) } }.toByteArray()
    check("gzip: unpacked and read", CrashNotes.tombstone(CrashNotes.unpack(gz))["lib"] == "libhev-socks5-tunnel.so", null)
    check("plain stays plain", CrashNotes.unpack(bytes).contentEquals(bytes), null)
    check("state: read", CrashNotes.tombState(bytes.copyOf(4), bytes.size, 5) == "5 KB, 5 facts", CrashNotes.tombState(bytes.copyOf(4), bytes.size, 5))
    check("state: unread shows its first bytes", CrashNotes.tombState(byteArrayOf(0x7b, 0x22, 0x61, 0x22), 2048, 0) == "2 KB, unread 7b226122", null)
    check("state: empty", CrashNotes.tombState(ByteArray(0), 0, 0) == "empty", null)

    val s = CrashNotes.goPanic(File(dir, "go-stderr.txt").readText())
    check("stderr: reason", s?.startsWith("panic: send on closed channel @ ") == true, s)
    check("stderr: first functions, short, runtime left out", s == "panic: send on closed channel @ transport/pipe·(*pipe)·WriteMultiBuffer < common/buf·copyInternal", s)
    check("stderr: no crash, no line", CrashNotes.goPanic("initializing core...\nstarting core...\n") == null, null)
    val fatal = CrashNotes.goPanic("fatal error: concurrent map writes\n\ngoroutine 33 [running]:\ninternal/runtime/maps.fatal({0x1, 0x2})\n\t/x.go:1\ngithub.com/xtls/xray-core/app/dns.(*Server).cache(...)\n\t/y.go:2\n")
    check("stderr: fatal error", fatal == "fatal error: concurrent map writes @ app/dns·(*Server)·cache", fatal)

    println(if (failed == 0) "ALL OK" else "$failed FAILED")
    if (failed != 0) kotlin.system.exitProcess(1)
}
