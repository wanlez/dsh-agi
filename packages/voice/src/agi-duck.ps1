# dsh-agi 音量压低助手（Windows Core Audio）
# 常驻进程：从 stdin 读 duck / restore / status / quit，其余输入忽略
# duck    -> 记下当前音量与静音状态，压到 15%（当前更低则不动），并解除静音
# restore -> 恢复原音量与原静音状态
# 进程 stdin 关闭（宿主/子进程退出）时自动 restore，避免音量卡在低位
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OrbVolume
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr notify);
        int UnregisterControlChangeNotify(IntPtr notify);
        int GetChannelCount(out int count);
        int SetMasterVolumeLevel(float level, Guid eventContext);
        int SetMasterVolumeLevelScalar(float level, Guid eventContext);
        int GetMasterVolumeLevel(out float level);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float level, Guid eventContext);
        int SetChannelVolumeLevelScalar(uint channel, float level, Guid eventContext);
        int GetChannelVolumeLevel(uint channel, out float level);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    private static IAudioEndpointVolume Endpoint()
    {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
        var iid = typeof(IAudioEndpointVolume).GUID;
        object iface;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out iface));
        return (IAudioEndpointVolume)iface;
    }

    public static float GetVolume() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
    public static void SetVolume(float v) { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
    public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }
    public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, Guid.Empty)); }
}
'@

$script:savedVolume = $null
$script:savedMute = $false

function Invoke-Duck {
    if ($null -eq $script:savedVolume) {
        $script:savedVolume = [OrbVolume]::GetVolume()
        $script:savedMute = [OrbVolume]::GetMute()
    }
    $target = [Math]::Min([double]$script:savedVolume, 0.15)
    [OrbVolume]::SetMute($false)
    [OrbVolume]::SetVolume([float]$target)
}

function Invoke-Restore {
    if ($null -ne $script:savedVolume) {
        [OrbVolume]::SetMute([bool]$script:savedMute)
        [OrbVolume]::SetVolume([float]$script:savedVolume)
        $script:savedVolume = $null
    }
}

if ($SelfTest) {
    "before volume={0:N3} mute={1}" -f [OrbVolume]::GetVolume(), [OrbVolume]::GetMute()
    Invoke-Duck
    Start-Sleep -Milliseconds 250
    "ducked volume={0:N3}" -f [OrbVolume]::GetVolume()
    Invoke-Restore
    Start-Sleep -Milliseconds 250
    "restored volume={0:N3} mute={1}" -f [OrbVolume]::GetVolume(), [OrbVolume]::GetMute()
    return
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { Invoke-Restore; break }
    switch ($line.Trim().ToLowerInvariant()) {
        'duck'    { Invoke-Duck }
        'restore' { Invoke-Restore }
        'status'  { "volume={0:N3} mute={1} saved={2}" -f [OrbVolume]::GetVolume(), [OrbVolume]::GetMute(), ($null -ne $script:savedVolume) }
    }
}
