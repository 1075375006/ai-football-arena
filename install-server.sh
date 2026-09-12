#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

mkdir -p config
if [ ! -f config/ai-models.env ]; then
  umask 077
  cp config/ai-models.env.example config/ai-models.env
  echo "已创建 config/ai-models.env，请在其中填写模型配置。"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "未检测到 Docker，请先安装 Docker Desktop（macOS/Windows）或 Docker Engine（Linux）。"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "未检测到 docker compose，请先安装 Compose 插件。"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/Docker.app" ]; then
    echo "正在启动 Docker Desktop..."
    open -a Docker
    ready=0
    i=0
    while [ "$i" -lt 60 ]; do
      if docker info >/dev/null 2>&1; then ready=1; break; fi
      i=$((i + 1))
      sleep 2
    done
    if [ "$ready" -ne 1 ]; then
      echo "Docker Desktop 启动超时，请先手动打开 Docker Desktop 后重试。"
      exit 1
    fi
  else
    echo "Docker 服务未运行，请先启动 Docker Desktop 或 Docker Engine。"
    exit 1
  fi
fi

if [ ! -f .env ]; then
  umask 077
  PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  ADMIN=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  {
    echo "PORT=3000"
    echo "POSTGRES_DB=football_arena"
    echo "POSTGRES_USER=arena"
    echo "POSTGRES_PASSWORD=$PASSWORD"
    echo "SPORTTERY_CACHE_TTL_MS=60000"
    echo "ADMIN_TOKEN=$ADMIN"
  } > .env
  echo "已创建 .env，并生成数据库密码与结算令牌。"
fi

docker compose up -d --build
echo "部署完成：http://localhost:${PORT:-3000}"
echo "查看状态：docker compose ps"
