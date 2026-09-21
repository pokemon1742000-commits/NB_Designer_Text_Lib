"""
auto_import.py
---------------
Script này thao tác trực tiếp lên các control thật của NB-Designer (nút bấm, ô nhập, dialog)
để tự động Import file CSV Text Library, thay vì phải mở Text Library > Import > chọn file thủ công.

LỊCH SỬ: Bản trước đây dùng cách gửi phím mù cố định (Alt+O -> T -> chờ 2s -> Tab x5 -> Enter,
rồi gõ thẳng đường dẫn bằng send_keys) vì không có máy thật để dò control. Bản này đã dò TRỰC TIẾP
trên NB-Designer thật đang chạy (kết nối bằng backend="win32", vì backend="uia" không đọc được cây
control của dialog MFC này - chỉ thấy mỗi TitleBar hoặc bị timeout khi cây quá lớn) và xác nhận:

  - Dialog "Text Library" (class #32770) có các nút Win32 chuẩn, có title rõ ràng:
    "Add", "Delete", "OK", "Language", "Import", "Export", "Delete All", và 1 ListView tên "List1".
  - Bấm nút "Import" mở ra dialog tên "Import Project Database" - đây là common file dialog kiểu cũ
    của Windows, có 1 ô Edit (điền đường dẫn file) và nút "&Open" / "Cancel".

Nhờ vậy, toàn bộ luồng dưới đây thao tác thẳng vào ĐÚNG control bằng title/class_name, có CHỜ và
XÁC MINH từng bước (control có tồn tại/hiển thị chưa) thay vì đoán mù theo thời gian cố định. Nếu
1 bước không tìm thấy control mong đợi, script DỪNG NGAY và báo lỗi rõ ràng, không đoán bừa gửi
tiếp phím vào chỗ khác (tránh gõ nhầm vào canvas thiết kế HMI).

QUAN TRỌNG - quyền Admin: NB-Designer có thể chạy bằng quyền Administrator. Muốn đọc/điều khiển
được control của nó, script này PHẢI chạy CÙNG mức quyền (đã tự kiểm chứng: UIA lẫn win32 backend
đều bị Access Denied / trả về cây control rỗng khi chạy khác quyền nhau). Hàm _check_process_access
bên dưới phát hiện đúng tình huống này và báo hướng dẫn cụ thể.

Nếu NB-Designer đổi tên control ở bản khác (khác version), dùng inspect_textlib.py (đi kèm) để dò
lại tên/class control mới, rồi sửa các chuỗi title="..." bên dưới cho khớp.

STDOUT: script chỉ in ĐÚNG 1 dòng JSON duy nhất ở cuối cùng (kết quả), mọi log tiến trình khác in
ra STDERR để không làm hỏng việc parse JSON phía Electron (main.js).
"""

import sys
import time
import os
import json
import subprocess
import ctypes
from ctypes import wintypes
from pywinauto import Application, Desktop

# Console Windows mặc định dùng bảng mã cp1252, không in được tiếng Việt có dấu -> ép stdout/stderr
# sang UTF-8 (kèm errors='replace' để không bao giờ crash chỉ vì in log).
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def log(msg):
    """In log tiến trình ra STDERR (KHÔNG ra stdout, để stdout chỉ chứa đúng 1 dòng JSON cuối)."""
    print(msg, file=sys.stderr, flush=True)


class AutomationError(Exception):
    """Lỗi có mã (code) rõ ràng để main.js phân loại, kèm message tiếng Việt để hiển thị cho người dùng."""
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# --- CẤU HÌNH KẾT NỐI ---
# Dò cửa sổ theo TIÊU ĐỀ (title) rất dễ bị nhầm (ví dụ trúng 1 tab trình duyệt có chữ trùng tên).
# Cách chắc chắn 100% là kết nối theo tên tiến trình .exe thật của NB-Designer.
NB_DESIGNER_EXE = os.environ.get("NB_DESIGNER_EXE", "NB-Designer.exe")

_BROWSER_CLASS_BLOCKLIST = (
    "Chrome_WidgetWin",        # Chrome, Edge (Chromium), Brave, Cốc Cốc, ...
    "MozillaWindowClass",      # Firefox
    "ApplicationFrameWindow",  # Một số app UWP / Edge cũ
)

_EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


def _find_pids_by_exe(exe_name):
    """Tìm TẤT CẢ PID có tên file .exe khớp, bằng lệnh 'tasklist' có sẵn trên Windows (thay vì
    Application.connect(path=...) của pywinauto, vì tham số path= dựa vào WMI nội bộ, thực tế hay
    báo "Process not found" dù tiến trình đang chạy thật - đặc biệt với app 32-bit như NB-Designer
    chạy trên Windows 64-bit)."""
    pids = []
    try:
        result = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {exe_name}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return pids

    for line in result.stdout.strip().splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == exe_name.lower():
            try:
                pids.append(int(parts[1]))
            except ValueError:
                continue
    return pids


def _check_process_access(pid):
    """Kiểm tra có mở được handle tới tiến trình PID này không.
    Trả về (True, None) nếu OK, hoặc (False, mã_lỗi_windows) nếu bị từ chối truy cập."""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if handle:
        ctypes.windll.kernel32.CloseHandle(handle)
        return True, None
    return False, ctypes.windll.kernel32.GetLastError()


def _pid_of_hwnd(hwnd):
    pid = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def _enum_visible_windows_for_pid(pid, class_filter=None):
    """Liệt kê mọi cửa sổ TOP-LEVEL đang hiển thị của đúng PID này, bằng EnumWindows trực tiếp
    (không qua pywinauto) - cách này đã kiểm chứng nhanh và chính xác hơn Desktop().windows(...)
    khi cần dò các dialog phụ (Text Library, Import Project Database, message box...)."""
    results = []

    def _cb(hwnd, _lparam):
        if _pid_of_hwnd(hwnd) == pid and ctypes.windll.user32.IsWindowVisible(hwnd):
            cls = ctypes.create_unicode_buffer(256)
            ctypes.windll.user32.GetClassNameW(hwnd, cls, 256)
            if class_filter is None or cls.value == class_filter:
                results.append(hwnd)
        return True

    ctypes.windll.user32.EnumWindows(_EnumWindowsProc(_cb), 0)
    return results


def _find_main_window_by_title():
    """Dò cửa sổ chính theo tiêu đề chứa 'NB-Designer', loại trừ cửa sổ trình duyệt (fallback khi
    không biết PID / không dùng NB_DESIGNER_EXE)."""
    candidates = Desktop(backend="win32").windows(title_re=".*NB-Designer.*", visible_only=True)
    if not candidates:
        raise AutomationError(
            "MAIN_WINDOW_NOT_FOUND",
            "Không tìm thấy cửa sổ nào có tiêu đề chứa 'NB-Designer' đang mở."
        )

    real_candidates = [
        w for w in candidates
        if not any(cls in (w.element_info.class_name or "") for cls in _BROWSER_CLASS_BLOCKLIST)
    ]
    if not real_candidates:
        raise AutomationError(
            "MAIN_WINDOW_NOT_FOUND",
            "Chỉ tìm thấy cửa sổ trình duyệt/app khác trùng chữ 'NB-Designer' trong tiêu đề, "
            "không phải cửa sổ NB-Designer thật. Hãy điền tên file .exe vào biến NB_DESIGNER_EXE."
        )

    real_candidates.sort(key=lambda w: w.rectangle().width() * w.rectangle().height(), reverse=True)
    chosen = real_candidates[0]
    log(f"Đang dùng cửa sổ: \"{chosen.window_text()}\" (class: {chosen.element_info.class_name})")
    return chosen


