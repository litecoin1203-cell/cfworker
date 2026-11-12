package app.pleat.pleat

/**
 * Turns what Android and the Go runtime leave behind after a native crash
 * into a few lines support can act on. Plain Kotlin (no Android classes), so
 * it is tested on the JVM: flutter_vpn/android/test/CrashNotesTest.kt.
 *
 * Two sources:
 *
 *  - The tombstone (Android 12+): ApplicationExitInfo.getTraceInputStream()
 *    of a REASON_CRASH_NATIVE exit is the crash in Android's own protobuf
 *    (system/core/debuggerd/proto/tombstone.proto). Read here: the signal,
 *    libc's abort message (fdsan, a failed check), the crashing thread and
 *    its top frames (which library: the Xray core libgojni.so, the tun's
 *    libhev-socks5-tunnel.so, Flutter's libflutter.so, or libc), and any
 *    "panic:" / "fatal error:" line the Go runtime wrote to the log.
 *
 *  - Go's own crash text: the core is a Go library inside this process, and
 *    an unhandled Go panic there aborts the whole app (SIGABRT, Go's rule
 *    for a library). Go writes the reason to stderr first; Health points
 *    stderr at a file, and [goPanic] picks the reason and the first frames
 *    out of it on the next launch.
 *
 * Only names of signals, libraries and functions leave; the caller blanks
 * every text again (Health.blank) before it is kept.
 */
object CrashNotes {
    /** Linux signal numbers on Android (ARM and x86 alike). */
    val SIGNALS = mapOf(
        1 to "SIGHUP", 2 to "SIGINT", 3 to "SIGQUIT", 4 to "SIGILL", 5 to "SIGTRAP", 6 to "SIGABRT",
        7 to "SIGBUS", 8 to "SIGFPE", 9 to "SIGKILL", 11 to "SIGSEGV", 13 to "SIGPIPE", 15 to "SIGTERM",
        16 to "SIGSTKFLT", 31 to "SIGSYS",
    )

    /** The app's own native libraries; a frame in one of them names the culprit. */
    private val OURS = listOf("libgojni.so", "libhev-socks5-tunnel.so", "libflutter.so", "libapp.so")

    // ---- the tombstone ------------------------------------------------------

    /** A gzip'ed trace (some Android builds keep them so) unpacked, at most 8 MB; anything else as it is. */
    fun unpack(bytes: ByteArray): ByteArray {
        if (bytes.size < 2 || bytes[0] != 0x1f.toByte() || bytes[1] != 0x8b.toByte()) return bytes
        return try {
            java.util.zip.GZIPInputStream(bytes.inputStream()).use { z ->
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(64 * 1024)
                while (out.size() < (8 shl 20)) {
                    val r = z.read(buf)
                    if (r < 0) break
                    out.write(buf, 0, r)
                }
                out.toByteArray()
            }
        } catch (e: Exception) {
            bytes
        }
    }

    /**
     * What Android handed over, in a few words: "empty", "120 KB, 6 facts",
     * or "120 KB, unread 0a1b2c3d" (its first bytes, to see what format it was).
     */
    fun tombState(head: ByteArray, size: Int, facts: Int): String = when {
        size == 0 -> "empty"
        facts > 0 -> "${(size + 1023) / 1024} KB, $facts facts"
        else -> "${(size + 1023) / 1024} KB, unread " + head.joinToString("") { "%02x".format(it) }
    }

    /** A tiny protobuf reader: enough to walk the tombstone, never more. */
    private class Pb(val b: ByteArray, var i: Int, val end: Int) {
        fun more() = i < end

        fun varint(): Long {
            var shift = 0
            var out = 0L
            while (i < end && shift < 64) {
                val x = b[i++].toInt() and 0xff
                out = out or ((x and 0x7f).toLong() shl shift)
                if (x and 0x80 == 0) return out
                shift += 7
            }
            throw IllegalStateException("bad varint")
        }

        /** The next field: (number, wire type); then read or skip its value. */
        fun tag(): Pair<Int, Int> {
            val t = varint()
            return Pair((t ushr 3).toInt(), (t and 7).toInt())
        }

        fun bytes(): Pb {
            val n = varint()
            if (n < 0 || n > end - i) throw IllegalStateException("bad length")
            val sub = Pb(b, i, i + n.toInt())
            i += n.toInt()
            return sub
        }

        fun string(): String = bytes().let { String(it.b, it.i, it.end - it.i, Charsets.UTF_8) }

