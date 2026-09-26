# Reads Windows' System Media Transport Controls — the same source as the volume-key
# overlay — and prints one compact JSON line every couple of seconds.
#
# Read-only on purpose: this never sends play/pause/next back to the player.
# If the WinRT types are not available the script says so once and exits, and the
# app simply behaves as though nothing is playing.

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

    function Await($operation, $resultType) {
        $method = $asTaskGeneric.MakeGenericMethod($resultType)
        $task = $method.Invoke($null, @($operation))
        $null = $task.Wait(5000)
        return $task.Result
    }

    [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

    $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
    $manager = Await ($managerType::RequestAsync()) ($managerType)
} catch {
    Write-Output '{"ok":false,"reason":"smtc-unavailable"}'
    exit 1
}

$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

while ($true) {
    $payload = @{ ok = $true; playing = $false }

    try {
        $session = $manager.GetCurrentSession()
        if ($null -ne $session) {
            $props = Await ($session.TryGetMediaPropertiesAsync()) ($propsType)
            $info = $session.GetPlaybackInfo()
            $status = [string]$info.PlaybackStatus

            $payload.title = [string]$props.Title
            $payload.artist = [string]$props.Artist
            $payload.source = [string]$session.SourceAppUserModelId
            $payload.status = $status
            $payload.playing = ($status -eq 'Playing')
        }
    } catch {
        # A player closing mid-read is normal; report "nothing playing" for this tick.
    }

    Write-Output ($payload | ConvertTo-Json -Compress)
    Start-Sleep -Seconds 2
}
