/* Native chrome for the stock NSIS installer. No installation/file operations.
 * Build as a 32-bit DLL because electron-builder's NSIS host is 32-bit.
 * All callbacks stay on the installer's existing UI thread. */
#define UNICODE
#define _UNICODE
#include <windows.h>

static HWND parent, caption;
static WNDPROC original;
static WNDPROC buttonOriginal[4];
static HWND directoryEdit, directoryBrowse, directoryField;
static WNDPROC editOriginal, browseOriginal;
static HFONT textFont;
static HBRUSH whiteBrush;
static HMODULE module;
static int dpi = 96, currentPage, hot = -1;
static int px(int value) { return MulDiv(value, dpi, 96); }
static int closeEnabled(void) {
  return currentPage == 3 || IsWindowEnabled(GetDlgItem(parent, 2));
}

static void drawButton(HWND hwnd, HDC dc, RECT rect, UINT state) {
  int id = GetDlgCtrlID(hwnd);
  HBRUSH brush;
  HFONT oldFont;
  WCHAR label[128];
  BOOL main = id == 1, enabled = IsWindowEnabled(hwnd);
  COLORREF fill = main ? (enabled ? RGB(32,33,38) : RGB(207,209,214)) : RGB(255,255,255);
  if (main && enabled && (state & BST_PUSHED)) fill = RGB(61,63,70);
  brush = CreateSolidBrush(fill);
  FillRect(dc, &rect, brush); DeleteObject(brush);
  oldFont = SelectObject(dc, textFont);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, main ? RGB(255,255,255) : RGB(119,121,130));
  GetWindowTextW(hwnd, label, 128);
  DrawTextW(dc, label, -1, &rect, DT_CENTER|DT_VCENTER|DT_SINGLELINE);
  if (enabled && GetFocus() == hwnd) {
    InflateRect(&rect, -px(4), -px(4)); DrawFocusRect(dc, &rect);
  }
  SelectObject(dc, oldFont);
}

static LRESULT CALLBACK ButtonProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  int id = GetDlgCtrlID(hwnd);
  /* NSIS changes the default-button style as pages change. Paint independently
   * of that style, preserving its native focus, keyboard and command handlers. */
  if (msg == WM_PAINT) {
    PAINTSTRUCT paint;
    RECT rect;
    HDC dc = BeginPaint(hwnd,&paint);
    UINT state = (UINT)CallWindowProcW(buttonOriginal[id],hwnd,BM_GETSTATE,0,0);
    GetClientRect(hwnd,&rect); drawButton(hwnd,dc,rect,state);
    EndPaint(hwnd,&paint); return 0;
  }
  if (msg == WM_ERASEBKGND) return 1;
  return CallWindowProcW(buttonOriginal[id],hwnd,msg,wp,lp);
}

static LRESULT CALLBACK DirectoryFieldProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_ERASEBKGND) return 1;
  if (msg == WM_PAINT) {
    PAINTSTRUCT paint;
    RECT rect;
    HDC dc = BeginPaint(hwnd, &paint);
    HBRUSH fill = CreateSolidBrush(RGB(247,247,248));
    HPEN border = CreatePen(PS_SOLID, px(1), GetFocus() == directoryEdit ? RGB(160,162,170) : RGB(228,229,233));
    HGDIOBJ oldBrush = SelectObject(dc,fill), oldPen = SelectObject(dc,border);
    GetClientRect(hwnd,&rect);
    RoundRect(dc,0,0,rect.right,rect.bottom,px(10),px(10));
    SelectObject(dc,oldBrush); SelectObject(dc,oldPen);
    DeleteObject(fill); DeleteObject(border);
    EndPaint(hwnd,&paint); return 0;
  }
  return DefWindowProcW(hwnd,msg,wp,lp);
}

static LRESULT CALLBACK DirectoryEditProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  LRESULT result = CallWindowProcW(editOriginal,hwnd,msg,wp,lp);
  if ((msg == WM_SETFOCUS || msg == WM_KILLFOCUS) && IsWindow(directoryField))
    InvalidateRect(directoryField,NULL,FALSE);
  return result;
}

static LRESULT CALLBACK BrowseProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_ERASEBKGND) return 1;
  if (msg == WM_PAINT) {
    PAINTSTRUCT paint;
    RECT rect, label;
    HDC dc = BeginPaint(hwnd,&paint);
    UINT state = (UINT)CallWindowProcW(browseOriginal,hwnd,BM_GETSTATE,0,0);
    HBRUSH brush = CreateSolidBrush(state & BST_PUSHED ? RGB(235,236,239) : RGB(247,247,248));
    HPEN pen = CreatePen(PS_SOLID,px(1),RGB(228,229,233));
    HGDIOBJ oldPen = SelectObject(dc,pen), oldFont = SelectObject(dc,textFont);
    GetClientRect(hwnd,&rect); FillRect(dc,&rect,brush);
    MoveToEx(dc,0,px(10),NULL); LineTo(dc,0,rect.bottom-px(10));
    label = rect; SetBkMode(dc,TRANSPARENT); SetTextColor(dc,RGB(75,77,84));
    DrawTextW(dc,L"浏览",-1,&label,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
    if (GetFocus() == hwnd) { InflateRect(&rect,-px(5),-px(5)); DrawFocusRect(dc,&rect); }
    SelectObject(dc,oldPen); SelectObject(dc,oldFont);
    DeleteObject(brush); DeleteObject(pen); EndPaint(hwnd,&paint); return 0;
  }
  return CallWindowProcW(browseOriginal,hwnd,msg,wp,lp);
}

