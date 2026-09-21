"""
inspect_textlib.py
-------------------
Script hỗ trợ (không dùng để chạy sản xuất) - giúp bạn xem chính xác NB-Designer đặt tên
menu/nút bấm/cửa sổ như thế nào, để chỉnh lại auto_import.py cho đúng.

Cách dùng:
  1. Mở NB-Designer, mở dialog "Text Library" ra sẵn (giống ảnh bạn gửi).
  2. Chạy:  python inspect_textlib.py
  3. Đọc phần in ra: nó liệt kê mọi control (nút, ô nhập, menu...) trong cửa sổ, kèm
     "title" và "control_type". Copy đúng "title" của nút Import, nút OK, v.v. vào
     auto_import.py nếu tên khác với "Import" mà bản hiện tại đang giả định.

Nếu bước 2 báo lỗi không kết nối được NB-Designer, thử đổi backend="uia" thành backend="win32"
bên dưới (một số app cũ lộ tên control tốt hơn qua win32).
"""

from pywinauto import Application

TARGET_TITLE_RE = ".*NB-Designer.*"


def main():
    app = Application(backend="uia").connect(title_re=TARGET_TITLE_RE)

    print("\n=== CỬA SỔ CHÍNH ===")
    app.top_window().print_control_identifiers(depth=3)

    print("\n=== TÌM CỬA SỔ 'Text Library' (nếu đang mở) ===")
    try:
        tl_win = app.window(title_re=".*Text Library.*")
        tl_win.wait('visible', timeout=3)
        tl_win.print_control_identifiers(depth=6)
    except Exception as e:
        print(f"Không tìm thấy cửa sổ Text Library đang mở: {e}")
        print("=> Hãy mở dialog Text Library lên trước rồi chạy lại script này.")


if __name__ == '__main__':
    main()
