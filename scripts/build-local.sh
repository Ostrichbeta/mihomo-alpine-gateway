#!/bin/sh
set -eu

# Build mihomo-gateway images.
#
# BUILD_MODE=local   Build/load the current host platform (default).
# BUILD_MODE=single  Build/load one PLATFORM/VARIANT combination.
# BUILD_MODE=release Build the full multi-arch matrix without --load.
#
# PLATFORM overrides host detection, for example linux/arm64 or linux/amd64.
# VARIANT is used only for linux/amd64 and defaults to v3.

IMAGE_NAME="${IMAGE_NAME:-mihomo-gateway}"
BUILD_MODE="${BUILD_MODE:-local}"
VARIANT="${VARIANT:-v3}"

detect_platform() {
    case "$(uname -m)" in
        arm64|aarch64) echo "linux/arm64" ;;
        x86_64|amd64) echo "linux/amd64" ;;
        *) echo "Unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
    esac
}

tag_for() {
    platform="$1"
    variant="$2"

    if [ "$platform" = "linux/arm64" ]; then
        echo "arm64"
    else
        echo "amd64-${variant}"
    fi
}

variant_arg_for() {
    platform="$1"
    variant="$2"

    if [ "$platform" = "linux/amd64" ]; then
        echo "$variant"
    else
        echo ""
    fi
}

build_one() {
    platform="$1"
    variant="$2"
    load_arg="$3"
    tag="$(tag_for "$platform" "$variant")"
    build_variant="$(variant_arg_for "$platform" "$variant")"

    echo "=== Building $IMAGE_NAME:$tag ($platform) ==="

    docker buildx build \
        $load_arg \
        --platform "$platform" \
        --build-arg "MIHOMO_VARIANT=$build_variant" \
        --tag "${IMAGE_NAME}:${tag}" \
        .

    echo "=== Done: $IMAGE_NAME:$tag ==="
}

case "$BUILD_MODE" in
    local)
        PLATFORM="${PLATFORM:-$(detect_platform)}"
        build_one "$PLATFORM" "$VARIANT" "--load"
        ;;
    single)
        PLATFORM="${PLATFORM:-$(detect_platform)}"
        build_one "$PLATFORM" "$VARIANT" "--load"
        ;;
    release)
        build_one "linux/amd64" "v1" ""
        build_one "linux/amd64" "v2" ""
        build_one "linux/amd64" "v3" ""
        build_one "linux/arm64" "" ""
        ;;
    *)
        echo "Unsupported BUILD_MODE: $BUILD_MODE" >&2
        echo "Use local, single, or release." >&2
        exit 1
        ;;
esac

echo ""
echo "Build mode complete: $BUILD_MODE"
