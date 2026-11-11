# 发布前硬闸：当前完整仓库若不适合直接公开，必须明确 BLOCKED。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\check-public-release.ps1
param([string]$Repo = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$issues = @()

$memberFiles = @(
  'src\planner.js','src\scheduler.js','src\summarizer.js','src\prodder.js','src\supervisor.js',
  'test\planner.test.js','test\scheduler.test.js','test\summarizer.test.js','test\prodder.test.js','test\supervisor.test.js'
)
$presentMemberFiles = @($memberFiles | Where-Object { Test-Path -LiteralPath (Join-Path $Repo $_) })
if ($presentMemberFiles.Count -gt 0) {
  $issues += 'paid_modules_in_public_tree'
}

$licensePath = Join-Path $Repo 'LICENSE'
$license = if (Test-Path -LiteralPath $licensePath) { Get-Content -LiteralPath $licensePath -Raw } else { '' }
if ($presentMemberFiles.Count -gt 0 -and $license -match 'MIT License') {
  $issues += 'license_mismatch'
}

$placeholderDocs = @('ABOUT-联系.md','TERMS-用户协议.md','PRIVACY-隐私政策.md','DISCLAIMER-免责声明.md','UPDATE-更新政策.md')
$requiredDocs = @('LICENSE') + $placeholderDocs
$missingDocs = @($requiredDocs | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Repo $_)) })
if ($missingDocs.Count -gt 0) {
  $issues += 'missing_legal_docs'
}
$placeholderHits = @($placeholderDocs | Where-Object {
  $file = Join-Path $Repo $_
  (Test-Path -LiteralPath $file) -and ((Get-Content -LiteralPath $file -Raw -Encoding UTF8) -match '<待填')
})
if ($placeholderHits.Count -gt 0) {
  $issues += 'placeholder_contact'
}

$result = [ordered]@{
  ok = ($issues.Count -eq 0)
  verdict = if ($issues.Count -eq 0) { 'PASS' } else { 'BLOCKED' }
  issues = $issues
  member_files_present = $presentMemberFiles
  missing_docs = $missingDocs
  placeholder_docs = $placeholderHits
}
$json = $result | ConvertTo-Json -Compress
Write-Output $json
if ($issues.Count -gt 0) { exit 2 }
