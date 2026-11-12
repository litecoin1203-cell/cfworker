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
# a few other threads first, then the crashing one
for tid, name, frames in [
  (4321, "app.pleat.pleat", [("/apex/com.android.runtime/lib64/bionic/libc.so","__epoll_pwait")]),
  (4377, "pool-4-thread-2", [("/apex/com.android.runtime/lib64/bionic/libc.so","abort"),
                            ("/apex/com.android.runtime/lib64/bionic/libc.so","android_fdsan_close_with_tag"),
                            ("/data/app/~~x==/app.pleat.pleat-y==/lib/arm64/libhev-socks5-tunnel.so","hev_tunnel_close"),
                            ("/data/app/~~x==/app.pleat.pleat-y==/lib/arm64/libhev-socks5-tunnel.so","")]),
  (4390, "Thread-9", [("/data/app/~~x==/app.pleat.pleat-y==/lib/arm64/libgojni.so","")]),
]:
  th = t.threads[tid]
  th.id = tid; th.name = name
  for i in range(31):
    r = th.registers.add(); r.name = "x%d" % i; r.u64 = 0x7fff0000 + i
  for f, fn in frames:
    bf = th.current_backtrace.add(); bf.rel_pc = 0x1234; bf.pc = 0x7a00001234; bf.file_name = f; bf.function_name = fn; bf.function_offset = 12; bf.build_id = "abcdef"
  md = th.memory_dump.add(); md.register_name = "x0"; md.mapping_name = "[anon:stack]"; md.begin_address = 1; md.memory = bytes(range(256))
for i in range(50):
  m = t.memory_mappings.add(); m.begin_address = i*4096; m.end_address = i*4096+4096; m.read = True; m.mapping_name = "/system/lib64/libfoo%d.so" % i
lb = t.log_buffers.add(); lb.name = "main"
mode = sys.argv[1]
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
