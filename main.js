const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');

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
//
// auto_import.py/.exe giờ thao tác thẳng vào ĐÚNG control của NB-Designer (nút Import, ô nhập
// đường dẫn, nút Open...) đã dò được thật trên máy, có chờ/xác minh từng bước, thay vì gửi phím
// mù cố định như bản trước. Kết quả trả về DUY NHẤT 1 dòng JSON trên stdout (mọi log tiến trình
// khác đi ra stderr), nên phía Electron chỉ cần JSON.parse(stdout) là biết chắc thành công/thất
// bại và lấy đúng thông báo hiển thị cho người dùng.
//
// Dùng spawn() thay vì exec(): không qua shell nên không cần lo escape đường dẫn có dấu cách/ký
// tự đặc biệt, và tách rõ luồng stdout/stderr thay vì gộp chung.
function runImportHelper(command, args, tempFilePath, event) {
  const cleanupTemp = () => {
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
  };

  let child;
  try {
    child = spawn(command, args, { windowsHide: true });
  } catch (err) {
    cleanupTemp();
    event.reply('import-result', { success: false, message: 'Không chạy được chương trình Import: ' + err.message });
    return;
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('error', (err) => {
    cleanupTemp();
    event.reply('import-result', { success: false, message: 'Không chạy được chương trình Import: ' + err.message });
  });

  child.on('close', (code) => {
    // CHỈ xóa file tạm SAU KHI tiến trình con đã đóng - lúc này auto_import đã tự xác minh xong
    // dialog chọn file đã đóng (xem _wait_until_gone trong auto_import.py), nên không còn race
    // condition kiểu xóa file trước khi NB-Designer kịp đọc như bản cũ.
    cleanupTemp();

    let result = null;
    try {
      result = JSON.parse(stdout.trim());
    } catch (e) {
      // Không parse được JSON - script có thể đã crash trước khi in được kết quả. Gộp mọi log lại
      // để còn chẩn đoán được, thay vì chỉ báo chung chung "Command failed".
      const details = [
        stderr && stderr.trim(),
        stdout && stdout.trim(),
        `Mã thoát: ${code}`,
      ].filter(Boolean).join('\n');
      event.reply('import-result', { success: false, message: 'Lỗi Import NB-Designer (không đọc được kết quả):\n' + details });
      return;
    }

    event.reply('import-result', {
      success: !!result.success,
      message: result.message || (result.success ? 'Import thành công!' : 'Import thất bại.'),
    });
  });
}

ipcMain.on('import-to-nb', async (event, { rows, langCount }) => {
  // QUAN TRỌNG: không dùng path.join(__dirname, ...) cho file TẠO MỚI/GHI ĐÈ, vì sau khi đóng
  // gói (.exe), __dirname trỏ vào bên trong app.asar - một file nén CHỈ ĐỌC, không phải thư mục
  // thật, nên fs.writeFileSync sẽ báo lỗi ENOENT ("not found in ...app.asar"). Dùng thư mục Temp
  // của hệ điều hành (luôn có quyền ghi, bất kể cài app ở đâu) để tạo file tạm an toàn hơn.
  //
  // Tên file có timestamp + hậu tố ngẫu nhiên (thay vì tên cố định "TextLib_temp.csv") để 2 lần
  // bấm Import liên tiếp, hoặc 2 instance app chạy cùng lúc, không ghi đè/xóa nhầm file của nhau.
  const uniqueSuffix = `${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  const tempFilePath = path.join(os.tmpdir(), `NBTextLib_${uniqueSuffix}.csv`);

  try {
    // Tạo file CSV tạm chuẩn định dạng
    createNBTextLibCSV(tempFilePath, rows, langCount);

    if (app.isPackaged) {
      // Bản đã đóng gói: gọi thẳng auto_import.exe đi kèm bộ cài (nằm ngoài app.asar, trong thư
      // mục resources/ - xem "extraResources" trong package.json). Không cần dò Python trên máy
      // người dùng cuối nữa - họ không cần cài gì thêm.
      const helperPath = path.join(process.resourcesPath, 'auto_import.exe');
      if (!fs.existsSync(helperPath)) {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        event.reply('import-result', { success: false, message: 'Không tìm thấy auto_import.exe đi kèm bản cài đặt!' });
        return;
      }
      runImportHelper(helperPath, [tempFilePath], tempFilePath, event);
      return;
    }

    // Bản dev (chạy bằng "npm start", chưa đóng gói): vẫn dùng script Python trực tiếp như cũ,
    // để không cần build lại auto_import.exe mỗi lần sửa auto_import.py khi đang phát triển.
    const scriptPath = path.join(__dirname, 'auto_import.py');

    if (!fs.existsSync(scriptPath)) {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      event.reply('import-result', { success: false, message: 'Không tìm thấy kịch bản auto_import.py!' });
      return;
    }

    findPythonCmd((pythonCmd) => {
      if (!pythonCmd) {
        if (fs.existsSync(tempFilePath)) { try { fs.unlinkSync(tempFilePath); } catch (e) {} }
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

      // pythonCmd có thể là "py -3" (2 từ) - tách command khỏi tham số vì spawn() không qua shell
      // nên không tự tách chuỗi lệnh như exec() làm.
      const [cmd, ...baseArgs] = pythonCmd.split(' ');
      runImportHelper(cmd, [...baseArgs, scriptPath, tempFilePath], tempFilePath, event);
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