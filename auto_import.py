"""
auto_import.py
---------------
Script này giả lập thao tác người dùng để tự động Import file CSV Text Library
vào phần mềm NB-Designer, thay vì phải mở Text Library > Import > chọn file thủ công.

QUAN TRỌNG - cần đọc trước khi dùng:
Mình không có môi trường Windows + NB-Designer để chạy thử trực tiếp, nên các bước bên dưới
là suy luận từ ảnh chụp màn hình bạn gửi (cửa sổ chính NB-Designer và cửa sổ dialog "Text
Library"). Có 1 điểm CHƯA CHẮC CHẮN và bạn cần tự kiểm tra nếu script vẫn báo lỗi:

  1. Mở "Text Library": ĐÃ XÁC NHẬN trên máy thật là phím tắt Alt+O rồi T.
  2. Nút "Import" bên trong dialog Text Library: ĐÃ XÁC NHẬN trên máy thật là bấm Tab 5
     lần rồi Enter (khi dialog Text Library vừa hiện ra) sẽ vào đúng trang chọn file .csv
     để Import.

Toàn bộ chuỗi thao tác đúng: Alt+O -> T -> Tab -> Tab -> Tab -> Tab -> Tab -> Enter.

Cách kiểm tra/tinh chỉnh nếu script chạy không đúng:
  - Chạy file inspect_textlib.py (đi kèm) khi cửa sổ Text Library đang mở, nó sẽ in ra toàn bộ
    cây control (tên, class, control_type) để bạn biết chính xác tên nút/hộp thoại cần trỏ tới.
  - Sửa các chuỗi title_re / title bên dưới cho khớp với những gì inspect_textlib.py in ra.
"""

import sys
import time
import os
import subprocess
import ctypes
from pywinauto import Application, Desktop
from pywinauto.keyboard import send_keys

# Console Windows mặc định dùng bảng mã cp1252, không in được tiếng Việt có dấu -> ép stdout/stderr
# sang UTF-8 (kèm errors='replace' để không bao giờ crash chỉ vì in log).
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# --- KẾT NỐI CHÍNH XÁC THEO TIẾN TRÌNH (khuyên dùng) ---
# Dò cửa sổ theo TIÊU ĐỀ (title) rất dễ bị nhầm: ví dụ máy bạn vừa gặp lỗi vì script kết nối
# nhầm vào 1 tab Chrome có tiêu đề chứa chữ "NB-Designer" (do đang mở cuộc trò chuyện này!)
# thay vì phần mềm NB-Designer thật. Cách chắc chắn 100% là kết nối theo tên file .exe:
#   1. Mở NB-Designer lên, mở Task Manager (Ctrl+Shift+Esc) > tab "Details"/"Chi tiết".
#   2. Tìm dòng tiến trình của NB-Designer, xem cột "Name" (thường có dạng "NBDesigner.exe"
#      hoặc tương tự) và điền chính xác vào biến NB_DESIGNER_EXE bên dưới.
# Để trống ("") nếu muốn script tự dò theo tiêu đề cửa sổ (có loại trừ bớt trình duyệt, nhưng
# vẫn có rủi ro nhầm nếu có app khác trùng chữ "NB-Designer" trong tiêu đề).
NB_DESIGNER_EXE = os.environ.get("NB_DESIGNER_EXE", "NB-Designer.exe")

# Các class cửa sổ của trình duyệt phổ biến - loại trừ khỏi kết quả dò theo tiêu đề để tránh
# lặp lại đúng lỗi vừa gặp (kết nối nhầm vào tab trình duyệt).
_BROWSER_CLASS_BLOCKLIST = (
    "Chrome_WidgetWin",        # Chrome, Edge (Chromium), Brave, Cốc Cốc, ...
    "MozillaWindowClass",      # Firefox
    "ApplicationFrameWindow",  # Một số app UWP / Edge cũ
)


def _find_main_window_by_title():
    """Dò cửa sổ chính theo tiêu đề chứa 'NB-Designer', loại trừ cửa sổ trình duyệt."""
    candidates = Desktop(backend="uia").windows(title_re=".*NB-Designer.*", visible_only=True)
    if not candidates:
        raise RuntimeError("Không tìm thấy cửa sổ nào có tiêu đề chứa 'NB-Designer' đang mở.")

    real_candidates = [
        w for w in candidates
        if not any(cls in (w.element_info.class_name or "") for cls in _BROWSER_CLASS_BLOCKLIST)
    ]

    if not real_candidates:
        raise RuntimeError(
            "Chỉ tìm thấy cửa sổ trình duyệt/app khác trùng chữ 'NB-Designer' trong tiêu đề, "
            "không phải cửa sổ NB-Designer thật. Hãy điền tên file .exe vào biến NB_DESIGNER_EXE "
            "ở đầu script (xem hướng dẫn trong comment) để kết nối chính xác theo tiến trình."
        )

    # Nếu vẫn còn nhiều hơn 1 cửa sổ hợp lệ, chọn cửa sổ có diện tích lớn nhất (thường là cửa sổ
    # làm việc chính chứ không phải dialog phụ nhỏ hơn).
    real_candidates.sort(key=lambda w: w.rectangle().width() * w.rectangle().height(), reverse=True)
    chosen = real_candidates[0]
    print(f"Đang dùng cửa sổ: \"{chosen.window_text()}\" (class: {chosen.element_info.class_name})")
    return chosen


