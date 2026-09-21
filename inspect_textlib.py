"""
inspect_textlib.py
-------------------
Script hỗ trợ (không dùng để chạy sản xuất) - giúp bạn xem chính xác NB-Designer đặt tên
control (nút, ô nhập, dialog...) như thế nào, để chỉnh lại auto_import.py cho đúng nếu
phiên bản NB-Designer trên máy khác đặt tên khác.

Cách dùng:
  1. Mở NB-Designer, mở dialog "Text Library" ra sẵn.
  2. Chạy:  python inspect_textlib.py
  3. Đọc phần in ra: liệt kê mọi control (nút, ô nhập...) trong cửa sổ chính và trong dialog
     Text Library (nếu đang mở), kèm "title" và "class_name". Copy đúng "title" của nút Import,
     nút OK, v.v. vào auto_import.py nếu khác với giá trị hiện tại.

QUAN TRỌNG - đã xác nhận thực tế trên máy có NB-Designer:
  - Dùng backend="win32" (KHÔNG dùng "uia"): dialog Text Library là dialog MFC/Win32 cổ điển,
    UI Automation (uia) không đọc được cây control bên trong (chỉ thấy mỗi TitleBar), còn cây
    control của cửa sổ chính (canvas thiết kế) quá lớn khiến uia bị timeout.
  - Phải kết nối theo PID/exe (không dùng title_re) vì title cửa sổ chính là đường dẫn file
    project (.nbp) đang mở, không chứa chữ "NB-Designer".
  - NB-Designer có thể chạy bằng quyền Administrator. Script này PHẢI chạy CÙNG mức quyền
    (mở Command Prompt/Terminal bằng "Run as administrator"), nếu không sẽ bị lỗi
    "Access is denied" khi đọc control.
"""

import sys
import ctypes
from ctypes import wintypes
from pywinauto import Application

# Console Windows mặc định dùng bảng mã cp1252, không in được tiếng Việt có dấu -> ép stdout/stderr
# sang UTF-8 (kèm errors='replace' để không bao giờ crash chỉ vì in log).
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

NB_DESIGNER_EXE = "NB-Designer.exe"

_EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


def _pid_of_hwnd(hwnd):
    pid = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def _find_pid_by_exe(exe_name):
    import subprocess
    result = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {exe_name}", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, timeout=5,
    )
    for line in result.stdout.strip().splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == exe_name.lower():
            return int(parts[1])
    return None


def _enum_visible_windows_for_pid(pid):
    results = []

    def _cb(hwnd, _lparam):
        if _pid_of_hwnd(hwnd) == pid and ctypes.windll.user32.IsWindowVisible(hwnd):
            length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(length + 1)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
            cls = ctypes.create_unicode_buffer(256)
            ctypes.windll.user32.GetClassNameW(hwnd, cls, 256)
            results.append((hwnd, buf.value, cls.value))
        return True

    ctypes.windll.user32.EnumWindows(_EnumWindowsProc(_cb), 0)
    return results


def main():
    pid = _find_pid_by_exe(NB_DESIGNER_EXE)
    if pid is None:
        print(f'Không tìm thấy tiến trình "{NB_DESIGNER_EXE}" đang chạy.')
        print('Hãy mở NB-Designer lên rồi chạy lại script này.')
        sys.exit(1)

    print(f'Đã tìm thấy tiến trình PID={pid}.')
    windows = _enum_visible_windows_for_pid(pid)
    if not windows:
        print('Tiến trình đang chạy nhưng không có cửa sổ nào đang hiển thị.')
        sys.exit(1)

    print(f'\nCác cửa sổ đang hiển thị của tiến trình này ({len(windows)}):')
    for hwnd, title, cls in windows:
        print(f'  - hwnd={hwnd} class={cls!r} title={title!r}')

    # Ưu tiên in chi tiết cây control của dialog "Text Library" nếu đang mở, vì đây là mục tiêu
    # chính cần dò. Nếu không có, in cửa sổ lớn nhất (thường là cửa sổ chính) để tham khảo thêm.
    text_lib = next((w for w in windows if w[1] == 'Text Library'), None)
    target = text_lib

    if target is None:
        print('\nKhông thấy dialog "Text Library" đang mở. Hãy mở nó lên (Alt+O -> T trong '
              'NB-Designer) rồi chạy lại script này để dò đúng cây control cần thiết.')
        sys.exit(0)

    hwnd, title, cls = target
    print(f'\n=== CÂY CONTROL CỦA "{title}" (class={cls}) ===')
    try:
        app = Application(backend="win32").connect(handle=hwnd)
        win = app.window(handle=hwnd)
        win.print_control_identifiers(depth=8)
    except Exception as e:
        print(f'Lỗi khi đọc cây control: {e}')
        print('Nếu là lỗi "Access is denied": NB-Designer đang chạy quyền Administrator, hãy mở '
              'lại Command Prompt/Terminal bằng "Run as administrator" rồi chạy lại script này.')
        sys.exit(1)


if __name__ == '__main__':
    main()