static LRESULT CALLBACK CaptionProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  RECT rect, button;
  POINT point;
  int width, hit;
  switch (msg) {
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: {
      PAINTSTRUCT paint;
      HDC dc = BeginPaint(hwnd, &paint);
      HPEN pen, oldPen;
      GetClientRect(hwnd, &rect);
      FillRect(dc, &rect, whiteBrush);
      width = rect.right;
      if (hot >= 0) {
        HBRUSH hover = CreateSolidBrush(hot == 1 && closeEnabled() ? RGB(245,245,247) : RGB(249,249,250));
        SetRect(&button, width - px(hot == 0 ? 92 : 52), px(8), width - px(hot == 0 ? 60 : 20), px(40));
        FillRect(dc, &button, hover);
        DeleteObject(hover);
      }
      pen = CreatePen(PS_SOLID, px(1) > 0 ? px(1) : 1, RGB(75,77,84));
      oldPen = SelectObject(dc, pen);
      MoveToEx(dc, width-px(82), px(24), NULL); LineTo(dc, width-px(70), px(24));
      SelectObject(dc, oldPen); DeleteObject(pen);
      pen = CreatePen(PS_SOLID, px(1) > 0 ? px(1) : 1, closeEnabled() ? RGB(75,77,84) : RGB(203,205,210));
      oldPen = SelectObject(dc, pen);
      MoveToEx(dc, width-px(41), px(19), NULL); LineTo(dc, width-px(31), px(29));
      MoveToEx(dc, width-px(31), px(19), NULL); LineTo(dc, width-px(41), px(29));
      SelectObject(dc, oldPen); DeleteObject(pen);
      EndPaint(hwnd, &paint);
      return 0;
    }
    case WM_MOUSEMOVE: {
      TRACKMOUSEEVENT tracking;
      GetClientRect(hwnd, &rect);
      point.x = (short)LOWORD(lp); point.y = (short)HIWORD(lp);
      hit = point.y >= px(8) && point.y < px(40) ?
        (point.x >= rect.right-px(52) && point.x < rect.right-px(20) ? 1 :
        (point.x >= rect.right-px(92) && point.x < rect.right-px(60) ? 0 : -1)) : -1;
      if (hit != hot) { hot = hit; InvalidateRect(hwnd, NULL, FALSE); }
      tracking.cbSize = sizeof(tracking); tracking.dwFlags = TME_LEAVE;
      tracking.hwndTrack = hwnd; tracking.dwHoverTime = 0;
      TrackMouseEvent(&tracking);
      return 0;
    }
    case WM_MOUSELEAVE: hot = -1; InvalidateRect(hwnd, NULL, FALSE); return 0;
    case WM_LBUTTONDOWN:
      if (hot < 0) { ReleaseCapture(); SendMessageW(parent, WM_NCLBUTTONDOWN, HTCAPTION, 0); }
      return 0;
    case WM_LBUTTONUP:
      if (hot == 0) ShowWindow(parent, SW_MINIMIZE);
      else if (hot == 1 && closeEnabled())
        PostMessageW(parent, WM_COMMAND, currentPage == 3 ? 1 : 2, 0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

static LRESULT CALLBACK ParentProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_DRAWITEM && wp >= 1 && wp <= 3) {
    DRAWITEMSTRUCT *item = (DRAWITEMSTRUCT *)lp;
    drawButton(item->hwndItem,item->hDC,item->rcItem,
      item->itemState & ODS_SELECTED ? BST_PUSHED : 0);
    return TRUE;
  }
  if (msg == WM_ERASEBKGND) {
    RECT rect; GetClientRect(hwnd, &rect); FillRect((HDC)wp, &rect, whiteBrush); return 1;
  }
  if (msg == WM_NCDESTROY) {
    LRESULT result = CallWindowProcW(original, hwnd, msg, wp, lp);
    DeleteObject(textFont); DeleteObject(whiteBrush);
    return result;
  }
  return CallWindowProcW(original, hwnd, msg, wp, lp);
}

