using System;
using System.IO;
using System.Runtime.InteropServices;

namespace PiFileTools {
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetParent(out IShellItem parent);
    [PreserveSig] int GetDisplayName(uint sigdn, out IntPtr name);
    [PreserveSig] int GetAttributes(uint mask, out uint attributes);
    [PreserveSig] int Compare(IShellItem other, uint hint, out int order);
  }
  [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperation {
    [PreserveSig] int Advise(IFileOperationProgressSink sink, out uint cookie);
    [PreserveSig] int Unadvise(uint cookie);
    [PreserveSig] int SetOperationFlags(uint flags);
    [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
    [PreserveSig] int SetProgressDialog([MarshalAs(UnmanagedType.IUnknown)] object dialog);
    [PreserveSig] int SetProperties([MarshalAs(UnmanagedType.IUnknown)] object properties);
    [PreserveSig] int SetOwnerWindow(IntPtr hwnd);
    [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
    [PreserveSig] int ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object items);
    [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
    [PreserveSig] int RenameItems([MarshalAs(UnmanagedType.IUnknown)] object items, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int MoveItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
    [PreserveSig] int MoveItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destination);
    [PreserveSig] int CopyItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IFileOperationProgressSink sink);
    [PreserveSig] int CopyItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destination);
    [PreserveSig] int DeleteItem(IShellItem item, IFileOperationProgressSink sink);
    [PreserveSig] int DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object items);
    [PreserveSig] int NewItem(IShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string templateName, IFileOperationProgressSink sink);
    [PreserveSig] int PerformOperations();
    [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
  }
  [ComVisible(true), Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperationProgressSink {
    [PreserveSig] int StartOperations();
    [PreserveSig] int FinishOperations(int result);
    [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem newItem);
    [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem newItem);
    [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem newItem);
    [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
    [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem newItem);
    [PreserveSig] int PreNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int PostNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string templateName, uint attributes, int result, IShellItem newItem);
    [PreserveSig] int UpdateProgress(uint total, uint soFar);
    [PreserveSig] int ResetTimer();
    [PreserveSig] int PauseTimer();
    [PreserveSig] int ResumeTimer();
  }
  [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
  public sealed class Sink : IFileOperationProgressSink {
    public bool RequireRecycle;
    public string Destination;
    public string ResultPath;
    public int ItemError;
    public bool Completed;
    public bool RefusedPermanentDelete;
    public static bool Exists(string value) {
      try { File.GetAttributes(value); return true; }
      catch (FileNotFoundException) { return false; }
      catch (DirectoryNotFoundException) { return false; }
    }
    private void Record(int result, IShellItem item) {
      if (result < 0) ItemError = result;
      else { Completed = true; if (item != null) ResultPath = Native.PathOf(item); }
    }
    public int StartOperations() { return 0; }
    public int FinishOperations(int result) { if (result < 0) ItemError = result; return 0; }
    public int PreRenameItem(uint f, IShellItem i, string n) { return 0; }
    public int PostRenameItem(uint f, IShellItem i, string n, int r, IShellItem x) { Record(r,x); return 0; }
    public int PreMoveItem(uint f, IShellItem i, IShellItem d, string n) {
      try { return Destination != null && Exists(Destination) ? unchecked((int)0x80070050) : 0; }
      catch { return unchecked((int)0x80070005); }
    }
    public int PostMoveItem(uint f, IShellItem i, IShellItem d, string n, int r, IShellItem x) { Record(r,x); return 0; }
    public int PreCopyItem(uint f, IShellItem i, IShellItem d, string n) { return 0; }
    public int PostCopyItem(uint f, IShellItem i, IShellItem d, string n, int r, IShellItem x) { Record(r,x); return 0; }
    public int PreDeleteItem(uint flags, IShellItem item) {
      // Reject the operation when Shell would destroy instead of recycling.
      if (RequireRecycle && (flags & 0x80) == 0) { RefusedPermanentDelete = true; return unchecked((int)0x80004004); }
      return 0;
    }
    public int PostDeleteItem(uint f, IShellItem i, int r, IShellItem x) { Record(r,x); return 0; }
    public int PreNewItem(uint f, IShellItem d, string n) { return 0; }
    public int PostNewItem(uint f, IShellItem d, string n, string t, uint a, int r, IShellItem x) { Record(r,x); return 0; }
    public int UpdateProgress(uint t, uint s) { return 0; }
    public int ResetTimer() { return 0; }
    public int PauseTimer() { return 0; }
    public int ResumeTimer() { return 0; }
  }
  public static class Native {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=true)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid iid, out IShellItem item);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(string source, string destination, uint flags);
    private static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
    public static string PathOf(IShellItem item) {
      IntPtr text; int hr = item.GetDisplayName(0x80028000, out text);
      if (hr < 0) return null;
      try { return Marshal.PtrToStringUni(text); } finally { Marshal.FreeCoTaskMem(text); }
    }
    private static IShellItem Item(string path) {
      Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"); IShellItem result;
      Check(SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out result)); return result;
    }
    public static void MoveNoReplace(string source, string destination) {
      if (!MoveFileExW(source, destination, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    public static string Operate(string action, string source, string destination) {
      IFileOperation op = null; IShellItem item = null; IShellItem parent = null;
      Sink sink = new Sink { RequireRecycle = action == "put", Destination = destination };
      try {
        op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
        // No UI + early failure. Put always requests recycle; moves rename on a late collision rather than overwrite.
        uint flags = 0x00000614 | 0x00100000;
        if (action == "put") flags |= 0x00080000 | 0x20000000;
        if (action == "restore") flags |= 0x00000008;
        Check(op.SetOperationFlags(flags)); item = Item(source);
        if (action == "restore") {
          if (Sink.Exists(destination)) throw new IOException("Restore destination already exists.");
          parent = Item(Path.GetDirectoryName(destination));
          Check(op.MoveItem(item, parent, Path.GetFileName(destination), sink));
        } else Check(op.DeleteItem(item, sink));
        int performed = op.PerformOperations(); bool aborted; Check(op.GetAnyOperationsAborted(out aborted));
        if (sink.RefusedPermanentDelete) throw new IOException("Recycle Bin unavailable: refused permanent deletion; source was not intentionally destroyed.");
        Check(sink.ItemError); Check(performed);
        if (aborted || !sink.Completed) throw new IOException("Shell aborted or skipped the item; inspect source and Recycle Bin before retrying.");
        return sink.ResultPath;
      } finally {
        GC.KeepAlive(sink);
        if (parent != null) Marshal.ReleaseComObject(parent);
        if (item != null) Marshal.ReleaseComObject(item);
        if (op != null) Marshal.ReleaseComObject(op);
      }
    }
  }
}