def _find_pids_by_exe(exe_name):
    """Tìm TẤT CẢ PID có tên file .exe khớp, bằng lệnh 'tasklist' có sẵn trên Windows (thay vì
    Application.connect(path=...) của pywinauto, vì tham số path= dựa vào WMI nội bộ, thực tế hay
    báo "Process not found" dù tiến trình đang chạy thật - đặc biệt với app 32-bit như NB-Designer
    chạy trên Windows 64-bit). Trả về danh sách vì có thể có nhiều hơn 1 tiến trình cùng tên (ví dụ
    1 tiến trình launcher/splash không có cửa sổ + 1 tiến trình cửa sổ chính thật)."""
    pids = []
    try:
        result = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {exe_name}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return pids

    for line in result.stdout.strip().splitlines():
        # Mỗi dòng CSV có dạng: "NB-Designer.exe","12345","Console","1","89,000 K"
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == exe_name.lower():
            try:
                pids.append(int(parts[1]))
            except ValueError:
                continue
    return pids


def _check_process_access(pid):
    """Kiểm tra có mở được handle tới tiến trình PID này không.
    Trả về (True, None) nếu OK, hoặc (False, mã_lỗi_windows) nếu bị từ chối truy cập.
    Dùng để phân biệt: PID thực sự không tồn tại (hiếm, vì tasklist vừa liệt kê được nó) với
    PID tồn tại thật nhưng bị ACCESS DENIED - trường hợp hay gặp khi NB-Designer chạy bằng quyền
    Administrator còn script này thì không cùng mức quyền."""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if handle:
        ctypes.windll.kernel32.CloseHandle(handle)
        return True, None
    return False, ctypes.windll.kernel32.GetLastError()


def _connect_main_window():
    """Kết nối tới cửa sổ chính NB-Designer đang chạy (dùng UIA để lấy được tên control)."""
    if NB_DESIGNER_EXE:
        pids = _find_pids_by_exe(NB_DESIGNER_EXE)
        if not pids:
            raise RuntimeError(
                f'Không tìm thấy tiến trình đang chạy tên "{NB_DESIGNER_EXE}". '
                f'Hãy chắc chắn NB-Designer đang mở, hoặc kiểm tra lại tên .exe trong Task Manager '
                f'(tab Chi tiết/Details) rồi sửa lại biến NB_DESIGNER_EXE ở đầu script.'
            )

        access_denied_pids = []
        no_window_pids = []
        chosen_window = None

        for pid in pids:
            ok, err_code = _check_process_access(pid)
            if not ok:
                if err_code == 5:  # ERROR_ACCESS_DENIED
                    access_denied_pids.append(pid)
                continue

            # Tiến trình này có cửa sổ đang hiển thị không? (tránh nhầm sang tiến trình launcher/
            # splash cùng tên nhưng không có giao diện)
            windows = Desktop(backend="uia").windows(process=pid, visible_only=True)
            if not windows:
                no_window_pids.append(pid)
                continue

            windows.sort(key=lambda w: w.rectangle().width() * w.rectangle().height(), reverse=True)
            candidate = windows[0]
            if chosen_window is None or (
                candidate.rectangle().width() * candidate.rectangle().height()
                > chosen_window.rectangle().width() * chosen_window.rectangle().height()
            ):
                chosen_window = candidate

        if chosen_window is None:
            if access_denied_pids and not no_window_pids:
                raise RuntimeError(
                    f'Tìm thấy tiến trình "{NB_DESIGNER_EXE}" (PID={access_denied_pids}) nhưng KHÔNG '
                    f'truy cập được (Access Denied). Nguyên nhân gần như chắc chắn: NB-Designer đang '
                    f'chạy với quyền Administrator, còn chương trình xuất/import này thì không cùng '
                    f'mức quyền.\n=> Cách khắc phục: đóng NB-Designer và app này lại, sau đó mở CẢ HAI '
                    f'bằng "Run as administrator" (chuột phải vào icon > Run as administrator), rồi thử lại.'
                )
            raise RuntimeError(
                f'Tìm thấy {len(pids)} tiến trình tên "{NB_DESIGNER_EXE}" (PID={pids}) nhưng không '
                f'tiến trình nào có cửa sổ đang hiển thị (có thể đang là màn hình chờ/splash, hoặc bị '
                f'thu nhỏ ẩn xuống khay hệ thống). Hãy chắc chắn cửa sổ chính của NB-Designer đang mở '
                f'và không bị thu nhỏ, rồi thử lại.'
            )

        print(f"Đang dùng cửa sổ: \"{chosen_window.window_text()}\" (PID trong danh sách: {pids})")
        app = Application(backend="uia").connect(handle=chosen_window.handle)
    else:
        chosen = _find_main_window_by_title()
        app = Application(backend="uia").connect(handle=chosen.handle)

    win = app.top_window()
    win.set_focus()
    time.sleep(0.5)
    return app, win


