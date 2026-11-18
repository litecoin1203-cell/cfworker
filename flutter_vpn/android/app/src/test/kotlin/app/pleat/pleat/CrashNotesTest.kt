package app.pleat.pleat

import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.GZIPOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CrashNotes on the JVM (QA-01): the same checks as crash-notes-check/Check.kt, on its tombstones, which are made
 * from Android's own schema by crash-notes-check/gen_tombstone.py. Gradle runs unit tests in the module folder
 * (android/app).
 */
class CrashNotesTest {
    private val dir = File("../crash-notes-check")
    private fun read(name: String) = File(dir, name).readBytes()

    @Test
    fun fdsanAbort() {
        val f = CrashNotes.tombstone(read("tombstone-fdsan.pb"))
        assertEquals("SIGABRT (SI_TKILL) from itself", f["sig"])
        assertTrue(f["abort"].orEmpty().startsWith("fdsan: attempted to close file descriptor 87"))
        assertEquals("the crashing thread (tid 4377, not the first)", "pool-4-thread-2", f["thread"])
        assertEquals("the culprit library is ours, past libc", "libhev-socks5-tunnel.so", f["lib"])
        assertTrue(f["frames"].orEmpty().startsWith("libc.so abort | libc.so android_fdsan_close_with_tag | libhev-socks5-tunnel.so hev_tunnel_close"))
        assertNull(f["go"])
        val known = setOf("sig", "abort", "cause", "thread", "lib", "frames", "addr", "logs", "go")
        assertTrue("only known keys: ${f.keys}", f.keys.all { it in known })
        assertEquals("libc.so+0x1234 < +0x1234 < libhev-socks5-tunnel.so < libhev-socks5-tunnel.so", f["addr"])
    }

    @Test
    fun goPanicInTheLog() {
        val g = CrashNotes.tombstone(read("tombstone-go.pb"))
        assertNull(g["abort"])
        assertTrue(g["go"].orEmpty().startsWith("panic: runtime error: invalid memory address or nil pointer dereference"))
        assertTrue(g["go"].orEmpty().contains("vless/outbound·(*Handler)·Process·func3"))
        assertTrue("an address in another log line is not taken: $g", g.values.none { it.contains("1.2.3.4") })
        assertEquals("8 lines", g["logs"])
    }

    @Test
    fun goOwnCrashKeepsOffsetsOnly() {
        val j = CrashNotes.tombstone(read("tombstone-gojni.pb"))
        assertEquals("app.pleat.pleat (main)", j["thread"])
        assertEquals("SIGABRT (SI_TKILL) from itself", j["sig"])
        assertEquals("libgojni.so", j["lib"])
        assertEquals("libgojni.so+0x10b30f8 < +0x108c040 < +0x108bfa0 < +0x1063a10 < +0x1c3d000", j["addr"])
        assertTrue("no address of the process leaks: $j", j.values.none { it.contains("7a0") || it.contains("7ff0") })
    }

    @Test
    fun codeWordsInTheStackCopyAsOffsets() {
        val base = 0x7a00000000L
        fun words(vararg v: Long): ByteArray {
            val b = ByteArray(v.size * 8)
            v.forEachIndexed { i, x -> for (k in 0 until 8) b[i * 8 + k] = (x ushr (8 * k)).toByte() }
            return b
        }
        val dumps = listOf(
            0x7ff0002000L to words(42L, base + 0x103c0a8, base + 0x10b30f8, 0x7fff0000L),
            0x7ff0001000L to words(base + 0x2a00010, base + 0x1063a10),
        )
        // lower addresses first; skips what the chain already named; only the library's code
        assertEquals(
            "+0x2a00010 +0x103c0a8",
            CrashNotes.codeWords(dumps, base + 0x1000000, base + 0x3000000, base, "libgojni.so+0x10b30f8 < +0x1063a10"),
        )
        assertEquals("", CrashNotes.codeWords(emptyList(), base, base + 1, base, ""))
    }

    @Test
    fun cutOrJunkInputNeverThrows() {
        val bytes = read("tombstone-fdsan.pb")
        val cut = CrashNotes.tombstone(bytes.copyOf(bytes.size / 3))
        assertTrue(cut["sig"].orEmpty().startsWith("SIGABRT (SI_TKILL)"))
        assertTrue(cut["thread"] == null || cut["thread"] == "pool-4-thread-2")
        CrashNotes.tombstone(byteArrayOf(0x7f, 0x7f, 0x7f, -1, -1))
        assertTrue(CrashNotes.tombstone(ByteArray(0)).isEmpty())
    }

    @Test
    fun gzipAndState() {
        val bytes = read("tombstone-fdsan.pb")
        val gz = ByteArrayOutputStream().also { o -> GZIPOutputStream(o).use { it.write(bytes) } }.toByteArray()
        assertEquals("libhev-socks5-tunnel.so", CrashNotes.tombstone(CrashNotes.unpack(gz))["lib"])
        assertArrayEquals(bytes, CrashNotes.unpack(bytes))
        assertEquals("5 KB, 5 facts", CrashNotes.tombState(bytes.copyOf(4), 5000, 5))
        assertEquals("2 KB, unread 7b226122", CrashNotes.tombState(byteArrayOf(0x7b, 0x22, 0x61, 0x22), 2048, 0))
        assertEquals("empty", CrashNotes.tombState(ByteArray(0), 0, 0))
    }

    @Test
    fun goStderr() {
        val s = CrashNotes.goPanic(File(dir, "go-stderr.txt").readText())
        assertEquals("panic: send on closed channel @ transport/pipe·(*pipe)·WriteMultiBuffer < common/buf·copyInternal", s)
        assertNull(CrashNotes.goPanic("initializing core...\nstarting core...\n"))
        val fatal = CrashNotes.goPanic(
            "fatal error: concurrent map writes\n\ngoroutine 33 [running]:\ninternal/runtime/maps.fatal({0x1, 0x2})\n\t/x.go:1\n" +
                "github.com/xtls/xray-core/app/dns.(*Server).cache(...)\n\t/y.go:2\n",
        )
        assertEquals("fatal error: concurrent map writes @ app/dns·(*Server)·cache", fatal)
    }
}
