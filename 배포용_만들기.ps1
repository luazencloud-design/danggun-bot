# 배포용 ZIP 빌더 (PowerShell 버전)
# 원인: Windows 11에서 WMIC가 제거되고, bat 파일에서 Korean 파일명 + for /f 조합이 파싱 오류를 일으킴.
# PowerShell로 작성하면 둘 다 해결됨.

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$date = Get-Date -Format 'yyyyMMdd'
$outZip = Join-Path $here "danggeun-autobot-dist-$date.zip"

Write-Host ""
Write-Host "=================================================="
Write-Host "  배포용 ZIP 생성"
Write-Host "  파일: danggeun-autobot-dist-$date.zip"
Write-Host "=================================================="
Write-Host ""

# 임시 폴더
$tmpDir = Join-Path $env:TEMP "danggeun-dist-$(Get-Random)"
if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

# 복사할 항목
$copyItems = @(
  'src', 'extension', 'index.html', 'package.json', 'package-lock.json',
  'vite.config.js', 'tailwind.config.js', 'postcss.config.js', '.gitignore',
  '실행.bat', '크롬확장_설치.bat', '설명서.md', 'README.md'
)

Write-Host "파일 복사 중..."
$copied = 0
foreach ($item in $copyItems) {
  $src = Join-Path $here $item
  if (Test-Path $src) {
    $dst = Join-Path $tmpDir $item
    Copy-Item -Path $src -Destination $dst -Recurse -Force
    $copied++
  } else {
    Write-Host "  [skip] $item (없음)" -ForegroundColor Yellow
  }
}
Write-Host "  $copied / $($copyItems.Count) 복사 완료"

# ZIP 압축
Write-Host "ZIP 압축 중..."
if (Test-Path $outZip) { Remove-Item $outZip -Force }
Compress-Archive -Path "$tmpDir\*" -DestinationPath $outZip -Force

# 정리
Remove-Item $tmpDir -Recurse -Force

$sizeKB = [math]::Round((Get-Item $outZip).Length / 1KB, 1)

Write-Host ""
Write-Host "=================================================="
Write-Host "  [OK] 배포 패키지 생성 완료!" -ForegroundColor Green
Write-Host ""
Write-Host "  파일: $outZip"
Write-Host "  크기: $sizeKB KB"
Write-Host ""
Write-Host "  공유 방법:"
Write-Host "  1. 이 ZIP을 다른 PC로 보내세요"
Write-Host "  2. 원하는 폴더에 압축 풀기"
Write-Host "  3. '실행.bat' 더블클릭"
Write-Host "  4. 자세한 설치는 '설명서.md' 참고"
Write-Host "=================================================="
Write-Host ""
