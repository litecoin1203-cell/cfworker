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

    private class Frame(val file: String, val fn: String, val relPc: Long, val pc: Long)

    /** Memory Android copied next to one register (a few hundred bytes). */
    private class Dump(val begin: Long, val mem: ByteArray)

    private class Thread(
        val id: Int,
        val name: String,
        val frames: List<Frame>,
        val regs: Map<String, Long>,
        val dumps: List<Dump>,
    )

    private class Mapping(val begin: Long, val end: Long, val name: String)

    /**
     * What the tombstone says, as flat facts: sig (and who sent it), abort,
     * cause, thread, lib, frames, addr, logs, go. Empty when the bytes are
     * not a tombstone. A cut-off
     * tombstone gives what was read before the cut.
     */
    fun tombstone(bytes: ByteArray): Map<String, String> {
        var pid = -1
        var tid = -1
        var signal = ""
        var senderPid = -1
        var senderUid = 0
        var logLines = 0
        val maps = mutableListOf<Mapping>()
        var abort = ""
        var cause = ""
        val threads = mutableListOf<Thread>()
        val goLines = mutableListOf<String>()
        try {
            val p = Pb(bytes, 0, bytes.size)
            while (p.more()) {
                val (f, w) = p.tag()
                when {
                    f == 5 && w == 0 -> pid = p.varint().toInt()
                    f == 6 && w == 0 -> tid = p.varint().toInt()
                    f == 10 && w == 2 -> signalOf(p.bytes()).let { signal = it.first; senderPid = it.second; senderUid = it.third }
                    f == 14 && w == 2 -> abort = p.string()
                    f == 15 && w == 2 && cause.isEmpty() -> cause = causeOf(p.bytes())
                    f == 16 && w == 2 -> threadEntry(p.bytes())?.let { threads.add(it) }
                    f == 17 && w == 2 -> if (maps.size < 4000) mappingOf(p.bytes())?.let { maps.add(it) } else p.skip(w)
                    f == 18 && w == 2 -> logLines += logBuffer(p.bytes(), goLines)
                    else -> p.skip(w)
                }
            }
        } catch (e: Exception) {
            // cut off or not a tombstone: keep what was read
        }
        val out = linkedMapOf<String, String>()
        if (signal.isNotEmpty()) {
            // who sent it: the crashing process itself (abort(), Go's own crash),
            // or another process (Android, another app) killing this one
            // (another sender's uid tells Android, 1000, apart from an app)
            val from = when {
                senderPid < 0 -> ""
                senderPid == pid -> " from itself"
                else -> " from pid $senderPid uid $senderUid"
            }
            out["sig"] = signal + from
        }
        if (abort.isNotBlank()) out["abort"] = abort.trim()
        if (cause.isNotBlank()) out["cause"] = cause.trim()
        // the crashing thread only: a cut-off tombstone may hold only others
        val crashed = if (tid >= 0) threads.firstOrNull { it.id == tid } else threads.firstOrNull()
        if (crashed != null) {
            // Go's own threads take the name of the thread that loaded the core,
            // so "main" (its id is the process id) is told apart here
            val main = if (pid > 0 && crashed.id == pid) " (main)" else ""
            if (crashed.name.isNotBlank()) out["thread"] = crashed.name.trim() + main
            val frames = crashed.frames
            val culprit = frames.firstOrNull { f -> base(f.file) in OURS }
                ?: frames.firstOrNull { f -> !SYSTEM_LIB.containsMatchIn(base(f.file)) }
                ?: frames.firstOrNull()
            if (culprit != null) out["lib"] = base(culprit.file)
            if (frames.isNotEmpty()) {
                out["frames"] = frames.take(8).joinToString(" | ") { f ->
                    val name = f.fn.ifEmpty { "?" }.take(60)
                    "${base(f.file)} $name"
                }
            }
            addresses(crashed, maps).takeIf { it.isNotEmpty() }?.let { out["addr"] = it }
        }
        // whether this tombstone carried the process's log at all: without
        // one, "no Go line in it" says nothing
        if (out.isNotEmpty()) out["logs"] = "$logLines lines"
        goPanicLine(goLines)?.let { out["go"] = it }
        return out
    }

    /**
     * Where the crashing thread was, as "lib+0xoffset" inside its library,
     * then who called it. Android stops its backtrace at the first Go frame
     * (Go code has no unwind tables), so the link register and Go's frame
     * pointer chain (arm64: [x29] = the caller's x29, [x29+8] = its return
     * address), read from the stack memory Android copied, name the callers.
     * Offsets only: the function names come from the same libgojni.so (its
     * Go symbol table survives stripping), looked up offline.
     */
    private fun addresses(t: Thread, maps: List<Mapping>): String {
        val top = t.frames.firstOrNull() ?: return ""
        if (top.pc == 0L) return ""
        // pc - rel_pc is where this library's offsets start, in this process
        val home = maps.firstOrNull { top.pc >= it.begin && top.pc < it.end }
        val shift = top.pc - top.relPc
        val lib = base(top.file)
        fun hex(v: Long) = "+0x" + java.lang.Long.toHexString(v)
        fun name(a: Long): String? = when {
            a == 0L -> null
            home != null && a >= home.begin && a < home.end -> hex(a - shift)
            else -> maps.firstOrNull { a >= it.begin && a < it.end }?.let { base(it.name).ifEmpty { "?" } }
        }
        val out = mutableListOf(lib + hex(top.relPc))
        // the frames Android did unwind, past the first
        for (f in t.frames.drop(1).take(3)) out.add(if (base(f.file) == lib) hex(f.relPc) else base(f.file))
        if (t.frames.size <= 1) {
            fun read(a: Long): Long? {
                for (d in t.dumps) {
                    val i = a - d.begin
                    if (i >= 0 && i + 8 <= d.mem.size) {
                        var v = 0L
                        for (b in 7 downTo 0) v = (v shl 8) or (d.mem[(i + b).toInt()].toLong() and 0xff)
                        return v
                    }
                }
                return null
            }
            (t.regs["lr"] ?: t.regs["x30"])?.let { lr -> name(lr)?.let { out.add(it) } }
            var fp = t.regs["x29"] ?: t.regs["fp"] ?: 0L
            var hops = 0
            while (fp != 0L && hops < 6) {
                val ret = read(fp + 8) ?: break
                val next = read(fp) ?: break
                out.add(name(ret) ?: break)
                if (next <= fp) break // the stack grows down: callers sit higher
                fp = next
                hops++
            }
        }
        return out.take(8).joinToString(" < ")
    }

    private fun mappingOf(p: Pb): Mapping? {
        var begin = 0L
        var end = 0L
        var exec = false
        var name = ""
        while (p.more()) {
            val (f, w) = p.tag()
            when {
                f == 1 && w == 0 -> begin = p.varint()
                f == 2 && w == 0 -> end = p.varint()
                f == 6 && w == 0 -> exec = p.varint() != 0L
                f == 7 && w == 2 -> name = p.string()
                else -> p.skip(w)
            }
        }
        // only code: a return address is never anywhere else
        return if (exec && end > begin) Mapping(begin, end, name) else null
    }

    /** Android's own libraries a crash passes through on its way to abort(). */
    private val SYSTEM_LIB = Regex("^(libc|libc\\+\\+|libbase|libart|libutils|liblog|libdl|linker64|linker|libandroid_runtime|libbinder|app_process\\d*|\\[)")

    // "/data/app/.../lib/arm64/libgojni.so", or "/data/app/.../base.apk!libgojni.so" when Android runs it from the APK
    private fun base(path: String): String = path.substringAfterLast('/').substringAfterLast('!').ifEmpty { path }

    /** The signal in words, and its sender's pid and uid (pid -1: the kernel sent it). */
    private fun signalOf(p: Pb): Triple<String, Int, Int> {
        var number = 0
        var name = ""
        var codeName = ""
        var hasSender = false
        var senderUid = 0
        var senderPid = 0
        while (p.more()) {
            val (f, w) = p.tag()
            when {
                f == 1 && w == 0 -> number = p.varint().toInt()
                f == 2 && w == 2 -> name = p.string()
                f == 4 && w == 2 -> codeName = p.string()
                f == 5 && w == 0 -> hasSender = p.varint() != 0L
                f == 6 && w == 0 -> senderUid = p.varint().toInt()
                f == 7 && w == 0 -> senderPid = p.varint().toInt()
                else -> p.skip(w)
            }
        }
        val n = name.ifEmpty { SIGNALS[number] ?: if (number > 0) "signal $number" else "" }
        val sig = if (codeName.isNotEmpty() && n.isNotEmpty()) "$n ($codeName)" else n
        return Triple(sig, if (hasSender) senderPid else -1, senderUid)
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
        val regs = mutableMapOf<String, Long>()
        val dumps = mutableListOf<Dump>()
        while (p.more()) {
            val (f, w) = p.tag()
            when {
                f == 1 && w == 0 -> id = p.varint().toInt()
                f == 2 && w == 2 -> name = p.string()
                f == 3 && w == 2 -> registerOf(p.bytes())?.let { regs[it.first] = it.second }
                f == 4 && w == 2 -> if (frames.size < 16) frames.add(frameOf(p.bytes())) else p.skip(w)
                f == 5 && w == 2 -> if (dumps.size < 40) dumpOf(p.bytes())?.let { dumps.add(it) } else p.skip(w)
                else -> p.skip(w)
            }
        }
        return Thread(id, name, frames, regs, dumps)
    }

    private val CHAIN_REGS = setOf("lr", "x30", "x29", "fp")

    private fun registerOf(p: Pb): Pair<String, Long>? {
        var name = ""
        var v = 0L
        while (p.more()) {
            val (f, w) = p.tag()
            when {
                f == 1 && w == 2 -> name = p.string()
                f == 2 && w == 0 -> v = p.varint()
                else -> p.skip(w)
            }
        }
        // only what the call chain needs
        return if (name in CHAIN_REGS) Pair(name, v) else null
    }

    private fun dumpOf(p: Pb): Dump? {
        var reg = ""
        var begin = 0L
        var mem: ByteArray? = null
        while (p.more()) {
            val (f, w) = p.tag()
            when {
                f == 1 && w == 2 -> reg = p.string()
                f == 3 && w == 0 -> begin = p.varint()
                f == 4 && w == 2 -> mem = p.bytes().let { it.b.copyOfRange(it.i, it.end) }
                else -> p.skip(w)
            }
        }
        // the stack only: x29 and sp point into it
        val m = mem ?: return null
        return if (reg == "x29" || reg == "fp" || reg == "sp") Dump(begin, m) else null
    }

    private fun frameOf(p: Pb): Frame {
        var fn = ""
        var file = ""
        var relPc = 0L
        var pc = 0L
        while (p.more()) {
            val (f, w) = p.tag()
            when {
                f == 1 && w == 0 -> relPc = p.varint()
                f == 2 && w == 0 -> pc = p.varint()
                f == 4 && w == 2 -> fn = p.string()
                f == 6 && w == 2 -> file = p.string()
                else -> p.skip(w)
            }
        }
        return Frame(file, fn, relPc, pc)
    }

    /** The process's last log lines: kept are the Go runtime's and libc's own; returns how many there were. */
    private fun logBuffer(p: Pb, out: MutableList<String>): Int {
        var n = 0
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
                n++
                if ((tag == "Go" || tag == "GoLog" || tag == "libc") && out.size < 400) out.add(msg.trimEnd())
            } else {
                p.skip(w)
            }
        }
        return n
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
