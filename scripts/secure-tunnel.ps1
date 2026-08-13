[CmdletBinding()]
param(
  [ValidateSet("init", "doctor", "run")]
  [string]$TunnelAction = "run",

  [string]$TunnelProfile = "research-bridge"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverEntry = Join-Path $projectRoot "dist\index.js"
$envFile = Join-Path $projectRoot ".env"
$localTunnelClient = Join-Path $projectRoot "tools\tunnel-client.exe"

if (Test-Path -LiteralPath $envFile -PathType Leaf) {
  Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $name = $Matches[1]
      $value = $Matches[2].Trim()
      if (
        $value.Length -ge 2 -and
        (($value.StartsWith('"') -and $value.EndsWith('"')) -or
          ($value.StartsWith("'") -and $value.EndsWith("'")))
      ) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
      }
    }
  }
}

if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) {
  throw "dist/index.js does not exist. Run 'pnpm run build' first."
}

if ($env:npm_node_execpath -and (Test-Path -LiteralPath $env:npm_node_execpath -PathType Leaf)) {
  $nodeExecutable = $env:npm_node_execpath
} else {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $codexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if ($nodeCommand) {
    $nodeExecutable = $nodeCommand.Source
  } elseif (Test-Path -LiteralPath $codexNode -PathType Leaf) {
    $nodeExecutable = $codexNode
  } else {
    throw "Node.js was not found. Install Node.js 18+ or run this project from Codex."
  }
}
if (Test-Path -LiteralPath $localTunnelClient -PathType Leaf) {
  $tunnelExecutable = $localTunnelClient
} else {
  $tunnelExecutable = (Get-Command tunnel-client -ErrorAction Stop).Source
}

if (-not $env:CONTROL_PLANE_API_KEY) {
  throw "CONTROL_PLANE_API_KEY is required. Set it only in the current shell or a secret manager."
}

if (-not $env:RESEARCH_BRIDGE_REPO_ROOT) {
  $env:RESEARCH_BRIDGE_REPO_ROOT = $projectRoot
}

if (-not $env:RESEARCH_BRIDGE_DATA_DIR) {
  $env:RESEARCH_BRIDGE_DATA_DIR = Join-Path $projectRoot ".research-bridge"
}

$mcpCommand = '"{0}" "{1}"' -f $nodeExecutable.Replace('\', '/'), $serverEntry.Replace('\', '/')

switch ($TunnelAction) {
  "init" {
    if (-not $env:RESEARCH_BRIDGE_TUNNEL_ID) {
      throw "RESEARCH_BRIDGE_TUNNEL_ID is required for init."
    }

    & $tunnelExecutable init `
      --sample sample_mcp_stdio_local `
      --profile $TunnelProfile `
      --tunnel-id $env:RESEARCH_BRIDGE_TUNNEL_ID `
      --mcp-command $mcpCommand
    break
  }
  "doctor" {
    & $tunnelExecutable doctor --profile $TunnelProfile --explain
    break
  }
  "run" {
    & $tunnelExecutable run --profile $TunnelProfile
    break
  }
}

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
