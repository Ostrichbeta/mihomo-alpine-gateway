#!/bin/sh
set -eu

# Build all 4 mihomo variants locally for testing.
# Requires Docker buildx and QEMU (for arm64 on amd64 hosts).

IMAGE_NAME="${IMAGE_NAME:-mihomo-gateway}"

VARIANTS="amd64-v1 amd64-v2 amd64-v3 arm64"

for VARIANT in $VARIANTS; do
    echo "=== Building $VARIANT ==="

    if [ "$VARIANT" = "arm64" ]; then
        PLATFORM="linux/arm64"
        BUILD_VARIANT=""
    else
        PLATFORM="linux/amd64"
        BUILD_VARIANT=$(echo "$VARIANT" | cut -d- -f2)
    fi

    docker buildx build \
        --load \
        --platform "$PLATFORM" \
        --build-arg "MIHOMO_VARIANT=$BUILD_VARIANT" \
        --tag "${IMAGE_NAME}:${VARIANT}" \
        .

    echo "=== Done: $IMAGE_NAME:$VARIANT ==="
done

echo ""
echo "All variants built:"
echo "  ${IMAGE_NAME}:amd64-v1"
echo "  ${IMAGE_NAME}:amd64-v2"
echo "  ${IMAGE_NAME}:amd64-v3"
echo "  ${IMAGE_NAME}:arm64"
