<#
.SYNOPSIS
    读取微联叮 (vlinkto) 客户端当前使用的 access-token。

.DESCRIPTION
    依次从以下位置读取最新的 JWT：
      1. %APPDATA%\vlinkto\config.json 的 mdltoken 字段（应用主配置，最可靠）
      2. %APPDATA%\vlinkto\Partitions\electron\Local Storage\leveldb\*.ldb / *.log
         （内嵌页面 work.hanweb.com 的 access_token）
    两个来源都会解析 iat/exp，只输出仍在有效期内的那一个；没有有效的则退出码 1。

.PARAMETER Raw
    只输出 token 字符串（便于管道/脚本使用）。

.PARAMETER IncludeExpired
    附带输出已过期的 token（调试用）。

.EXAMPLE
    .\get-vlinkto-token.ps1
    .\get-vlinkto-token.ps1 -Raw | clip
#>
[CmdletBinding()]
param(
    [switch]$Raw,
    [switch]$IncludeExpired
)

$ErrorActionPreference = 'Stop'

# ---------- JWT 解析 ----------
function ConvertFrom-Base64Url {
    param([string]$Value)
    $s = $Value.Replace('-', '+').Replace('_', '/')
    switch ($s.Length % 4) {
        2 { $s += '==' }
        3 { $s += '=' }
    }
    [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
}

function Get-JwtInfo {
    param([string]$Token)
    $parts = $Token.Split('.')
    if ($parts.Count -ne 3) { return $null }
    try {
        $payload = ConvertFrom-Base64Url $parts[1] | ConvertFrom-Json
    } catch {
        return $null
    }
    if (-not $payload.exp) { return $null }
    [pscustomobject]@{
        Token     = $Token
        Username  = $payload.username
        IssuedAt  = [DateTimeOffset]::FromUnixTimeSeconds([int64]$payload.iat).ToLocalTime()
        ExpiresAt = [DateTimeOffset]::FromUnixTimeSeconds([int64]$payload.exp).ToLocalTime()
    }
}

# ---------- 来源 1：config.json ----------
function Get-TokenFromConfig {
    param([string]$ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return }
    $json = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in 'mdltoken', 'token', 'accessToken', 'access_token') {
        $value = $json.$name
        if ($value -is [string] -and $value -match '^eyJ[\w\-]+\.[\w\-]+\.[\w\-]+$') {
            [pscustomobject]@{ Source = "config.json:$name"; Info = (Get-JwtInfo $value) }
            return
        }
    }
}

# ---------- 来源 2：Local Storage leveldb ----------
function Get-TokensFromLocalStorage {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $pattern = 'eyJ[\w\-]+\.[\w\-]+\.[\w\-]+'
    $files = Get-ChildItem -LiteralPath $Root -Recurse -File -Include '*.ldb', '*.log' -ErrorAction SilentlyContinue
    foreach ($file in $files) {
        try {
            $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($file.FullName))
        } catch {
            continue
        }
        foreach ($match in [regex]::Matches($text, $pattern)) {
            $info = Get-JwtInfo $match.Value
            if ($info) {
                [pscustomobject]@{
                    Source = "localstorage:" + $file.Directory.Parent.Name + "/" + $file.Name
                    Info   = $info
                }
            }
        }
    }
}

# ---------- 汇总 ----------
$appData   = Join-Path $env:APPDATA 'vlinkto'
$candidates = @()
$candidates += Get-TokenFromConfig -ConfigPath (Join-Path $appData 'config.json')
$candidates += Get-TokensFromLocalStorage -Root $appData

$now     = [DateTimeOffset]::Now
$valid   = @($candidates | Where-Object { $_.Info -and $_.Info.ExpiresAt -gt $now } |
             Sort-Object { $_.Info.ExpiresAt } -Descending)
$expired = @($candidates | Where-Object { $_.Info -and $_.Info.ExpiresAt -le $now } |
             Sort-Object { $_.Info.ExpiresAt } -Descending)

$current = $valid | Select-Object -First 1
if (-not $current) {
    Write-Host '未找到有效的 access-token，请在微联叮客户端重新登录。' -ForegroundColor Yellow
    if ($IncludeExpired -and $expired.Count -gt 0) {
        Write-Host '历史（已过期）token：'
        $expired | Select-Object -First 5 | ForEach-Object {
            Write-Host ("  exp={0}  {1}" -f $_.Info.ExpiresAt.ToString('yyyy-MM-dd HH:mm:ss'), $_.Info.Token)
        }
    }
    exit 1
}

if ($Raw) {
    Write-Output $current.Info.Token
    exit 0
}

Write-Host '当前有效 access-token：' -ForegroundColor Green
Write-Host $current.Info.Token
Write-Host ''
Write-Host ("  来源     : {0}" -f $current.Source)
Write-Host ("  用户名   : {0}" -f $current.Info.Username)
Write-Host ("  签发时间 : {0:yyyy-MM-dd HH:mm:ss}" -f $current.Info.IssuedAt)
Write-Host ("  过期时间 : {0:yyyy-MM-dd HH:mm:ss}（剩余 {1:0.0} 小时）" -f `
    $current.Info.ExpiresAt, [Math]::Round(($current.Info.ExpiresAt - $now).TotalHours, 1))
Write-Host ("  其他有效副本: {0} 个" -f ([Math]::Max(0, $valid.Count - 1)))

if ($IncludeExpired -and $expired.Count -gt 0) {
    Write-Host ''
    Write-Host '历史（已过期）token：' -ForegroundColor DarkGray
    $expired | Select-Object -First 5 | ForEach-Object {
        Write-Host ("  exp={0}  {1}" -f $_.Info.ExpiresAt.ToString('yyyy-MM-dd HH:mm:ss'), $_.Info.Token) -ForegroundColor DarkGray
    }
}
