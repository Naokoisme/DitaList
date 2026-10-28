[CmdletBinding()]
param([switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolRoot = Join-Path $projectRoot 'tools\android'
$jdkDirectory = Join-Path $toolRoot 'jdk\jdk-21.0.2'
$buildTools = Join-Path $toolRoot 'build-tools\android-15'
$platform = Join-Path $toolRoot 'platform\android-35'

function Invoke-Checked {
  param([string]$Executable, [string[]]$ToolArguments)
  & $Executable @ToolArguments
  if ($LASTEXITCODE -ne 0) { throw "工具失败（退出码 $LASTEXITCODE）：$([IO.Path]::GetFileName($Executable))" }
}

function Ensure-Archive {
  param([string]$Name, [string]$Url, [long]$Size, [string]$Algorithm, [string]$Checksum)
  $archive = Join-Path $toolRoot $Name
  if (!(Test-Path -LiteralPath $archive) -or (Get-Item -LiteralPath $archive).Length -lt $Size) {
    Invoke-Checked 'curl.exe' @('--silent', '--show-error', '--location', '--fail', '--continue-at', '-', '--connect-timeout', '20', '--max-time', '600', '--output', $archive, $Url)
  }
  $file = Get-Item -LiteralPath $archive
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm $Algorithm).Hash
  if ($file.Length -ne $Size -or $actual -ne $Checksum) { throw "官方工具校验失败：$Name。文件已保留供检查，不会执行。" }
  return $archive
}

if (!(Test-Path -LiteralPath $toolRoot)) { New-Item -ItemType Directory -Path $toolRoot | Out-Null }
$origins = @(
  [pscustomobject]@{ name='OpenJDK 21.0.2'; archive='openjdk-21.0.2_windows-x64_bin.zip'; url='https://download.java.net/java/GA/jdk21.0.2/f2283984656d49d69e91c558476027ac/13/GPL/openjdk-21.0.2_windows-x64_bin.zip'; size=201328186; algorithm='SHA256'; checksum='b6c17e747ae78cdd6de4d7532b3164b277daee97c007d3eaa2b39cca99882664'; destination=(Join-Path $toolRoot 'jdk'); check=(Join-Path $jdkDirectory 'bin\javac.exe') },
  [pscustomobject]@{ name='Android Build Tools 35.0.0'; archive='build-tools_r35_windows.zip'; url='https://dl.google.com/android/repository/build-tools_r35_windows.zip'; size=59878107; algorithm='SHA1'; checksum='af059bb67cf7786f45ee0db85e2d24985df1b4b6'; destination=(Join-Path $toolRoot 'build-tools'); check=(Join-Path $buildTools 'aapt2.exe') },
  [pscustomobject]@{ name='Android Platform 35 r02'; archive='platform-35_r02.zip'; url='https://dl.google.com/android/repository/platform-35_r02.zip'; size=64273788; algorithm='SHA1'; checksum='0bb560a90a7a2cbd0dd8348224d518b638fe7949'; destination=(Join-Path $toolRoot 'platform'); check=(Join-Path $platform 'android.jar') }
)

foreach ($origin in $origins) {
  if (!(Test-Path -LiteralPath $origin.check)) {
    $archive = Ensure-Archive $origin.archive $origin.url $origin.size $origin.algorithm $origin.checksum
    if (Test-Path -LiteralPath $origin.destination) { throw "工具解包目录已存在但不完整：$($origin.destination)，请先检查，不会覆盖。" }
    Expand-Archive -LiteralPath $archive -DestinationPath $origin.destination
  }
}

$java = Join-Path $jdkDirectory 'bin\java.exe'
$javac = Join-Path $jdkDirectory 'bin\javac.exe'
$jar = Join-Path $jdkDirectory 'bin\jar.exe'
$keytool = Join-Path $jdkDirectory 'bin\keytool.exe'
$aapt = Join-Path $buildTools 'aapt2.exe'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$d8 = Join-Path $buildTools 'lib\d8.jar'
$signer = Join-Path $buildTools 'lib\apksigner.jar'
$androidJar = Join-Path $platform 'android.jar'
$toolFiles = @($java, $javac, $jar, $keytool, $aapt, $zipalign, $d8, $signer, $androidJar)
$toolManifestPath = Join-Path $toolRoot 'tool-manifest.json'
$toolHashes = @($toolFiles | ForEach-Object { [pscustomobject]@{ path=$_; sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() } })
if (Test-Path -LiteralPath $toolManifestPath) {
  $previous = Get-Content -LiteralPath $toolManifestPath -Raw | ConvertFrom-Json
  foreach ($tool in $toolHashes) {
    $expected = $previous.files | Where-Object { $_.path -eq $tool.path } | Select-Object -First 1
    if (!$expected -or $expected.sha256 -ne $tool.sha256) { throw "已提取工具发生变化：$($tool.path)，请核对后重新准备工具。" }
  }
} else {
  [pscustomobject]@{ preparedAt=[DateTimeOffset]::Now.ToString('o'); sources=$origins; files=$toolHashes } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $toolManifestPath -Encoding UTF8
}
if ($PrepareOnly) { Write-Output "Android工具已准备并校验：$toolRoot"; exit 0 }

$branch = (& git -C $projectRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) { throw '无法读取Git分支' }
$changes = (& git -C $projectRoot status --porcelain) -join "`n"
if ($branch -ne 'main' -or $changes.Trim()) { throw 'Android安装包必须从干净的本地 main 构建' }
$sourceSha = (& git -C $projectRoot rev-parse HEAD).Trim()
$dist = Join-Path $projectRoot 'dist'
if (!(Test-Path -LiteralPath (Join-Path $dist 'index.html'))) { throw '请先从同一份干净 main 执行 npm run build' }
$native = Join-Path $projectRoot 'android-native'
$build = Join-Path $toolRoot ('build-' + $sourceSha.Substring(0, 12))
if (Test-Path -LiteralPath $build) { throw "本次源码的构建目录已存在：$build。请核对上次结果后处理，不自动覆盖。" }
$release = Join-Path $projectRoot 'release'
$apk = Join-Path $release '本地清单-Android.apk'
if (Test-Path -LiteralPath $apk) { throw 'Android交付包已存在，请先核验并归档上一包，脚本不会覆盖' }
$assets = Join-Path $build 'assets'
$web = Join-Path $assets 'www'
$classes = Join-Path $build 'classes'
$generated = Join-Path $build 'generated'
$dex = Join-Path $build 'dex'
foreach ($directory in @($build, $assets, $web, $classes, $generated, $dex)) { New-Item -ItemType Directory -Path $directory | Out-Null }
if (!(Test-Path -LiteralPath $release)) { New-Item -ItemType Directory -Path $release | Out-Null }
Get-ChildItem -LiteralPath $dist | Copy-Item -Destination $web -Recurse
Copy-Item -LiteralPath (Join-Path $native 'bridge.js') -Destination (Join-Path $web 'native-bridge.js')
$indexPath = Join-Path $web 'index.html'
$index = [IO.File]::ReadAllText($indexPath)
if ($index -notmatch '<head>') { throw '无法在前端入口注入本地桥接脚本' }
$index = $index.Replace('<head>', '<head><script src="./native-bridge.js"></script>')
[IO.File]::WriteAllText($indexPath, $index, [Text.UTF8Encoding]::new($false))
$resources = Join-Path $build 'compiled-res.zip'
$unsigned = Join-Path $build 'unsigned.apk'
$aligned = Join-Path $build 'aligned.apk'
Invoke-Checked $aapt @('compile', '--dir', (Join-Path $native 'res'), '-o', $resources)
Invoke-Checked $aapt @('link', '-o', $unsigned, '-I', $androidJar, '--manifest', (Join-Path $native 'AndroidManifest.xml'), '--java', $generated, '-A', $assets, '--min-sdk-version', '26', '--target-sdk-version', '35', $resources)
$javaSources = @((Get-ChildItem -LiteralPath (Join-Path $native 'src') -Filter '*.java' -Recurse).FullName) + @((Get-ChildItem -LiteralPath $generated -Filter '*.java' -Recurse).FullName)
Invoke-Checked $javac (@('-encoding', 'UTF-8', '-source', '8', '-target', '8', '-bootclasspath', $androidJar, '-d', $classes) + $javaSources)
$classesJar = Join-Path $build 'classes.jar'
Invoke-Checked $jar @('--create', '--file', $classesJar, '-C', $classes, '.')
Invoke-Checked $java @('-cp', $d8, 'com.android.tools.r8.D8', '--min-api', '26', '--lib', $androidJar, '--output', $dex, $classesJar)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($unsigned, [IO.Compression.ZipArchiveMode]::Update)
try {
  foreach ($file in Get-ChildItem -LiteralPath $dex -Filter '*.dex' -File) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $file.Name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
Invoke-Checked $zipalign @('-p', '-f', '4', $unsigned, $aligned)
$privateDirectory = Join-Path $native 'private'
$keystore = Join-Path $privateDirectory 'local-release.jks'
$passwordFile = Join-Path $privateDirectory 'signing-password.txt'
if (!(Test-Path -LiteralPath $privateDirectory)) { New-Item -ItemType Directory -Path $privateDirectory | Out-Null }
if ((Test-Path -LiteralPath $keystore) -and !(Test-Path -LiteralPath $passwordFile)) { throw '已存在签名密钥但缺少密码文件；请恢复原密码文件，不会重新生成密钥' }
if (!(Test-Path -LiteralPath $passwordFile)) {
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $randomBytes = New-Object byte[] 32; $random.GetBytes($randomBytes) }
  finally { $random.Dispose() }
  [IO.File]::WriteAllText($passwordFile, [Convert]::ToBase64String($randomBytes), [Text.UTF8Encoding]::new($false))
}
$previousSigningPass = [Environment]::GetEnvironmentVariable('DIDA_ANDROID_SIGNING_PASS', 'Process')
try {
  $keyPassword = [IO.File]::ReadAllText($passwordFile).Trim()
  if ($keyPassword.Length -lt 32) { throw '签名密码文件无效，请恢复原文件' }
  [Environment]::SetEnvironmentVariable('DIDA_ANDROID_SIGNING_PASS', $keyPassword, 'Process')
  if (!(Test-Path -LiteralPath $keystore)) {
    Invoke-Checked $keytool @('-genkeypair', '-keystore', $keystore, '-storepass:env', 'DIDA_ANDROID_SIGNING_PASS', '-keypass:env', 'DIDA_ANDROID_SIGNING_PASS', '-alias', 'dida-local', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '3650', '-dname', 'CN=Local Tasks Personal Build')
  }
  Invoke-Checked $java @('-jar', $signer, 'sign', '--ks', $keystore, '--ks-key-alias', 'dida-local', '--ks-pass', 'env:DIDA_ANDROID_SIGNING_PASS', '--key-pass', 'env:DIDA_ANDROID_SIGNING_PASS', '--out', $apk, $aligned)
} finally {
  [Environment]::SetEnvironmentVariable('DIDA_ANDROID_SIGNING_PASS', $previousSigningPass, 'Process')
  $keyPassword = $null
}
Invoke-Checked $java @('-jar', $signer, 'verify', '--verbose', '--print-certs', $apk)
Invoke-Checked $zipalign @('-c', '-p', '4', $apk)
$permissions = (& $aapt dump permissions $apk) -join "`n"
if ($LASTEXITCODE -ne 0 -or $permissions -match 'android.permission.INTERNET') { throw 'Android权限检查失败' }
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
$report = [pscustomobject]@{ product='本地清单'; platform='Android'; applicationId='local.dida.tasks'; sourceSha=$sourceSha; builtAt=[DateTimeOffset]::Now.ToString('o'); apk=$apk; size=(Get-Item -LiteralPath $apk).Length; sha256=$hash; toolsManifest=$toolManifestPath; keystore=$keystore; signingPasswordFile=$passwordFile; networkPermission=$false; minimumAndroid='8.0'; reminders='普通AlarmManager；系统省电可能延迟，未作真机验收'; permissions=$permissions }
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $release 'android-build-info.json') -Encoding UTF8
$report | ConvertTo-Json -Depth 5