def _connect_main_window():
    """Kết nối tới cửa sổ chính NB-Designer đang chạy. Trả về (pid, window_specification)."""
    if NB_DESIGNER_EXE:
        pids = _find_pids_by_exe(NB_DESIGNER_EXE)
        if not pids:
            raise AutomationError(
                "PROCESS_NOT_FOUND",
                f'Không tìm thấy tiến trình đang chạy tên "{NB_DESIGNER_EXE}". '
                f'Hãy chắc chắn NB-Designer đang mở, hoặc kiểm tra lại tên .exe trong Task Manager '
                f'(tab Chi tiết/Details) rồi sửa lại biến NB_DESIGNER_EXE ở đầu script.'
            )

        access_denied_pids = []
        no_window_pids = []
        chosen_pid = None
        chosen_hwnd = None
        chosen_area = -1

        for pid in pids:
            ok, err_code = _check_process_access(pid)
            if not ok:
                if err_code == 5:  # ERROR_ACCESS_DENIED
                    access_denied_pids.append(pid)
                continue

            hwnds = _enum_windows_for_pid(pid)
            candidates = [
                item for item in hwnds
                if (
                    item["class_name"] != "#32770"
                    and item["title"].strip()
                    and item["area"] > 0
                )
            ]
            if not candidates:
                no_window_pids.append(pid)
                continue

            for item in candidates:
                if item["area"] > chosen_area:
                    chosen_area = item["area"]
                    chosen_hwnd = item["hwnd"]
                    chosen_pid = pid

        if chosen_hwnd is None:
            if access_denied_pids and not no_window_pids:
                raise AutomationError(
                    "ACCESS_DENIED",
                    f'Tìm thấy tiến trình "{NB_DESIGNER_EXE}" (PID={access_denied_pids}) nhưng KHÔNG '
                    f'truy cập được (Access Denied). Nguyên nhân gần như chắc chắn: NB-Designer đang '
                    f'chạy với quyền Administrator, còn chương trình xuất/import này thì không cùng '
                    f'mức quyền.\n=> Cách khắc phục: đóng NB-Designer và app này lại, sau đó mở CẢ HAI '
                    f'bằng "Run as administrator", rồi thử lại.'
                )
            raise AutomationError(
                "NO_VISIBLE_WINDOW",
                f'Tìm thấy {len(pids)} tiến trình tên "{NB_DESIGNER_EXE}" (PID={pids}) nhưng không '
                f'tiến trình nào có cửa sổ đang hiển thị. Hãy chắc chắn cửa sổ chính của NB-Designer '
                f'đang mở và không bị thu nhỏ, rồi thử lại.'
            )

        log(f"Đang dùng cửa sổ PID={chosen_pid}, hwnd={chosen_hwnd}")
        app = Application(backend="win32").connect(handle=chosen_hwnd)
        win = app.window(handle=chosen_hwnd)
        return chosen_pid, win
    else:
        chosen = _find_main_window_by_title()
        pid = _pid_of_hwnd(chosen.handle)
        app = Application(backend="win32").connect(handle=chosen.handle)
        win = app.window(handle=chosen.handle)
        return pid, win


def _window_belongs_to_pid(hwnd, pid):
    return bool(hwnd) and ctypes.windll.user32.IsWindow(hwnd) and _pid_of_hwnd(hwnd) == pid


def _force_set_foreground(hwnd):
    """Đưa hwnd lên foreground kể cả khi bị Windows "foreground lock" chặn.

    Windows mặc định KHÔNG cho một tiến trình nền (không vừa nhận input từ người
    dùng) tự ý cướp foreground bằng SetForegroundWindow() thẳng - lời gọi âm thầm
    thất bại (chỉ nháy icon taskbar). Đây là nguyên nhân thật sự khiến helper
    tưởng đã đưa NB-Designer lên trước nhưng thực ra cửa sổ vẫn ở dưới/mất focus.
    Dùng kỹ thuật chuẩn: gắn tạm input queue của luồng đang giữ foreground (và của
    luồng sở hữu hwnd) vào luồng hiện tại để được Windows cho phép đổi foreground,
    rồi gỡ ra ngay sau đó.
    """
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    foreground_hwnd = user32.GetForegroundWindow()
    if foreground_hwnd == hwnd:
        return bool(user32.SetForegroundWindow(hwnd))

    current_thread_id = kernel32.GetCurrentThreadId()
    target_thread_id = user32.GetWindowThreadProcessId(hwnd, None)
    foreground_thread_id = (
        user32.GetWindowThreadProcessId(foreground_hwnd, None) if foreground_hwnd else 0
    )

    attached_fg = False
    attached_target = False
    try:
        if foreground_thread_id and foreground_thread_id != current_thread_id:
            attached_fg = bool(
                user32.AttachThreadInput(current_thread_id, foreground_thread_id, True)
            )
        if target_thread_id and target_thread_id != current_thread_id:
            attached_target = bool(
                user32.AttachThreadInput(current_thread_id, target_thread_id, True)
            )

        user32.BringWindowToTop(hwnd)
        result = bool(user32.SetForegroundWindow(hwnd))
    finally:
        if attached_fg:
            user32.AttachThreadInput(current_thread_id, foreground_thread_id, False)
        if attached_target:
            user32.AttachThreadInput(current_thread_id, target_thread_id, False)

    return result


