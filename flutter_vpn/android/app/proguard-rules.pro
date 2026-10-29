# Flutter release builds run R8. The tunnel engine is reached by name from
# native code, so none of it may be renamed or dropped:
#  - libv2ray (gomobile): Go calls back into these classes and interfaces
#    over JNI by their Java names (CoreCallbackHandler and its methods).
#  - go.Seq: gomobile's bridge, looked up by name from Go.
#  - TProxyService: hev-socks5-tunnel's JNI_OnLoad finds it by name.
# The Cloud Gold app (v2rayNG 2.2.6) ships without R8, which has the same
# effect.
-keep class libv2ray.** { *; }
-keep interface libv2ray.** { *; }
-keep class go.** { *; }
-keep interface go.** { *; }
-keep class app.pleat.pleat.** { *; }
-dontwarn libv2ray.**
-dontwarn go.**
