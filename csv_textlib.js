// csv_textlib.js
// ------------------------------------------------------------------
// Đọc/ghi file CSV Text Library đúng chuẩn NB-Designer. Tách riêng khỏi main.js (không phụ
// thuộc Electron) để có thể test bằng "node" thuần, không cần mở app.
// ------------------------------------------------------------------

const fs = require('fs');

// Người dùng có thể nhấn Enter trong ô Language để xuống dòng. Nhưng file CSV của NB-Designer là
// định dạng theo DÒNG (mỗi dòng dữ liệu phải nằm trên đúng 1 dòng vật lý), nên ghi thẳng ký tự
// xuống dòng thật vào sẽ làm lệch toàn bộ cấu trúc các dòng phía sau. => Đổi ký tự xuống dòng thật
// thành chuỗi 2 ký tự "\n" (giữ ý định xuống dòng dưới dạng văn bản thường). Khi đọc ngược lại
// (parseNBTextLibCSV) KHÔNG đổi lại thành xuống dòng thật, vì ô nhập trên giao diện là <input>
// 1 dòng - giữ nguyên "\n" dạng chữ để round-trip export/import không bị lệch dữ liệu.
function escapeMultilineForCSV(str) {
  return String(str || '').replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t');
}

function createNBTextLibCSV(filePath, rows, langCount) {
  let lines = [];

  // Dòng 1: Text Lib | V100 | (tab thừa)
  lines.push(['Text Lib', 'V100', ''].join('\t'));

  rows.forEach((item, itemIndex) => {
    if (itemIndex > 0) {
      lines.push('');
    }

    lines.push(['Name:', escapeMultilineForCSV(item.name), ''].join('\t'));

    const statusNum = parseInt(item.status) || 1;
    lines.push(['Status:', statusNum, ''].join('\t'));

    let langHeader = ['Language'];
    for (let l = 1; l <= langCount; l++) {
      langHeader.push(`Language${l}`);
    }
    lines.push(langHeader.join('\t'));

    for (let s = 0; s < statusNum; s++) {
      const stateData = (item.states && item.states[s]) || {};
      let rowData = [s];
      for (let l = 1; l <= langCount; l++) {
        rowData.push(escapeMultilineForCSV(stateData[`lang${l}`]));
      }
      lines.push(rowData.join('\t'));
    }
  });

  const content = lines.join('\r\n') + '\r\n';

  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(content, 'utf16le');
  fs.writeFileSync(filePath, Buffer.concat([bom, body]));
}

// Đọc ngược 1 file CSV Text Library (do chính createNBTextLibCSV tạo ra, hoặc do NB-Designer tự
// export) thành { items, langCount } để nạp vào bảng nhập liệu trên giao diện. Báo lỗi rõ ràng
// (ném Error có message tiếng Việt) ngay khi gặp dòng không đúng cấu trúc mong đợi, thay vì đoán
// bừa hoặc âm thầm bỏ qua dữ liệu sai.
function parseNBTextLibCSV(filePath) {
  const buf = fs.readFileSync(filePath);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.slice(2).toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE hiếm gặp, phòng trường hợp file được lưu bằng công cụ khác.
    text = buf.slice(2).swap16().toString('utf16le');
  } else {
    text = buf.toString('utf8');
  }

  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length === 0 || !lines[0].startsWith('Text Lib')) {
    throw new Error(
      'File không đúng định dạng Text Library của NB-Designer (thiếu dòng "Text Lib" ở đầu file).'
    );
  }

  const items = [];
  let maxLangCount = 1;
  let i = 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    if (!line.startsWith('Name:')) {
      throw new Error(`Định dạng không đúng ở dòng ${i + 1}: mong đợi "Name:\t...", gặp "${line}".`);
    }
    const name = line.split('\t')[1] || '';
    i++;

    if (i >= lines.length || !lines[i].startsWith('Status:')) {
      throw new Error(`Định dạng không đúng ở dòng ${i + 1}: thiếu dòng "Status:" sau "Name:\t${name}".`);
    }
    const statusNum = Math.max(1, parseInt(lines[i].split('\t')[1]) || 1);
    i++;

    if (i >= lines.length || !lines[i].startsWith('Language')) {
      throw new Error(`Định dạng không đúng ở dòng ${i + 1}: thiếu dòng tiêu đề "Language..." sau "Status:".`);
    }
    const blockLangCount = Math.max(1, lines[i].split('\t').length - 1);
    maxLangCount = Math.max(maxLangCount, blockLangCount);
    i++;

    const states = [];
    for (let s = 0; s < statusNum; s++) {
      const dataCols = (lines[i] || '').split('\t');
      const state = {};
      for (let l = 1; l <= blockLangCount; l++) {
        state[`lang${l}`] = dataCols[l] !== undefined ? dataCols[l] : '';
      }
      states.push(state);
      i++;
    }

    items.push({ name, status: statusNum, states });
  }

  if (items.length === 0) {
    throw new Error('File không chứa mục dữ liệu nào (không tìm thấy khối "Name:").');
  }

  // Mọi item dùng chung 1 langCount duy nhất trên giao diện - item nào có ít cột ngôn ngữ hơn
  // (từ file cũ, hoặc do các "Name:" block trong cùng 1 file có số ngôn ngữ khác nhau) được điền
  // thêm ô rỗng cho đủ maxLangCount.
  items.forEach(item => {
    item.states.forEach(state => {
      for (let l = 1; l <= maxLangCount; l++) {
        if (state[`lang${l}`] === undefined) state[`lang${l}`] = '';
      }
    });
  });

  return { items, langCount: maxLangCount };
}

module.exports = { createNBTextLibCSV, parseNBTextLibCSV, escapeMultilineForCSV };