def _enum_windows_for_pid(pid):
    """Liệt kê mọi cửa sổ top-level của PID, kể cả cửa sổ đang bị ẩn/minimize."""
    results = []

    def _cb(hwnd, _lparam):
        if _pid_of_hwnd(hwnd) != pid:
            return True
        rect = wintypes.RECT()
        ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
        cls = ctypes.create_unicode_buffer(256)
        ctypes.windll.user32.GetClassNameW(hwnd, cls, 256)
        title_len = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(title_len + 1)
        ctypes.windll.user32.GetWindowTextW(hwnd, title, title_len + 1)
        area = max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top)
        results.append({
            "hwnd": hwnd,
            "visible": bool(ctypes.windll.user32.IsWindowVisible(hwnd)),
            "minimized": bool(ctypes.windll.user32.IsIconic(hwnd)),
            "class_name": cls.value,
            "title": title.value,
            "area": area,
        })
        return True

    ctypes.windll.user32.EnumWindows(_EnumWindowsProc(_cb), 0)
    return results


def _find_restoreable_main_hwnd(pid, preferred_hwnd=None):
    if _window_belongs_to_pid(preferred_hwnd, pid):
        return preferred_hwnd

    candidates = [
        item for item in _enum_windows_for_pid(pid)
        if (
            item["class_name"] != "#32770"
            and item["title"].strip()
            and item["area"] > 0
        )
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda item: item["area"], reverse=True)
    return candidates[0]["hwnd"]


def _restore_main_window(pid, preferred_hwnd=None, retries=4):
    """Khôi phục cửa sổ chính về trạng thái hiển thị mà không minimize/đóng nó."""
    SW_RESTORE = 9
    SW_SHOW = 5
    hwnd = _find_restoreable_main_hwnd(pid, preferred_hwnd)
    if not hwnd:
        return None

    user32 = ctypes.windll.user32
    for _ in range(retries):
        try:
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, SW_RESTORE)
            elif not user32.IsWindowVisible(hwnd):
                user32.ShowWindow(hwnd, SW_SHOW)
            _force_set_foreground(hwnd)
            if user32.IsIconic(hwnd):
                # SetForegroundWindow đôi khi tự restore cửa sổ, nhưng nếu vẫn còn
                # minimize thì gọi lại SW_RESTORE một lần nữa cho chắc.
                user32.ShowWindow(hwnd, SW_RESTORE)
        except Exception:
            pass

        # LƯU Ý QUAN TRỌNG: IsWindowVisible() vẫn trả về True cho cửa sổ đang bị
        # minimize (nó chỉ kiểm tra style WS_VISIBLE, không quan tâm trạng thái
        # iconic) - đây chính là lỗi khiến bản trước tưởng đã khôi phục xong nhưng
        # NB-Designer trên thực tế vẫn đang minimize/mất hình. Phải kiểm tra thêm
        # "not IsIconic()" mới coi là khôi phục thành công.
        if user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
            return hwnd
        time.sleep(0.15)
    return None


def _force_foreground(hwnd, pid=None):
    """Đưa cửa sổ lên foreground, luôn restore nếu đang minimized/ẩn."""
    if pid is None:
        pid = _pid_of_hwnd(hwnd)
    return _restore_main_window(pid, hwnd)


