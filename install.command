#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
"$SCRIPT_DIR/install.sh"

echo
echo "部署完成。浏览器地址：http://localhost:${PORT:-3000}"
read -r -p "按回车关闭此窗口..." _
