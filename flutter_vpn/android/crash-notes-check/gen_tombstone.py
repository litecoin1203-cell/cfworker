import tombstone_pb2 as T, sys
t = T.Tombstone()
t.arch = T.ARM64
t.build_fingerprint = "Redmi/gauguininpro/gauguininpro:12/SKQ1.211006.001/V13.0.2.0:user/release-keys"
t.pid = 4321; t.tid = 4377; t.uid = 10234
t.command_line.append("app.pleat.pleat")
t.process_uptime = 812
t.signal_info.number = 6; t.signal_info.name = "SIGABRT"; t.signal_info.code = -6; t.signal_info.code_name = "SI_TKILL"
t.signal_info.has_sender = True; t.signal_info.sender_pid = 4321
t.abort_message = sys.argv[2] if len(sys.argv) > 2 else ""
mode = sys.argv[1]
GOJNI = "/data/app/~~x==/app.pleat.pleat-y==/base.apk!libgojni.so"
BASE = 0x7a00000000  # where libgojni.so's offsets start in this process
STACK = 0x7ff0001000
if mode == "gojni":
  # Go's own crash() on the main thread: frame 0 in runtime.raise, nothing unwound past it
  t.tid = 4321
  t.signal_info.sender_pid = 4321
threads = [
  (4321, "app.pleat.pleat", [("/apex/com.android.runtime/lib64/bionic/libc.so","__epoll_pwait")]),
  (4377, "pool-4-thread-2", [("/apex/com.android.runtime/lib64/bionic/libc.so","abort"),
                            ("/apex/com.android.runtime/lib64/bionic/libc.so","android_fdsan_close_with_tag"),
                            ("/data/app/~~x==/app.pleat.pleat-y==/lib/arm64/libhev-socks5-tunnel.so","hev_tunnel_close"),
                            ("/data/app/~~x==/app.pleat.pleat-y==/lib/arm64/libhev-socks5-tunnel.so","")]),
  (4390, "Thread-9", [("/data/app/~~x==/app.pleat.pleat-y==/lib/arm64/libgojni.so","")]),
]
for tid, name, frames in threads:
  th = t.threads[tid]
  th.id = tid; th.name = name
  gojni = mode == "gojni" and tid == 4321
  for i in range(29):
    r = th.registers.add(); r.name = "x%d" % i; r.u64 = 0x7fff0000 + i
  for nm, v in [("x29", STACK + 0x40 if gojni else 0x7fff0029), ("lr", BASE + 0x108c040 if gojni else 0x7fff0030), ("sp", STACK + 0x10), ("pc", BASE + 0x10b30f8)]:
    r = th.registers.add(); r.name = nm; r.u64 = v
  if gojni:
    frames = [(GOJNI, "")]
  for f, fn in frames:
    bf = th.current_backtrace.add(); bf.file_name = f; bf.function_name = fn; bf.function_offset = 12; bf.build_id = "abcdef"
    bf.rel_pc, bf.pc = (0x10b30f8, BASE + 0x10b30f8) if gojni else (0x1234, 0x7a00001234)
  md = th.memory_dump.add(); md.register_name = "x0"; md.mapping_name = "[anon:stack]"; md.begin_address = 1; md.memory = bytes(range(256))
  if gojni:
    # the stack near x29: two Go frames ([fp] = caller's fp, [fp+8] = return address), then the chain ends
    mem = bytearray(256)
    def put(addr, v):
      i = addr - STACK; mem[i:i+8] = v.to_bytes(8, "little")
    put(STACK + 0x40, STACK + 0x90); put(STACK + 0x48, BASE + 0x108bfa0)
    put(STACK + 0x90, STACK + 0xe0); put(STACK + 0x98, BASE + 0x1063a10)
    put(STACK + 0xe0, 0);            put(STACK + 0xe8, BASE + 0x1c3d000)
    md = th.memory_dump.add(); md.register_name = "x29"; md.mapping_name = "[anon:stack_and_tls]"; md.begin_address = STACK; md.memory = bytes(mem)
for i in range(50):
  m = t.memory_mappings.add(); m.begin_address = i*4096; m.end_address = i*4096+4096; m.read = True; m.mapping_name = "/system/lib64/libfoo%d.so" % i
m = t.memory_mappings.add(); m.begin_address = BASE + 0x1000000; m.end_address = BASE + 0x2000000; m.offset = 0x1000000; m.read = True; m.execute = True; m.mapping_name = GOJNI
lb = t.log_buffers.add(); lb.name = "main"
lines = []
if mode == "go":
  lines = [("Go","panic: runtime error: invalid memory address or nil pointer dereference"),
           ("Go","[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x7a1b2c3d]"),
           ("Go",""),
           ("Go","goroutine 812 [running]:"),
           ("Go","github.com/xtls/xray-core/proxy/vless/outbound.(*Handler).Process.func3()"),
           ("Go","\t/home/runner/go/pkg/mod/github.com/xtls/xray-core@v1.260327.1/proxy/vless/outbound/outbound.go:300 +0x1c"),
           ("Go","github.com/xtls/xray-core/common/task.Run.func1()")]
lines = [("pleat","connected to 1.2.3.4:443 via example.com")] + lines
for tag, msg in lines:
  lm = lb.logs.add(); lm.tag = tag; lm.message = msg; lm.pid = 4321; lm.tid = 4377; lm.priority = 6; lm.timestamp = "11-12 00:26:01.123"
fd = t.open_fds.add(); fd.fd = 87; fd.path = "/dev/tun"; fd.owner = "ParcelFileDescriptor"; fd.tag = 0x7a
c = t.causes.add(); c.human_readable = sys.argv[3] if len(sys.argv) > 3 else ""
sys.stdout.buffer.write(t.SerializeToString())
