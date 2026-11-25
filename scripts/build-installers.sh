#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
target=${1:-all}
case "$target" in macos|windows|all) ;; *) echo 'Usage: scripts/build-installers.sh [macos|windows|all]' >&2; exit 2 ;; esac
version=$(node -p 'require("./package.json").version')
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Set a numeric release version in package.json.' >&2; exit 1; }
npm run build
out="$PWD/dist/installers"
mkdir -p "$out"
work=$(mktemp -d "${TMPDIR:-/tmp}/dama-packaging.XXXXXX")
work=$(cd "$work" && pwd -P)
trap 'rm -rf "$work"' EXIT

copy_build() {
    mkdir -p "$1"
    cp -R dist/src dist/public "$1/"
    find "$1" -type f -name '*.map' -delete
}

hash_file() {
    (cd "$out" && shasum -a 256 "$1" > "$1.sha256")
}

if [[ "$target" == macos || "$target" == all ]]; then
    [[ $(uname -s) == Darwin ]] || { echo 'Build the macOS package on macOS.' >&2; exit 1; }
    node_binary=${MAC_NODE_BINARY:-$(node -p 'process.execPath')}
    node_license=${MAC_NODE_LICENSE:-$(dirname "$(dirname "$node_binary")")/LICENSE}
    [[ -f "$node_license" ]] || { echo 'Set MAC_NODE_LICENSE to the bundled Node.js license file.' >&2; exit 1; }
    arch=$("$node_binary" -p 'process.arch')
    "$node_binary" --experimental-sqlite -e 'new (require("node:sqlite").DatabaseSync)(":memory:").close()'
    root="$work/macos"
    app="$root/Applications/Dama.app"
    resources="$app/Contents/Resources"
    mkdir -p "$app/Contents/MacOS" "$resources/bin" "$work/pkg-scripts"
    install -m 0755 deploy/installer/macos/Dama "$app/Contents/MacOS/Dama"
    install -m 0755 deploy/installer/macos/server deploy/installer/macos/manage-service "$resources/"
    install -m 0755 deploy/installer/macos/postinstall "$work/pkg-scripts/"
    cp deploy/installer/macos/Info.plist "$app/Contents/"
    cp deploy/installer/macos/Dama.icns "$resources/"
    plutil -replace CFBundleShortVersionString -string "$version" "$app/Contents/Info.plist"
    plutil -replace CFBundleVersion -string "$version" "$app/Contents/Info.plist"
    install -m 0755 "$node_binary" "$resources/bin/node"
    install -m 0644 "$node_license" "$resources/Node-LICENSE"
    cp package.json LICENSE "$resources/"
    mkdir -p "$resources/deploy"
    cp -R deploy/database deploy/forgejo deploy/nginx "$resources/deploy/"
    copy_build "$resources/dist"
    artifact="Dama-$version-mac-$arch.pkg"
    package="$work/$artifact"
    if [[ -n "${MAC_NOTARY_PROFILE:-}" && ( -z "${MAC_APP_SIGN_IDENTITY:-}" || -z "${MAC_INSTALLER_SIGN_IDENTITY:-}" ) ]]; then
        echo 'Notarizing a macOS package requires both Developer ID signing identities.' >&2
        exit 1
    fi
    if [[ -n "${MAC_APP_SIGN_IDENTITY:-}" ]]; then
        codesign --force --timestamp --options runtime --entitlements deploy/installer/macos/node.entitlements --sign "$MAC_APP_SIGN_IDENTITY" "$resources/bin/node"
        codesign --force --timestamp --options runtime --sign "$MAC_APP_SIGN_IDENTITY" "$app"
        codesign --verify --deep --strict "$app"
    fi
    components="$work/components.plist"
    pkgbuild --analyze --root "$root" "$components"
    if /usr/libexec/PlistBuddy -c 'Print :0:BundleIsRelocatable' "$components" >/dev/null 2>&1; then
        /usr/libexec/PlistBuddy -c 'Set :0:BundleIsRelocatable false' "$components"
    else
        /usr/libexec/PlistBuddy -c 'Add :0:BundleIsRelocatable bool false' "$components"
    fi
    if [[ -n "${MAC_INSTALLER_SIGN_IDENTITY:-}" ]]; then
        pkgbuild --root "$root" --component-plist "$components" --install-location / --scripts "$work/pkg-scripts" \
            --identifier com.objlabs.dama --version "$version" --ownership recommended \
            --sign "$MAC_INSTALLER_SIGN_IDENTITY" "$package"
        pkgutil --check-signature "$package"
    else
        pkgbuild --root "$root" --component-plist "$components" --install-location / --scripts "$work/pkg-scripts" \
            --identifier com.objlabs.dama --version "$version" --ownership recommended "$package"
    fi
    if [[ -n "${MAC_NOTARY_PROFILE:-}" ]]; then
        result="$work/notary-result.json"
        xcrun notarytool submit "$package" --keychain-profile "$MAC_NOTARY_PROFILE" --wait --output-format json > "$result"
        status=$(node -p 'require(process.argv[1]).status' "$result")
        printf 'Apple notarization: %s\n' "$status"
        if [[ "$status" != Accepted ]]; then
            id=$(node -p 'require(process.argv[1]).id' "$result")
            xcrun notarytool log "$id" --keychain-profile "$MAC_NOTARY_PROFILE" >&2
            exit 1
        fi
        xcrun stapler staple "$package"
        xcrun stapler validate "$package"
    fi
    mv -f "$package" "$out/$artifact"
    hash_file "$artifact"
fi

if [[ "$target" == windows || "$target" == all ]]; then
    stage="$work/windows"
    mkdir -p "$stage/payload/deploy"
    cp deploy/installer/windows/{setup.nsi,manage.ps1,manage.cmd,Dama.ico} "$stage/"
    cp -R src public scripts test package.json package-lock.json tsconfig*.json LICENSE "$stage/payload/"
    cp -R deploy/database deploy/forgejo deploy/nginx deploy/systemd deploy/routes.example.json "$stage/payload/deploy/"
    copy_build "$stage/payload/prebuilt"
    if command -v makensis >/dev/null 2>&1; then
        (cd "$stage" && makensis setup.nsi)
    else
        docker run --rm --mount "type=bind,source=$stage,target=/build" -w /build debian:bookworm-slim \
            sh -ec 'apt-get update -qq && apt-get install -y -qq --no-install-recommends nsis >/dev/null && makensis setup.nsi'
    fi
    artifact="Dama-$version-Windows-Setup.exe"
    cp "$stage/Dama-Setup.exe" "$out/$artifact"
    hash_file "$artifact"
fi
printf 'Installers: %s\n' "$out"