def _open_text_library_via_keys(hwnd, pid):
    """Gửi tổ hợp phím tắt Alt+O -> T để mở Text Library.

    NB-Designer dùng toolbar/ribbon tự vẽ (GetMenu() trả về NULL - không có menu bar
    cổ điển), nên KHÔNG thể dò command ID qua HMENU/WM_COMMAND như ứng dụng MFC thường.
    Vì vậy vẫn phải gửi phím tắt, nhưng chỉ gửi khi đã xác nhận chắc chắn cửa sổ chính
    đang là cửa sổ foreground thật sự (GetForegroundWindow() == hwnd) ngay trước mỗi
    phím, để không bao giờ gửi phím mù vào cửa sổ khác nếu focus bị đổi bất ngờ.
    """
    user32 = ctypes.windll.user32

    def _assert_foreground():
        if not _window_belongs_to_pid(hwnd, pid) or not user32.IsWindowVisible(hwnd):
            raise AutomationError(
                "MAIN_WINDOW_NOT_VISIBLE",
                f'Cửa sổ chính NB-Designer (PID={pid}) không còn hiển thị trước khi mở Text Library.'
            )
        if user32.GetForegroundWindow() != hwnd:
            raise AutomationError(
                "MAIN_WINDOW_NOT_FOREGROUND",
                f'Cửa sổ chính NB-Designer (PID={pid}) không ở foreground, dừng lại để tránh '
                'gửi phím tắt mù vào cửa sổ khác. Hãy để yên NB-Designer rồi thử lại.'
            )

    from pywinauto.keyboard import send_keys

    _assert_foreground()
    send_keys('%o', pause=0.05)
    time.sleep(0.2)
    _assert_foreground()
    send_keys('t', pause=0.05)
    log('Đã gửi phím tắt Alt+O, T để mở Text Library.')




def _wait_for_dialog(pid, title, timeout=8.0, poll=0.2):
    """Chờ tới khi xuất hiện 1 cửa sổ #32770 hiển thị, đúng PID, đúng title, tối đa `timeout` giây.
    Trả về hwnd nếu thấy, None nếu hết giờ - KHÔNG đoán bừa, để nơi gọi tự quyết định báo lỗi."""
    end = time.time() + timeout
    while time.time() < end:
        for hwnd in _enum_visible_windows_for_pid(pid, class_filter="#32770"):
            buf = ctypes.create_unicode_buffer(256)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, 256)
            if buf.value == title:
                return hwnd
        time.sleep(poll)
    return None


def _wait_until_gone(hwnd, timeout=8.0, poll=0.2):
    """Chờ tới khi hwnd không còn tồn tại/hiển thị nữa (dialog đã đóng)."""
    end = time.time() + timeout
    while time.time() < end:
        if not ctypes.windll.user32.IsWindow(hwnd) or not ctypes.windll.user32.IsWindowVisible(hwnd):
            return True
        time.sleep(poll)
    return False


def _find_generic_file_dialog(pid, exclude_hwnds, timeout=6.0, poll=0.2):
    """Fallback khi tên dialog "Import Project Database" không khớp (ví dụ bản NB-Designer khác đặt
    tên khác): tìm bất kỳ dialog #32770 mới xuất hiện của đúng PID, có cả ô Edit lẫn nút "&Open"."""
    end = time.time() + timeout
    while time.time() < end:
        for hwnd in _enum_visible_windows_for_pid(pid, class_filter="#32770"):
            if hwnd in exclude_hwnds:
                continue
            try:
                app = Application(backend="win32").connect(handle=hwnd)
                dlg = app.window(handle=hwnd)
                has_edit = dlg.child_window(class_name="Edit").exists()
                has_open = (
                    dlg.child_window(title="&Open", class_name="Button").exists()
                    or dlg.child_window(best_match="Open", class_name="Button").exists()
                )
                if has_edit and has_open:
                    return hwnd
            except Exception:
                continue
        time.sleep(poll)
    return None


