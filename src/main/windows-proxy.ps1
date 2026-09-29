$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class HaloSystemProxy {
  [StructLayout(LayoutKind.Explicit)] struct Value {
    [FieldOffset(0)] public int Number;
    [FieldOffset(0)] public IntPtr Text;
    [FieldOffset(0)] public long Time;
  }
  [StructLayout(LayoutKind.Sequential)] struct Option { public int Id; public Value Data; }
  [StructLayout(LayoutKind.Sequential)] struct Options {
    public int Size; public IntPtr Connection; public int Count; public int Error; public IntPtr Items;
  }
  public class State {
    public int flags;
    public string server;
    public string bypass;
    public string script;
  }
  [DllImport("wininet.dll", EntryPoint="InternetQueryOptionW", SetLastError=true)]
  static extern bool Query(IntPtr handle, int option, ref Options value, ref int size);
  [DllImport("wininet.dll", EntryPoint="InternetSetOptionW", SetLastError=true)]
  static extern bool Set(IntPtr handle, int option, ref Options value, int size);
  [DllImport("wininet.dll", EntryPoint="InternetSetOptionW", SetLastError=true)]
  static extern bool Notify(IntPtr handle, int option, IntPtr value, int size);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
  static Options Allocate() {
    return new Options { Size=Marshal.SizeOf(typeof(Options)), Count=4, Items=Marshal.AllocHGlobal(4*Marshal.SizeOf(typeof(Option))) };
  }
  static IntPtr At(Options options, int index) { return IntPtr.Add(options.Items,index*Marshal.SizeOf(typeof(Option))); }
  static Option Get(Options options, int index) { return (Option)Marshal.PtrToStructure(At(options,index),typeof(Option)); }
  public static State Read() {
    Options options=Allocate();
    try {
      int[] ids={10,2,3,4}; // FLAGS_UI, PROXY_SERVER, PROXY_BYPASS, AUTOCONFIG_URL
      for(int i=0;i<4;i++) Marshal.StructureToPtr(new Option {Id=ids[i]},At(options,i),false);
      int size=options.Size;
      if(!Query(IntPtr.Zero,75,ref options,ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return new State { flags=Get(options,0).Data.Number, server=Marshal.PtrToStringUni(Get(options,1).Data.Text) ?? "",
        bypass=Marshal.PtrToStringUni(Get(options,2).Data.Text) ?? "", script=Marshal.PtrToStringUni(Get(options,3).Data.Text) ?? "" };
    } finally {
      for(int i=1;i<4;i++) { IntPtr text=Get(options,i).Data.Text; if(text!=IntPtr.Zero) GlobalFree(text); }
      Marshal.FreeHGlobal(options.Items);
    }
  }
  public static void Write(int flags, string server, string bypass, string script) {
    Options options=Allocate();
    IntPtr[] strings={Marshal.StringToHGlobalUni(server ?? ""),Marshal.StringToHGlobalUni(bypass ?? ""),Marshal.StringToHGlobalUni(script ?? "")};
    try {
      Marshal.StructureToPtr(new Option {Id=1,Data=new Value {Number=flags}},At(options,0),false);
      for(int i=1;i<4;i++) Marshal.StructureToPtr(new Option {Id=i+1,Data=new Value {Text=strings[i-1]}},At(options,i),false);
      if(!Set(IntPtr.Zero,75,ref options,options.Size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if(!Notify(IntPtr.Zero,39,IntPtr.Zero,0)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if(!Notify(IntPtr.Zero,37,IntPtr.Zero,0)) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr result;
      SendMessageTimeout(new IntPtr(0xffff),0x1a,IntPtr.Zero,"Internet Settings",2,1000,out result);
    } finally {
      foreach(IntPtr text in strings) Marshal.FreeHGlobal(text);
      Marshal.FreeHGlobal(options.Items);
    }
  }
}
'@
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -eq 'write') {
    [HaloSystemProxy]::Write([int]$request.state.flags, [string]$request.state.server, [string]$request.state.bypass, [string]$request.state.script)
  } elseif ($request.action -ne 'read') { throw 'Invalid proxy action' }
  [HaloSystemProxy]::Read() | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}

