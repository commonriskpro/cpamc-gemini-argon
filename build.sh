#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

native_goos=$(unset GOOS GOARCH; go env GOOS)
native_goarch=$(unset GOOS GOARCH; go env GOARCH)
target_goos=${GOOS:-$native_goos}
target_goarch=${GOARCH:-$native_goarch}

case "$target_goos/$target_goarch" in
  darwin/arm64) extension=dylib ;;
  linux/amd64|linux/arm64) extension=so ;;
  windows/amd64) extension=dll ;;
  *)
    echo "unsupported target: $target_goos/$target_goarch (supported: darwin/arm64, linux/amd64, linux/arm64, windows/amd64)" >&2
    exit 2
    ;;
esac

export CGO_ENABLED=${CGO_ENABLED:-1}
export GOOS="$target_goos"
export GOARCH="$target_goarch"

# Cross-compilation toolchain setup.
# LIBC can be set to 'glibc' (default) or 'musl' when targeting Linux with zig.
libc_target=${LIBC:-glibc}
if [[ "$libc_target" != "glibc" && "$libc_target" != "musl" ]]; then
  echo "unsupported LIBC: $libc_target (supported: glibc, musl)" >&2
  exit 2
fi

is_cross=0
if [[ "$target_goos" != "$native_goos" || "$target_goarch" != "$native_goarch" ]]; then
  is_cross=1
fi

if [[ $is_cross -eq 1 ]]; then
  if [[ -n "${CC:-}" ]]; then
    export CC
  elif command -v zig >/dev/null 2>&1; then
    case "$target_goos/$target_goarch" in
      windows/amd64)
        export CC="zig cc -target x86_64-windows-gnu"
        ;;
      linux/amd64)
        if [[ "$libc_target" == "musl" ]]; then
          export CC="zig cc -target x86_64-linux-musl"
        else
          export CC="zig cc -target x86_64-linux-gnu.2.31"
        fi
        ;;
      linux/arm64)
        if [[ "$libc_target" == "musl" ]]; then
          export CC="zig cc -target aarch64-linux-musl"
        else
          export CC="zig cc -target aarch64-linux-gnu.2.31"
        fi
        ;;
      *)
        echo "no automated zig cc target configured for $target_goos/$target_goarch; set CC explicitly" >&2
        exit 1
        ;;
    esac
  else
    echo "cross-compilation for $target_goos/$target_goarch requires a C cross-compiler; set CC or install zig" >&2
    exit 1
  fi
fi

if [[ $is_cross -eq 0 ]]; then
  go test ./...
  go vet ./...
fi

if [[ -n "${OUTPUT:-}" ]]; then
  artifact=$OUTPUT
elif [[ $is_cross -eq 0 ]]; then
  artifact="cpamc-gemini-argon.$extension"
else
  # Cross-builds never replace a binary for another platform/architecture.
  artifact="dist/$target_goos/$target_goarch/cpamc-gemini-argon.$extension"
fi

mkdir -p "$(dirname "$artifact")"
go build -trimpath -buildmode=c-shared -o "$artifact" .
printf 'built %s/%s -> %s\n' "$target_goos" "$target_goarch" "$artifact"