def _dismiss_unexpected_dialogs(pid, known_hwnds, timeout=2.5, poll=0.2):
    """Sau khi bấm Open, NB-Designer có thể hiện thêm message box. Đã kiểm chứng trên máy thật 2
    dạng: (1) thông báo xong việc, chỉ có nút "OK"; (2) hỏi xác nhận khi TRÙNG TÊN với mục đã có
    sẵn trong Text Library - "The same item exists in text library. Do you replace it?" (nút
    "&Yes"/"&No"). Với dạng (2), chủ động bấm "&Yes" (ghi đè) thay vì bấm đại nút đầu tiên tìm
    thấy: mục đích chính của app là chỉnh sửa bản dịch rồi Import lại để CẬP NHẬT dữ liệu đã có,
    nếu lỡ bấm "&No" thì mọi chỉnh sửa sau lần import đầu sẽ không bao giờ được áp dụng.
    Trả về (text tĩnh đọc được, hành động đã bấm: "OK"|"YES"|"OTHER"|None)."""
    end = time.time() + timeout
    while time.time() < end:
        for hwnd in _enum_visible_windows_for_pid(pid, class_filter="#32770"):
            if hwnd in known_hwnds:
                continue
            text_parts = []
            action = None
            try:
                app = Application(backend="win32").connect(handle=hwnd)
                dlg = app.window(handle=hwnd)
                for child in dlg.descendants(class_name="Static"):
                    t = child.window_text()
                    if t:
                        text_parts.append(t)
                dlg.set_focus()
                ok_btn = dlg.child_window(title="OK", class_name="Button")
                yes_btn = dlg.child_window(title="&Yes", class_name="Button")
                if ok_btn.exists():
                    ok_btn.click_input()
                    action = "OK"
                elif yes_btn.exists():
                    yes_btn.click_input()
                    action = "YES"
                else:
                    any_btn = dlg.child_window(class_name="Button")
                    if any_btn.exists():
                        any_btn.click_input()
                        action = "OTHER"
            except Exception:
                pass
            return " ".join(text_parts), action
        time.sleep(poll)
    return "", None


