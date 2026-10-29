#!/bin/bash
# Builds hev-socks5-tunnel's JNI library for Pleat. Same source and commit as
# the Cloud Gold app (android/compile-hevtun.sh); only PKGNAME differs, so
# the natives bind to app.pleat.pleat.TProxyService.
#   NDK_HOME=... bash compile-hevtun.sh   (expects ./hev-socks5-tunnel)
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -d ${NDK_HOME:-} ]] || { echo "set NDK_HOME"; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/jni"
ln -s "$dir/hev-socks5-tunnel" "$tmp/jni/hev-socks5-tunnel"
echo 'include $(call all-subdir-makefiles)' > "$tmp/jni/Android.mk"
cd "$tmp"
"$NDK_HOME/ndk-build" \
  NDK_PROJECT_PATH=. \
  APP_BUILD_SCRIPT=jni/Android.mk \
  "APP_ABI=armeabi-v7a arm64-v8a x86_64" \
  APP_PLATFORM=android-24 \
  NDK_LIBS_OUT="$tmp/libs" \
  NDK_OUT="$tmp/obj" \
  "APP_CFLAGS=-O3 -DPKGNAME=app/pleat/pleat" \
  "APP_LDFLAGS=-Wl,--build-id=none -Wl,--hash-style=gnu -Wl,-z,max-page-size=16384"
mkdir -p "$dir/app/libs"
cp -r "$tmp/libs/"* "$dir/app/libs/"