def _force_foreground(hwnd):
    """Ép cửa sổ hwnd lên foreground bằng Win32 API trực tiếp.

    Lý do cần hàm riêng: pywinauto's set_focus() đôi khi không hiệu quả (dialog/cửa sổ
    không tự "xin" OS focus), dẫn tới việc gửi phím (Alt+O, Tab, Enter...) đi vào
    "khoảng không" - không cửa sổ nào nhận, nên không có phản ứng gì và cuối cùng bị
    timeout vì cửa sổ mong đợi (Text Library, ...) không bao giờ xuất hiện."""
    SW_SHOW = 5
    try:
        ctypes.windll.user32.ShowWindow(hwnd, SW_SHOW)
    except Exception:
        pass
    try:
        ctypes.windll.user32.BringWindowToTop(hwnd)
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetForegroundWindow(hwnd)
    except Exception:
        pass


def _check_foreground(hwnd, label):
    """In log so sánh cửa sổ foreground hiện tại với hwnd mong đợi, để chẩn đoán nhanh
    khi gửi phím không có phản ứng gì trên màn hình."""
    fg_hwnd = ctypes.windll.user32.GetForegroundWindow()
    if fg_hwnd == hwnd:
        print(f'{label}: đang là foreground (handle={hwnd}) - OK, sẽ gửi phím.')
    else:
        print(f'{label}: CẢNH BÁO - cửa sổ foreground hiện tại là handle={fg_hwnd}, '
              f'KHÔNG PHẢI cửa sổ mong đợi (handle={hwnd}). Phím gửi đi có thể sẽ không '
              f'đến đúng chỗ. Vẫn thử gửi phím...')


def _open_text_library_and_click_import(main_win):
    """Mở Text Library rồi vào thẳng trang Import, theo đúng chuỗi phím đã xác nhận:

        Alt+O -> T -> (chờ ~2 giây, KHÔNG quan tâm cái gì hiện lên) -> Tab x5 -> Enter

    Không còn dò/kiểm tra cửa sổ Text Library, không ép foreground giữa chừng - chỉ gửi
    phím theo đúng trình tự và thời gian chờ cố định.
    """
    hwnd = main_win.handle
    _force_foreground(hwnd)
    time.sleep(0.3)

    send_keys('%o')
    time.sleep(0.3)
    send_keys('t')

    # Chờ cố định ~2 giây, không quan tâm cái gì hiện lên hay chưa.
    time.sleep(2.0)

    for _ in range(5):
        send_keys('{TAB}')
        time.sleep(0.15)

    send_keys('{ENTER}')
    print('Đã gửi Alt+O -> T -> (chờ 2s) -> Tab x5 -> Enter.')
    time.sleep(1.0)


def _submit_file_path(abs_path):
    """Điền đường dẫn file vào hộp thoại chọn file (Open) chuẩn của Windows rồi Enter."""
    try:
        open_dlg = Desktop(backend="uia").window(title_re="(Open|Import).*")
        open_dlg.wait('visible', timeout=5)
        open_dlg.set_focus()
    except Exception:
        # Nếu không bắt được cửa sổ theo tên, vẫn thử gõ thẳng vào control đang focus
        pass

    time.sleep(0.3)
    send_keys(abs_path, with_spaces=True)
    time.sleep(0.3)
    send_keys('{ENTER}')


def import_to_nb_designer(excel_path):
    abs_path = os.path.abspath(excel_path)

    if not os.path.isfile(abs_path):
        print(f"Không tìm thấy file: {abs_path}")
        sys.exit(1)

    try:
        app, main_win = _connect_main_window()
        _open_text_library_and_click_import(main_win)
        _submit_file_path(abs_path)

        print("Import thành công!")

    except Exception as e:
        print(f"Lỗi khi kết nối/thao tác NB-Designer: {str(e)}")
        sys.exit(1)


if __name__ == '__main__':
    if len(sys.argv) > 1:
        import_to_nb_designer(sys.argv[1])
    else:
        print("Thiếu đường dẫn file CSV! Cách dùng: python auto_import.py <duong_dan_file.csv>")