def import_to_nb_designer(csv_path):
    abs_path = os.path.abspath(csv_path)
    if not os.path.isfile(abs_path):
        raise AutomationError("CSV_NOT_FOUND", f"Không tìm thấy file CSV: {abs_path}")

    pid, main_win = _connect_main_window()
    main_hwnd = main_win.handle
    result = None
    try:
        restored_hwnd = _force_foreground(main_hwnd, pid)
        if not restored_hwnd:
            raise AutomationError(
                "MAIN_WINDOW_NOT_VISIBLE",
                f'Không thể khôi phục cửa sổ chính NB-Designer (PID={pid}, HWND={main_hwnd}). '
                'Hãy đưa NB-Designer lên màn hình rồi thử lại.'
            )
        main_hwnd = restored_hwnd
        time.sleep(0.3)

        # 1. Mở Text Library nếu chưa mở sẵn.
        text_lib_hwnd = None
        for hwnd in _enum_visible_windows_for_pid(pid, class_filter="#32770"):
            buf = ctypes.create_unicode_buffer(256)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, 256)
            if buf.value == "Text Library":
                text_lib_hwnd = hwnd
                break

        if text_lib_hwnd is None:
            if not _force_foreground(main_hwnd, pid):
                raise AutomationError(
                    "MAIN_WINDOW_NOT_VISIBLE",
                    f'Cửa sổ chính NB-Designer (PID={pid}) không còn hiển thị trước khi mở Text Library.'
                )
            log('Chưa thấy Text Library đang mở, gửi phím tắt mở Text Library...')
            _open_text_library_via_keys(main_hwnd, pid)
            text_lib_hwnd = _wait_for_dialog(pid, "Text Library", timeout=8.0)
            if text_lib_hwnd is None:
                raise AutomationError(
                    "TEXT_LIBRARY_NOT_FOUND",
                    'Đã gọi menu mở Text Library nhưng không thấy dialog "Text Library" xuất hiện sau 8 giây. '
                    'Có thể NB-Designer chưa mở project hoặc đang bận dialog khác. Hãy tự mở Text Library '
                    'thủ công rồi thử lại.'
                )
        else:
            log('Text Library đã đang mở sẵn, dùng luôn.')

        app = Application(backend="win32").connect(handle=text_lib_hwnd)
        text_lib = app.window(handle=text_lib_hwnd)

        # 2. Đọc số dòng hiện có trong ListView "List1" trước khi import (để đối chiếu sau).
        before_count = None
        try:
            list1 = text_lib.child_window(class_name="SysListView32")
            if list1.exists():
                before_count = list1.item_count()
        except Exception as e:
            log(f'Không đọc được số dòng hiện có trong List1 (bỏ qua, không nghiêm trọng): {e}')

        # 3. Tìm và bấm nút "Import".
        import_btn = text_lib.child_window(title="Import", class_name="Button")
        if not import_btn.exists():
            raise AutomationError(
                "IMPORT_BUTTON_NOT_FOUND",
                'Đã mở được dialog "Text Library" nhưng không tìm thấy nút "Import" bên trong. '
                'Có thể phiên bản NB-Designer này đặt tên nút khác. Hãy chạy inspect_textlib.py để dò '
                'lại tên control chính xác.'
            )
        text_lib.set_focus()
        import_btn.click_input()
        log('Đã bấm nút Import.')

        # 4. Chờ dialog chọn file xuất hiện.
        file_dlg_hwnd = _wait_for_dialog(pid, "Import Project Database", timeout=6.0)
        if file_dlg_hwnd is None:
            file_dlg_hwnd = _find_generic_file_dialog(pid, exclude_hwnds={text_lib_hwnd}, timeout=3.0)
        if file_dlg_hwnd is None:
            raise AutomationError(
                "FILE_DIALOG_NOT_FOUND",
                'Đã bấm Import nhưng không thấy hộp thoại chọn file xuất hiện sau khi chờ. Có thể '
                'NB-Designer phiên bản này đặt tên dialog khác - hãy chạy inspect_textlib.py để kiểm tra.'
            )

        file_app = Application(backend="win32").connect(handle=file_dlg_hwnd)
        file_dlg = file_app.window(handle=file_dlg_hwnd)

        # 5. Điền đường dẫn file vào ô Edit.
        edit_ctrl = file_dlg.child_window(class_name="Edit")
        if not edit_ctrl.exists():
            raise AutomationError(
                "EDIT_CONTROL_NOT_FOUND",
                'Tìm thấy hộp thoại chọn file nhưng không thấy ô nhập tên file (Edit) bên trong.'
            )
        edit_ctrl.set_edit_text(abs_path)
        log(f'Đã điền đường dẫn: {abs_path}')

        # 6. Bấm nút "&Open" (hoặc "Open" tuỳ bản Windows/ngôn ngữ).
        open_btn = file_dlg.child_window(title="&Open", class_name="Button")
        if not open_btn.exists():
            open_btn = file_dlg.child_window(best_match="Open", class_name="Button")
        if not open_btn.exists():
            raise AutomationError(
                "OPEN_BUTTON_NOT_FOUND",
                'Đã điền đường dẫn file nhưng không tìm thấy nút "Open" trong hộp thoại.'
            )
        known_hwnds = {text_lib_hwnd, file_dlg_hwnd}
        file_dlg.set_focus()
        open_btn.click_input()
        log('Đã bấm Open.')

        # 7. Chờ hộp thoại chọn file đóng lại.
        if not _wait_until_gone(file_dlg_hwnd, timeout=8.0):
            raise AutomationError(
                "FILE_DIALOG_DID_NOT_CLOSE",
                'Đã bấm Open nhưng hộp thoại chọn file không đóng lại sau 8 giây. Có thể NB-Designer '
                'đang báo lỗi (sai định dạng file?) - hãy kiểm tra màn hình NB-Designer.'
            )

        # 8. Đọc và xử lý message box sau import.
        extra_dialog_text, extra_dialog_action = _dismiss_unexpected_dialogs(pid, known_hwnds, timeout=2.5)
        if extra_dialog_text:
            log(f'NB-Designer hiện thêm thông báo: {extra_dialog_text}')

        # 9. Đối chiếu số dòng trong List1 trước/sau.
        after_count = None
        delta = None
        try:
            list1 = text_lib.child_window(class_name="SysListView32")
            end = time.time() + 5.0
            while time.time() < end:
                if list1.exists():
                    after_count = list1.item_count()
                    if before_count is not None and after_count != before_count:
                        break
                time.sleep(0.25)
            if before_count is not None and after_count is not None:
                delta = after_count - before_count
        except Exception as e:
            log(f'Không đối chiếu được số dòng sau import (bỏ qua, không nghiêm trọng): {e}')

        # 10. Bấm OK trên Text Library để đóng dialog.
        closed = False
        try:
            ok_btn = text_lib.child_window(title="OK", class_name="Button")
            if ok_btn.exists():
                text_lib.set_focus()
                ok_btn.click_input()
                closed = _wait_until_gone(text_lib_hwnd, timeout=6.0)
        except Exception as e:
            log(f'Không bấm được OK để đóng Text Library (không nghiêm trọng): {e}')

        if delta is not None and delta > 0:
            message = f'Đã tự động Import vào NB-Designer thành công! (Thêm {delta} dòng mới trong Text Library)'
        elif delta == 0 and extra_dialog_action == "YES":
            message = (
                'Đã tự động Import vào NB-Designer thành công! Do trùng tên với (các) mục đã có sẵn '
                'trong Text Library, NB-Designer đã CẬP NHẬT (ghi đè) nội dung mục đó thay vì thêm '
                'dòng mới - đây là hành vi bình thường khi Import lại dữ liệu đã chỉnh sửa.'
            )
        elif delta == 0:
            message = (
                'Đã gửi lệnh Import và hộp thoại chọn file đã đóng bình thường, nhưng số dòng trong '
                'Text Library không đổi. Hãy kiểm tra lại trong NB-Designer xem dữ liệu đã vào chưa '
                '(có thể do trùng dữ liệu, hoặc do định dạng file).'
            )
        else:
            message = (
                'Đã gửi lệnh Import và hộp thoại chọn file đã đóng bình thường, nhưng không xác minh '
                'được số dòng trong Text Library (không nghiêm trọng). Hãy kiểm tra lại trong NB-Designer.'
            )
        if extra_dialog_text and extra_dialog_action != "YES":
            message += f'\nNB-Designer báo thêm: {extra_dialog_text}'
        if not closed:
            message += '\n(Lưu ý: dialog Text Library có thể vẫn đang mở, hãy kiểm tra và đóng lại nếu cần.)'

        result = {
            "success": True,
            "code": "OK",
            "message": message,
            "beforeCount": before_count,
            "afterCount": after_count,
            "importedDelta": delta,
        }
        return result
    finally:
        restored_hwnd = _restore_main_window(pid, main_hwnd)
        if restored_hwnd is None:
            log(f'Cảnh báo: không thể khôi phục cửa sổ chính NB-Designer PID={pid}, HWND={main_hwnd}.')
            if isinstance(result, dict):
                result["code"] = "MAIN_WINDOW_NOT_VISIBLE"
                result["success"] = False
                result["message"] = (
                    'Import đã chạy nhưng không thể xác nhận/khôi phục cửa sổ chính NB-Designer. '
                    'Hãy kiểm tra cửa sổ NB-Designer trước khi thao tác tiếp.'
                )
            elif sys.exc_info()[0] is None:
                raise AutomationError(
                    "MAIN_WINDOW_NOT_VISIBLE",
                    f'Không thể khôi phục cửa sổ chính NB-Designer (PID={pid}).'
                )
            else:
                log('Giữ nguyên lỗi gốc để không che mất nguyên nhân import.')
        elif not ctypes.windll.user32.IsWindowVisible(restored_hwnd):
            log(f'Cảnh báo: HWND={restored_hwnd} vẫn không visible sau khi khôi phục.')


if __name__ == '__main__':
    if len(sys.argv) <= 1:
        print(json.dumps({
            "success": False,
            "code": "MISSING_ARG",
            "message": "Thiếu đường dẫn file CSV! Cách dùng: python auto_import.py <duong_dan_file.csv>",
        }, ensure_ascii=False))
        sys.exit(1)

    try:
        result = import_to_nb_designer(sys.argv[1])
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0)
    except AutomationError as e:
        log(f'Lỗi: {e.message}')
        print(json.dumps({"success": False, "code": e.code, "message": e.message}, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:
        log(f'Lỗi không xác định: {e}')
        print(json.dumps({
            "success": False,
            "code": "UNEXPECTED_ERROR",
            "message": f'Lỗi khi kết nối/thao tác NB-Designer: {str(e)}',
        }, ensure_ascii=False))
        sys.exit(1)
