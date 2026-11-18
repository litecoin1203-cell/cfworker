package app.pleat.pleat

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parts of Health and Updates that need no phone (QA-01). Every value is made up: example.com hosts,
 * documentation IPs (192.0.2.x, 2001:db8::), a zero UUID.
 */
class HealthTest {
    private val uuid = "00000000-0000-4000-8000-000000000000"

    @Test
    fun blankRemovesAddressesLinksIdsAndKeys() {
        val text = "dial tcp 192.0.2.7:443 via vless://$uuid@node.example.com:8443?sni=cdn.example.org " +
            "[2001:db8::1]:443 key ${"A".repeat(30)}== host exit.example.net:2053"
        val out = Health.blank(text)
        for (secret in listOf("192.0.2.7", uuid, "node.example.com", "2001:db8", "A".repeat(24), "exit.example.net")) {
            assertFalse("$secret leaked: $out", out.contains(secret))
        }
        assertTrue(out, out.contains("<ip>") && out.contains("<link>") && out.contains("<blob>") && out.contains("<host>"))
        assertEquals("<id>", Health.blank(uuid))
    }

    @Test
    fun blankKeepsCodeNames() {
        // a stack frame stays readable: class and file names are not hosts
        val frame = "java.net.SocketException at app.pleat.pleat.PleatVpnService.start(PleatVpnService.kt:120) in libgojni.so"
        assertEquals(frame, Health.blank(frame))
    }

    @Test
    fun blankCodeKeepsLongFunctionNamesButNotAddresses() {
        val text = "runtime.raise ${"x".repeat(40)} 192.0.2.9 https://example.com/a $uuid"
        val out = Health.blankCode(text)
        assertTrue(out, out.startsWith("runtime.raise ${"x".repeat(40)} "))
        assertFalse(out, out.contains("192.0.2.9") || out.contains("example.com") || out.contains(uuid))
    }

    @Test
    fun startErrorIsBlankedShortAndTakenOnce() {
        Health.startFailed(RuntimeException("no route to 192.0.2.1:443 " + "y".repeat(400)))
        val e = Health.takeStartError()
        assertTrue("$e", e != null && e.length <= 200 && !e.contains("192.0.2.1"))
        assertNull(Health.takeStartError())
        Health.startFailed(IllegalStateException())
        assertEquals("IllegalStateException", Health.takeStartError())
        Health.startFailed(null)
        assertNull(Health.takeStartError())
    }

    @Test
    fun stderrAtReadsOnlyThatProcess() {
        fun j(vararg kv: Pair<String, Any>) = JSONObject().apply { kv.forEach { (k, v) -> put(k, v) } }
        val t = 1_000_000L
        assertEquals("not captured in that process", Health.stderrAt(listOf(j("pid" to 2, "cap" to "ok")), emptyList(), 1, t))
        assertEquals("dup2 failed", Health.stderrAt(listOf(j("pid" to 1, "cap" to "dup2 failed")), emptyList(), 1, t))
        assertEquals("captured, file not read yet", Health.stderrAt(listOf(j("pid" to 1, "cap" to "ok")), emptyList(), 1, t))
        val caps = listOf(j("pid" to 1, "cap" to "ok"))
        assertEquals("written at the crash: panic", Health.stderrAt(caps, listOf(j("pid" to 1, "at" to t - 5_000, "tail" to "panic", "size" to 9)), 1, t))
        assertEquals("quiet at the crash (nothing written)", Health.stderrAt(caps, listOf(j("pid" to 1, "at" to t - 500_000, "size" to 0)), 1, t))
        assertEquals("quiet at the crash (last write 500s before: x)", Health.stderrAt(caps, listOf(j("pid" to 1, "at" to t - 500_000, "tail" to "x", "size" to 3)), 1, t))
    }

    @Test
    fun goLineIsMatchedByProcess() {
        fun j(vararg kv: Pair<String, Any>) = JSONObject().apply { kv.forEach { (k, v) -> put(k, v) } }
        val t = 1_000_000L
        val gos = listOf(
            j("pid" to 1, "at" to t - 1_000, "line" to "panic: close of closed channel @ a·b"),
            j("pid" to 2, "at" to t + 9_000_000, "line" to "panic: other"),
        )
        assertEquals("panic: close of closed channel @ a·b", Health.goLineOf(gos, 1, t))
        assertNull("another process's line is never taken", Health.goLineOf(gos, 3, t))
        assertNull("written long before the crash", Health.goLineOf(gos, 2, t))
    }

    @Test
    fun updateSha256() {
        val f = File.createTempFile("pleat", ".apk")
        try {
            assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Updates.sha256(f))
            f.writeText("abc")
            assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Updates.sha256(f))
            // bigger than the 256 KB read buffer: the hash covers every chunk
            val big = ByteArray(600 * 1024) { (it % 251).toByte() }
            Files.write(f.toPath(), big)
            val want = java.security.MessageDigest.getInstance("SHA-256").digest(big).joinToString("") { "%02x".format(it) }
            assertEquals(want, Updates.sha256(f))
        } finally {
            f.delete()
        }
    }
}