__declspec(dllexport) void __cdecl Attach(HWND hwnd, int windowDpi) {
  WNDCLASSW cls;
  int corner = 2;
  HMODULE dwm;
  typedef HRESULT (WINAPI *DwmAttribute)(HWND,DWORD,LPCVOID,DWORD);
  DwmAttribute attribute;
  WCHAR library[MAX_PATH];
  parent = hwnd; dpi = windowDpi > 0 ? windowDpi : 96;
  /* Keep this module loaded until the installer exits: registered callbacks
   * outlive the individual System plugin call. */
  GetModuleFileNameW(module, library, MAX_PATH); LoadLibraryW(library);
  whiteBrush = CreateSolidBrush(RGB(255,255,255));
  textFont = CreateFontW(-px(13),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,
    OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Microsoft YaHei UI");
  SetWindowLongW(hwnd, GWL_STYLE, GetWindowLongW(hwnd,GWL_STYLE) & ~(WS_CAPTION|WS_THICKFRAME));
  SetWindowPos(hwnd,NULL,0,0,px(600),px(440),SWP_NOMOVE|SWP_NOZORDER|SWP_FRAMECHANGED);
  dwm = LoadLibraryW(L"dwmapi.dll");
  if (dwm) { attribute = (DwmAttribute)GetProcAddress(dwm,"DwmSetWindowAttribute");
    if (attribute) attribute(hwnd,33,&corner,sizeof(corner)); FreeLibrary(dwm); }
  ZeroMemory(&cls,sizeof(cls)); cls.lpfnWndProc = CaptionProc; cls.hInstance = module;
  cls.lpszClassName = L"PiHaloInstallerCaption"; cls.hCursor = LoadCursor(NULL,IDC_ARROW);
  cls.hbrBackground = whiteBrush; RegisterClassW(&cls);
  caption = CreateWindowExW(0,cls.lpszClassName,L"",WS_CHILD|WS_VISIBLE,
    0,0,px(600),px(48),hwnd,NULL,module,NULL);
  cls.lpfnWndProc = DirectoryFieldProc; cls.lpszClassName = L"PiHaloDirectoryField";
  RegisterClassW(&cls);
  original = (WNDPROC)SetWindowLongW(hwnd,GWL_WNDPROC,(LONG)ParentProc);
  for (int id=1; id<=3; id++) {
    HWND button = GetDlgItem(hwnd,id);
    SetWindowLongW(button,GWL_STYLE,(GetWindowLongW(button,GWL_STYLE)&~BS_TYPEMASK)|BS_OWNERDRAW);
    buttonOriginal[id] = (WNDPROC)SetWindowLongW(button,GWL_WNDPROC,(LONG)ButtonProc);
  }
}

__declspec(dllexport) void __cdecl Refresh(int page) {
  currentPage = page;
  SetWindowPos(caption,HWND_TOP,0,0,px(600),px(48),SWP_SHOWWINDOW);
  ShowWindow(GetDlgItem(parent,2),SW_HIDE);
  SetWindowPos(GetDlgItem(parent,1),HWND_TOP,px(230),px(368),px(140),px(38),0);
  ShowWindow(GetDlgItem(parent,1),page == 2 ? SW_HIDE : SW_SHOW);
  ShowWindow(GetDlgItem(parent,3),SW_HIDE);
  InvalidateRect(caption,NULL,TRUE);
}

/* Keep the real MUI edit and browse controls: path validation, keyboard editing
 * and the native folder dialog remain unchanged underneath the compact field. */
__declspec(dllexport) void __cdecl StyleDirectory(HWND edit, HWND browse) {
  HWND page = GetParent(edit);
  directoryEdit = edit; directoryBrowse = browse;
  SetWindowLongW(edit,GWL_STYLE,GetWindowLongW(edit,GWL_STYLE)&~WS_BORDER);
  SetWindowLongW(edit,GWL_EXSTYLE,GetWindowLongW(edit,GWL_EXSTYLE)&~(WS_EX_CLIENTEDGE|WS_EX_STATICEDGE));
  SetWindowPos(edit,NULL,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED);
  SendMessageW(edit,EM_SETMARGINS,EC_LEFTMARGIN|EC_RIGHTMARGIN,0);
  directoryField = CreateWindowExW(0,L"PiHaloDirectoryField",L"",WS_CHILD|WS_VISIBLE|WS_CLIPSIBLINGS,
    px(60),px(228),px(480),px(42),page,NULL,module,NULL);
  SetWindowPos(directoryField,HWND_BOTTOM,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE);
  SetWindowPos(edit,HWND_TOP,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE);
  SetWindowPos(browse,HWND_TOP,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE);
  editOriginal = (WNDPROC)SetWindowLongW(edit,GWL_WNDPROC,(LONG)DirectoryEditProc);
  browseOriginal = (WNDPROC)SetWindowLongW(browse,GWL_WNDPROC,(LONG)BrowseProc);
  InvalidateRect(page,NULL,TRUE);
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
  if (reason == DLL_PROCESS_ATTACH) module = instance;
  return TRUE;
}
