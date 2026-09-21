const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

let win;
let cachedPythonCmd = null;

// Tự dò lệnh Python khả dụng trên máy, thử lần lượt: py -3 (Python Launcher chính thức trên
// Windows), python, python3. Lý do: trên Windows 11, gõ "python" có thể trúng "App execution
// alias" giả (chỉ mở Microsoft Store, không chạy gì cả và không báo lỗi rõ ràng) nếu Python
// được cài qua python.org nhưng launcher "py" thường vẫn hoạt động đúng, hoặc ngược lại.
function findPythonCmd(callback) {
  if (cachedPythonCmd) return callback(cachedPythonCmd);

  const candidates = ['py -3', 'py', 'python', 'python3'];
  let i = 0;

  function tryNext() {
    if (i >= candidates.length) return callback(null);
    const cmd = candidates[i++];
    exec(`${cmd} --version`, { windowsHide: true }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      // Lệnh coi là hợp lệ nếu chạy không lỗi VÀ output thực sự chứa "Python" (loại trừ trường
      // hợp App execution alias giả trả về exit code 0 nhưng không in gì / in thông báo khác).
      if (!err && /python/i.test(out)) {
        cachedPythonCmd = cmd;
        return callback(cmd);
      }
      tryNext();
    });
  }

  tryNext();
}

