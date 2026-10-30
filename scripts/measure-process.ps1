param(
    [Parameter(Mandatory=$true)][int]$RootProcessId,
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [ValidateRange(2,30)][int]$Seconds = 5
)
$ErrorActionPreference = 'Stop'
function Snapshot {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name
    $members = [System.Collections.Generic.HashSet[int]]::new()
    [void]$members.Add($RootProcessId)
    do {
        $changed = $false
        foreach ($entry in $all) {
            if ($members.Contains([int]$entry.ParentProcessId) -and $members.Add([int]$entry.ProcessId)) { $changed = $true }
        }
    } while ($changed)
    @($all | Where-Object {$members.Contains([int]$_.ProcessId)} | ForEach-Object {
        $item = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($item) { [pscustomobject]@{pid=$item.Id;parent=$_.ParentProcessId;name=$_.Name;privateBytes=$item.PrivateMemorySize64;workingSetBytes=$item.WorkingSet64;cpuSeconds=$item.TotalProcessorTime.TotalSeconds} }
    })
}
$start = @(Snapshot)
$timer = [System.Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$end = @(Snapshot)
$timer.Stop()
$cpuDelta = 0.0
foreach ($process in $end) {
    $prior = $start | Where-Object pid -EQ $process.pid | Select-Object -First 1
    if ($prior) { $cpuDelta += [Math]::Max(0,$process.cpuSeconds - $prior.cpuSeconds) }
}
$result = [ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');label=$Label;rootPid=$RootProcessId;durationSeconds=$timer.Elapsed.TotalSeconds;cpuPercentOneCore=100*$cpuDelta/$timer.Elapsed.TotalSeconds;privateBytes=($end|Measure-Object privateBytes -Sum).Sum;workingSetBytes=($end|Measure-Object workingSetBytes -Sum).Sum;processes=$end}
$destination = [IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $destination -Encoding utf8
$result | ConvertTo-Json -Depth 6