        fun skip(wire: Int) {
            when (wire) {
                0 -> varint()
                1 -> i += 8
                2 -> bytes()
                5 -> i += 4
                else -> throw IllegalStateException("wire $wire")
            }
            if (i > end) throw IllegalStateException("past end")
        }
    }

    private class Frame(val file: String, val fn: String)

    private class Thread(val id: Int, val name: String, val frames: List<Frame>)

    /**
     * What the tombstone says, as flat facts: sig, abort, cause, thread, lib,
     * frames, go. Empty when the bytes are not a tombstone. A cut-off
     * tombstone gives what was read before the cut.
     */
    fun tombstone(bytes: ByteArray): Map<String, String> {
        var tid = -1
        var signal = ""
        var abort = ""
        var cause = ""
        val threads = mutableListOf<Thread>()
        val goLines = mutableListOf<String>()
        try {
            val p = Pb(bytes, 0, bytes.size)
            while (p.more()) {
                val (f, w) = p.tag()
                when {
                    f == 6 && w == 0 -> tid = p.varint().toInt()
                    f == 10 && w == 2 -> signal = signalOf(p.bytes())
                    f == 14 && w == 2 -> abort = p.string()
                    f == 15 && w == 2 && cause.isEmpty() -> cause = causeOf(p.bytes())
                    f == 16 && w == 2 -> threadEntry(p.bytes())?.let { threads.add(it) }
                    f == 18 && w == 2 -> logBuffer(p.bytes(), goLines)
                    else -> p.skip(w)
                }
            }
        } catch (e: Exception) {
            // cut off or not a tombstone: keep what was read
        }
        val out = linkedMapOf<String, String>()
        if (signal.isNotEmpty()) out["sig"] = signal
        if (abort.isNotBlank()) out["abort"] = abort.trim()
        if (cause.isNotBlank()) out["cause"] = cause.trim()
        // the crashing thread only: a cut-off tombstone may hold only others
        val crashed = if (tid >= 0) threads.firstOrNull { it.id == tid } else threads.firstOrNull()
        if (crashed != null) {
            if (crashed.name.isNotBlank()) out["thread"] = crashed.name.trim()
            val frames = crashed.frames
            val culprit = frames.firstOrNull { f -> OURS.any { f.file.endsWith("/$it") || f.file == it } }
                ?: frames.firstOrNull { f -> !SYSTEM_LIB.containsMatchIn(base(f.file)) }
                ?: frames.firstOrNull()
            if (culprit != null) out["lib"] = base(culprit.file)
            if (frames.isNotEmpty()) {
                out["frames"] = frames.take(8).joinToString(" | ") { f ->
                    val name = f.fn.ifEmpty { "?" }.take(60)
                    "${base(f.file)} $name"
                }
            }
        }
        goPanicLine(goLines)?.let { out["go"] = it }
        return out
    }

    /** Android's own libraries a crash passes through on its way to abort(). */
    private val SYSTEM_LIB = Regex("^(libc|libc\\+\\+|libbase|libart|libutils|liblog|libdl|linker64|linker|libandroid_runtime|libbinder|app_process\\d*|\\[)")

    private fun base(path: String): String = path.substringAfterLast('/').ifEmpty { path }

    private fun signalOf(p: Pb): String {
        var number = 0
        var name = ""
        var codeName = ""
        while (p.more()) {
            val (f, w) = p.tag()
            when {
                f == 1 && w == 0 -> number = p.varint().toInt()
                f == 2 && w == 2 -> name = p.string()
                f == 4 && w == 2 -> codeName = p.string()
                else -> p.skip(w)
            }
        }
        val n = name.ifEmpty { SIGNALS[number] ?: if (number > 0) "signal $number" else "" }
        return if (codeName.isNotEmpty() && n.isNotEmpty()) "$n ($codeName)" else n
    }

    private fun causeOf(p: Pb): String {
        while (p.more()) {
            val (f, w) = p.tag()
            if (f == 1 && w == 2) return p.string() else p.skip(w)
        }
        return ""
    }

    /** map<uint32, Thread>: an entry is {1: key, 2: Thread}. */
    private fun threadEntry(p: Pb): Thread? {
        var t: Thread? = null
        while (p.more()) {
            val (f, w) = p.tag()
            if (f == 2 && w == 2) t = threadOf(p.bytes()) else p.skip(w)
        }
        return t
    }