function createWindow() {
  // Ẩn thanh menu mặc định của Electron
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width: 1050,
    height: 750,
    minWidth: 600,
    minHeight: 120,
    frame: false, // Ẩn khung/tiêu đề gốc của hệ điều hành - tự vẽ titlebar trong index.html
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('index.html');

  // Đồng bộ trạng thái phóng to/khôi phục để renderer đổi icon nút Maximize cho đúng
  win.on('maximize', () => win.webContents.send('window-state-changed', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window-state-changed', { maximized: false }));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 0. ĐIỀU KHIỂN CỬA SỔ TỰ VẼ (vì đã tắt frame gốc của hệ điều hành ở createWindow())
ipcMain.on('window-minimize', () => {
  if (win) win.minimize();
});

ipcMain.on('window-maximize-toggle', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on('window-close', () => {
  if (win) win.close();
});

// 1. Chế độ Thu nhỏ / Luôn nổi (Compact Mode)
ipcMain.on('toggle-compact-mode', (event, isCompact) => {
  if (!win) return;
  if (isCompact) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setSize(850, 140);
  } else {
    win.setAlwaysOnTop(false);
    win.setSize(1050, 750);
  }
});

// 2. XUẤT FILE CSV THỦ CÔNG (Hiển thị Dialog chọn đường dẫn)
ipcMain.on('export-excel', async (event, { rows, langCount }) => {
  try {
    const { filePath } = await dialog.showSaveDialog(win, {
      title: 'Lưu file CSV Text Library',
      defaultPath: 'TextLib.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });

    if (!filePath) return; // Người dùng bấm Hủy (Cancel)

    createNBTextLibCSV(filePath, rows, langCount);
    event.reply('export-success', 'Đã xuất file TextLib.csv chuẩn NB-Designer thành công!');

  } catch (err) {
    console.error('Lỗi Export CSV:', err);
    event.reply('export-error', 'Lỗi khi xuất file: ' + err.message);
  }
});

// 3. TỰ ĐỘNG IMPORT NGẦM VÀO NB-DESIGNER (Tạo file tạm -> Import -> Xóa file)
ipcMain.on('import-to-nb', async (event, { rows, langCount }) => {
  // QUAN TRỌNG: không dùng path.join(__dirname, ...) cho file TẠO MỚI/GHI ĐÈ, vì sau khi đóng
  // gói (.exe), __dirname trỏ vào bên trong app.asar - một file nén CHỈ ĐỌC, không phải thư mục
  // thật, nên fs.writeFileSync sẽ báo lỗi ENOENT ("not found in ...app.asar"). Dùng thư mục Temp
  // của hệ điều hành (luôn có quyền ghi, bất kể cài app ở đâu) để tạo file tạm an toàn hơn.
  const tempFilePath = path.join(os.tmpdir(), 'TextLib_temp.csv');

  try {
    // Tạo file CSV tạm chuẩn định dạng
    createNBTextLibCSV(tempFilePath, rows, langCount);

    // Lưu ý: scriptPath vẫn dùng __dirname là ĐÚNG (chỉ để ĐỌC, không ghi), NHƯNG chỉ hoạt động
    // được khi đã tắt asar (xem "build.asar": false trong package.json). Nếu bật asar,
    // auto_import.py sẽ nằm bên trong app.asar và Python (chương trình ngoài Electron) sẽ
    // KHÔNG đọc được file này, dù fs.existsSync() bên dưới vẫn trả về true (do Electron tự vá
    // fs để đọc được asar, nhưng exec() gọi Python thì không).
    const scriptPath = path.join(__dirname, 'auto_import.py');

    if (!fs.existsSync(scriptPath)) {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      event.reply('import-result', { success: false, message: 'Không tìm thấy kịch bản auto_import.py!' });
      return;
    }

    const cleanupTemp = () => {
      if (fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch (e) {}
      }
    };

    findPythonCmd((pythonCmd) => {
      if (!pythonCmd) {
        cleanupTemp();
        event.reply('import-result', {
          success: false,
          message:
            'Không tìm thấy Python trên máy (đã thử "py", "python", "python3").\n' +
            'Hãy mở Command Prompt và gõ "python --version" để kiểm tra:\n' +
            '- Nếu báo "không nhận dạng được lệnh" hoặc tự mở Microsoft Store: cần cài Python từ ' +
            'python.org và tick chọn "Add python.exe to PATH" lúc cài, hoặc tắt App execution ' +
            'alias của python.exe/python3.exe trong Settings > Apps > Advanced app settings.',
        });
        return;
      }

      // Chạy Python Script để tự động gửi phím tắt Import vào NB-Designer
      exec(`${pythonCmd} "${scriptPath}" "${tempFilePath}"`, { windowsHide: true }, (error, stdout, stderr) => {
        // Dọn dẹp/Tự động xóa file tạm ngay sau khi thực thi xong
        cleanupTemp();

        if (error) {
          // Gộp mọi nguồn thông tin có thể có để dễ chẩn đoán, tránh trường hợp chỉ hiện
          // "Command failed: ..." mà không rõ nguyên nhân thật sự.
          const details = [
            stderr && stderr.trim(),
            stdout && stdout.trim(),
            `Mã lỗi thoát: ${error.code}`,
            error.message,
          ].filter(Boolean).join('\n');

          event.reply('import-result', { success: false, message: 'Lỗi Import NB-Designer:\n' + details });
          return;
        }

        event.reply('import-result', { success: true, message: 'Đã tự động Import vào NB-Designer thành công!' });
      });
    });

  } catch (err) {
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
    event.reply('import-result', { success: false, message: 'Lỗi khởi tạo file: ' + err.message });
  }
});

// --- HÀM TẠO FILE CSV CHIA CỘT TAB-SEPARATED (UTF-16LE + BOM) ĐÚNG CHUẨN FILE MẪU NB-DESIGNER ---
// Đã đối chiếu byte-by-byte với file mẫu TextLib.csv do NB-Designer xuất ra. Lưu ý các điểm khác
// với bản gốc trước đây:
//   1) File mẫu có BOM UTF-16LE (FF FE) ở đầu file - fs.writeFileSync(..., 'utf16le') KHÔNG tự thêm BOM,
//      nên phải tự ghép byte BOM vào thủ công.
//   2) 3 dòng đầu ("Text Lib", "Name:", "Status:") có một tab THỪA ở cuối dòng trước khi xuống dòng.
//      Dòng "Language..." và các dòng dữ liệu (0, 1, 2...) thì KHÔNG có tab thừa này.
//   3) File mẫu gốc (chỉ có 1 item) không có dòng trống giữa các khối. Khi có từ 2 item trở lên,
//      theo yêu cầu thực tế, mỗi khối Name được ngăn cách bằng 1 dòng trống (không thêm trước
//      khối đầu tiên). Nếu NB-Designer báo lỗi import khi có dòng trống này, hãy bỏ đoạn
//      "if (itemIndex > 0) { lines.push(''); }" bên dưới.
// Người dùng có thể nhấn Enter trong ô Language để xuống dòng (textarea nhiều dòng). Nhưng file
// CSV của NB-Designer là định dạng theo DÒNG (mỗi dòng dữ liệu phải nằm trên đúng 1 dòng vật lý),
// nên nếu ghi thẳng ký tự xuống dòng thật vào sẽ làm lệch toàn bộ cấu trúc các dòng phía sau.
// => Đổi ký tự xuống dòng thật thành chuỗi 2 ký tự "\n" (giữ ý định xuống dòng của người dùng
// dưới dạng văn bản thường, không làm hỏng cấu trúc file).
function escapeMultilineForCSV(str) {
  return String(str || '').replace(/\r\n|\r|\n/g, '\\n');
}

function createNBTextLibCSV(filePath, rows, langCount) {
  let lines = [];

  // Dòng 1: Text Lib | V100 | (tab thừa)
  lines.push(['Text Lib', 'V100', ''].join('\t'));

  // Duyệt qua từng khối dữ liệu
  rows.forEach((item, itemIndex) => {
    // Thêm 1 dòng trống ngăn cách giữa các khối Name (không thêm trước khối đầu tiên)
    if (itemIndex > 0) {
      lines.push('');
    }

    // Dòng Name: | <Tên> | (tab thừa)
    lines.push(['Name:', item.name || '', ''].join('\t'));

    // Dòng Status: | <Số trạng thái> | (tab thừa)
    const statusNum = parseInt(item.status) || 1;
    lines.push(['Status:', statusNum, ''].join('\t'));

    // Dòng Header Language: Language | Language1 | Language2 ... (không có tab thừa)
    let langHeader = ['Language'];
    for (let l = 1; l <= langCount; l++) {
      langHeader.push(`Language${l}`);
    }
    lines.push(langHeader.join('\t'));

    // Các dòng dữ liệu trạng thái: Index (0, 1...) | Text Lang1 | Text Lang2 ...
    // Mỗi dòng trạng thái lấy đúng bộ ngôn ngữ riêng người dùng đã nhập ở dòng con tương ứng
    // trên giao diện (item.states[s]), không còn lặp lại 1 bộ chung cho mọi dòng.
    for (let s = 0; s < statusNum; s++) {
      const stateData = (item.states && item.states[s]) || {};
      let rowData = [s];
      for (let l = 1; l <= langCount; l++) {
        rowData.push(escapeMultilineForCSV(stateData[`lang${l}`]));
      }
      lines.push(rowData.join('\t'));
    }
  });

  // Ghép các dòng bằng CRLF, có CRLF ở cuối dòng cuối cùng (giống hệt file mẫu)
  const content = lines.join('\r\n') + '\r\n';

  // Ghi BOM (FF FE) + nội dung UTF-16LE
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(content, 'utf16le');
  fs.writeFileSync(filePath, Buffer.concat([bom, body]));
}