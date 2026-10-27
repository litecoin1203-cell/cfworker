#!/bin/bash
# Copy the Cloud Gold UI (../app-web) into the APK assets. The GitHub workflow does this automatically.
set -e; cd "$(dirname "$0")"
rm -rf V2rayNG/app/src/main/assets/cloudgold
mkdir -p V2rayNG/app/src/main/assets/cloudgold
cp -r ../app-web/. V2rayNG/app/src/main/assets/cloudgold/
rm -f V2rayNG/app/src/main/assets/cloudgold/mock.js
echo "UI copied into the app."
