$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "config")) {
  New-Item -ItemType Directory -Path "config" | Out-Null
}
if (-not (Test-Path "config/ai-models.env")) {
  Copy-Item "config/ai-models.env.example" "config/ai-models.env"
  Write-Host "已创建 config/ai-models.env，请在其中填写模型配置。"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "未检测到 Docker，请先安装并启动 Docker Desktop。"
}

docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "未检测到 docker compose。"
}

if (-not (Test-Path ".env")) {
  $password = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N").Substring(0, 16)
  $adminToken = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N").Substring(0, 16)
  @"
PORT=3000
POSTGRES_DB=football_arena
POSTGRES_USER=arena
POSTGRES_PASSWORD=$password
SPORTTERY_CACHE_TTL_MS=60000
ADMIN_TOKEN=$adminToken
"@ | Set-Content -Path ".env" -Encoding utf8
  Write-Host "已创建 .env，并生成数据库密码与结算令牌。"
}

docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
  throw "Docker Compose 启动失败。"
}

Write-Host "部署完成：http://localhost:3000"
Write-Host "查看状态：docker compose ps"