    private fun threadOf(p: Pb): Thread {
        var id = 0
        var name = ""
        val frames = mutableListOf<Frame>()
        while (p.more()) {
            val (f, w) = p.tag()
            when {
                f == 1 && w == 0 -> id = p.varint().toInt()
                f == 2 && w == 2 -> name = p.string()
                f == 4 && w == 2 -> if (frames.size < 16) frames.add(frameOf(p.bytes())) else p.skip(w)
                else -> p.skip(w)
            }
        }
        return Thread(id, name, frames)
    }

    private fun frameOf(p: Pb): Frame {
        var fn = ""
        var file = ""
        while (p.more()) {
            val (f, w) = p.tag()
            when {
                f == 4 && w == 2 -> fn = p.string()
                f == 6 && w == 2 -> file = p.string()
                else -> p.skip(w)
            }
        }
        return Frame(file, fn)
    }

    /** The process's last log lines: kept are the Go runtime's and libc's own. */
    private fun logBuffer(p: Pb, out: MutableList<String>) {
        while (p.more()) {
            val (f, w) = p.tag()
            if (f == 2 && w == 2) {
                val m = p.bytes()
                var tag = ""
                var msg = ""
                while (m.more()) {
                    val (g, x) = m.tag()
                    when {
                        g == 5 && x == 2 -> tag = m.string()
                        g == 6 && x == 2 -> msg = m.string()
                        else -> m.skip(x)
                    }
                }
                if ((tag == "Go" || tag == "GoLog" || tag == "libc") && out.size < 400) out.add(msg.trimEnd())
            } else {
                p.skip(w)
            }
        }
    }

    // ---- Go's crash text ----------------------------------------------------

    private val PANIC = Regex("^(panic: |fatal error: |runtime: |unexpected fault address|fatal: morestack|SIGSEGV|SIGBUS|SIGABRT)")
    private val GOROUTINE = Regex("^goroutine \\d+ \\[")

    /** Go's own runtime frames: where every panic passes, never its cause. */
    private val GO_OWN = Regex("^(runtime\\.|internal/runtime/|sync\\.|panic\\()")

    private fun goPanicLine(lines: List<String>): String? {
        val i = lines.indexOfFirst { PANIC.containsMatchIn(it) }
        return if (i < 0) null else goSummary(lines.drop(i))
    }

    /**
     * Go's crash text (stderr) to one line: the reason, then the first
     * functions of the goroutine that crashed, outside Go's own runtime.
     * Null when the text holds no Go crash.
     */
    fun goPanic(text: String): String? {
        val lines = text.lineSequence().map { it.trimEnd() }.toList()
        // the last crash in the file is this one; earlier lines are old start notes
        val i = lines.indexOfLast { PANIC.containsMatchIn(it) && !it.startsWith("runtime: ") }
            .takeIf { it >= 0 } ?: lines.indexOfFirst { PANIC.containsMatchIn(it) }
        if (i < 0) return null
        // "panic: x [recovered]" lines and "runtime: ..." notes just above belong to it
        var start = i
        while (start > 0 && (lines[start - 1].startsWith("panic: ") || lines[start - 1].startsWith("runtime: "))) start--
        return goSummary(lines.drop(start))
    }

    private fun goSummary(lines: List<String>): String {
        val reason = lines.takeWhile { it.isNotBlank() && !GOROUTINE.containsMatchIn(it) }
            .take(3).joinToString(" / ") { it.trim() }
        val g = lines.indexOfFirst { GOROUTINE.containsMatchIn(it) }
        val fns = if (g < 0) emptyList() else lines.drop(g + 1).asSequence()
            .takeWhile { it.isNotBlank() && !GOROUTINE.containsMatchIn(it) }
            .filter { !it.startsWith("\t") && !it.startsWith(" ") && !it.startsWith("created by") }
            .filter { !GO_OWN.containsMatchIn(it) }
            .map { shortFn(it) }
            .take(4).toList()
        return if (fns.isEmpty()) reason else "$reason @ ${fns.joinToString(" < ")}"
    }

    /** "github.com/xtls/xray-core/proxy/vless/outbound.(*Handler).Process.func3(...)" → "vless/outbound·(*Handler)·Process·func3" */
    private fun shortFn(line: String): String {
        val call = line.substringBefore('(').let { head ->
            // keep "(*Type)" receivers: cut the argument list, which is the last "(...)"
            val open = line.lastIndexOf('(')
            if (open > 0 && line.endsWith(")")) line.substring(0, open) else head
        }
        val parts = call.split('/')
        // "·" instead of ".": "buf.ReadBuffer" would read as a host name to the scrubbers
        return parts.takeLast(2).joinToString("/").replace('.', '\u00b7').take(80)
    }
}
