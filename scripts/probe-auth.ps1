# Probes the /api/chat auth gate in each configuration state.
# Usage: pwsh scripts/probe-auth.ps1
param([int]$Port = 3130)

function Probe($Label, $EnvVars, $AuthHeader) {
  $job = Start-Job -ScriptBlock {
    param($dir, $port, $vars)
    Set-Location $dir
    foreach ($k in $vars.Keys) { Set-Item -Path "env:$k" -Value $vars[$k] }
    npx next start -p $port
  } -ArgumentList (Get-Location).Path, $Port, $EnvVars

  Start-Sleep -Seconds 11
  $headers = @{ "Content-Type" = "application/json" }
  if ($AuthHeader) { $headers["Authorization"] = $AuthHeader }

  Write-Host "--- $Label ---"
  try {
    $r = Invoke-WebRequest "http://localhost:$Port/api/chat" -Method POST -Headers $headers `
      -Body '{"messages":[{"role":"user","content":"hi"}]}' -UseBasicParsing
    Write-Host "status: $($r.StatusCode)"
  } catch {
    $resp = $_.Exception.Response
    Write-Host "status: $([int]$resp.StatusCode)"
    $challenge = $resp.Headers["WWW-Authenticate"]
    if ($challenge) { Write-Host "WWW-Authenticate: $challenge" }
    Write-Host "body: $((New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd())"
  }

  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}

# A syntactically valid JWT signed by a key the issuer never published.
$fake = "eyJhbGciOiJSUzI1NiIsImtpZCI6Im5vcGUifQ.eyJpc3MiOiJodHRwczovL2lzc3Vlci5leGFtcGxlLmNvbSJ9.AAAA"

Probe "production, no config (fails closed)" @{ NODE_ENV = "production" } $null
Probe "production, explicit opt-out" @{ NODE_ENV = "production"; AUTH_OPTIONAL = "true"; ANTHROPIC_API_KEY = "sk-ant-dummy" } $null
Probe "enforced, no token" @{ NODE_ENV = "production"; OIDC_ISSUER = "https://issuer.example.com"; OIDC_AUDIENCE = "https://api.mini.example"; ANTHROPIC_API_KEY = "sk-ant-dummy" } $null
Probe "enforced, unverifiable token" @{ NODE_ENV = "production"; OIDC_ISSUER = "https://issuer.example.com"; OIDC_AUDIENCE = "https://api.mini.example"; ANTHROPIC_API_KEY = "sk-ant-dummy" } "Bearer $fake"
Probe "enforced, half-configured" @{ NODE_ENV = "production"; OIDC_ISSUER = "https://issuer.example.com"; ANTHROPIC_API_KEY = "sk-ant-dummy" } $null
