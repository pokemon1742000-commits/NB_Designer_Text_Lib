// renderer.js
// ------------------------------------------------------------------
// Logic phía giao diện (renderer process) cho NB TextLib Exporter.
//
// Cấu trúc dữ liệu 1 item (1 dòng "Name" trong Text Library):
//   {
//     name: "Ten hien thi",
//     status: 2,                 // số lượng trạng thái (0, 1, ...)
//     states: [                  // mỗi phần tử tương ứng 1 trạng thái
//       { lang1: "...", lang2: "..." },  // trạng thái 0
//       { lang1: "...", lang2: "..." }   // trạng thái 1
//     ]
//   }
//
// Mỗi item được vẽ thành nhiều <tr> (1 tr / trạng thái). Các ô STT, Name,
// Status, Xóa dùng rowspan để gộp theo chiều dọc trong phạm vi 1 item.
// ------------------------------------------------------------------

const { ipcRenderer } = require('electron');

let items = [];       // toàn bộ dữ liệu bảng
let langCount = 2;    // số cột ngôn ngữ hiện tại (mặc định khớp index.html: Language1, Language2)
let isCompact = false;
let searchTerm = '';  // từ khóa tìm/lọc hiện tại (đã lowercase + trim)

// ---------- Undo/Redo ----------
// Chụp toàn bộ {items, langCount} thành chuỗi JSON trước mỗi thao tác làm thay đổi dữ liệu, thay
// vì diff từng phần - đơn giản và chắc chắn đúng, đủ nhanh với quy mô bảng dữ liệu thực tế của
// phần mềm này (vài trăm dòng). Giới hạn 50 bước để tránh phình bộ nhớ vô hạn khi dùng lâu.
let historyStack = [];
let redoStack = [];
let pendingEditSnapshot = null; // snapshot chụp lúc focus vào 1 ô, để gộp cả quá trình gõ thành 1 bước undo duy nhất khi blur
const MAX_HISTORY = 50;

function snapshotState() {
  return JSON.stringify({ items, langCount });
}

function pushHistory(beforeSnapshotJson) {
  historyStack.push(beforeSnapshotJson);
  if (historyStack.length > MAX_HISTORY) historyStack.shift();
  redoStack.length = 0; // thao tác mới sau khi undo sẽ xóa nhánh redo cũ, giống mọi editor khác
}

function restoreSnapshot(json) {
  const data = JSON.parse(json);
  items = data.items;
  langCount = data.langCount;
  renderHeader();
  renderTable();
  markDirty();
  scheduleAutosave();
}

function undo() {
  if (historyStack.length === 0) return;
  const current = snapshotState();
  const prev = historyStack.pop();
  redoStack.push(current);
  restoreSnapshot(prev);
}

function redo() {
  if (redoStack.length === 0) return;
  const current = snapshotState();
  const next = redoStack.pop();
  historyStack.push(current);
  restoreSnapshot(next);
}

// Gọi khi 1 ô input (Name/Status/Language) mất focus: nếu nội dung thực sự đổi so với lúc focus
// vào, đẩy trạng thái TRƯỚC khi gõ vào lịch sử undo - toàn bộ 1 lần sửa (dù gõ bao nhiêu ký tự)
// chỉ tính là 1 bước Ctrl+Z, giống cách Word/Excel gộp undo theo phiên chỉnh sửa.
function commitPendingEdit() {
  if (pendingEditSnapshot === null) return;
  const before = pendingEditSnapshot;
  pendingEditSnapshot = null;
  if (before !== snapshotState()) {
    pushHistory(before);
  }
}

document.addEventListener('keydown', (e) => {
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (!ctrlOrCmd) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    // Chốt lại chỉnh sửa đang dang dở (nếu có) trước khi undo, để Ctrl+Z đầu tiên lùi về đúng
    // ngay trước lần gõ hiện tại thay vì bỏ sót nó.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    undo();
  } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    redo();
  }
}, true);

// ---------- Autosave nháp + đánh dấu "chưa export/import" ----------
let isDirty = false;
let autosaveTimer = null;
const DRAFT_KEY = 'nbtextlib_draft_v1';

function markDirty() {
  if (isDirty) return;
  isDirty = true;
  updateDirtyIndicator();
}

function markClean() {
  isDirty = false;
  updateDirtyIndicator();
}

function updateDirtyIndicator() {
  const dot = document.getElementById('dirtyIndicator');
  if (dot) dot.style.display = isDirty ? 'inline' : 'none';
}

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveDraftNow, 400);
}

function saveDraftNow() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ items, langCount, savedAt: Date.now() }));
  } catch (e) {
    // localStorage có thể bị chặn/đầy (chế độ riêng tư, quota) - autosave chỉ là tiện ích phụ,
    // không được phép làm gãy luồng nhập liệu chính nếu ghi thất bại.
    console.warn('Không lưu được bản nháp tự động:', e);
  }
}

// Trả về true nếu đã khôi phục bản nháp (đã gán lại items/langCount), false nếu nên khởi tạo
// bảng trống như bình thường.
function loadDraftIfAny() {
  let raw;
  try {
    raw = localStorage.getItem(DRAFT_KEY);
  } catch (e) {
    return false;
  }
  if (!raw) return false;

  let draft;
  try {
    draft = JSON.parse(raw);
  } catch (e) {
    return false;
  }
  if (!draft || !Array.isArray(draft.items) || draft.items.length === 0) return false;

  // Bỏ qua bản nháp "trống về mặt nội dung" (chỉ có 1 dòng rỗng mặc định) - không đáng để hỏi.
  const hasContent = draft.items.some(it =>
    (it.name || '').trim() ||
    (it.states || []).some(s => Object.values(s).some(v => (v || '').trim()))
  );
  if (!hasContent) return false;

  const savedAt = draft.savedAt ? new Date(draft.savedAt) : null;
  const timeText = savedAt ? savedAt.toLocaleString('vi-VN') : 'không rõ thời gian';
  const wantsRestore = confirm(
    `Tìm thấy bản nháp tự động lưu lúc ${timeText} (${draft.items.length} dòng) từ lần trước ` +
    `chưa Export/Import xong. Bạn có muốn khôi phục lại bản nháp này không?\n\n` +
    `(Chọn Cancel để bắt đầu bảng trống mới.)`
  );
  if (!wantsRestore) return false;

  items = draft.items;
  langCount = draft.langCount || langCount;
  return true;
}

// ---------- Validation: chống lỗi Import (tên trống / trùng tên) ----------
function getValidationIssues() {
  const issues = [];
  const nameFirstSeen = new Map(); // tên đã chuẩn hoá (trim + lowercase) -> số dòng đầu tiên gặp
  items.forEach((item, idx) => {
    const rowNum = idx + 1;
    const trimmed = (item.name || '').trim();
    if (!trimmed) {
      issues.push({ type: 'empty', row: rowNum, text: `Dòng ${rowNum}: tên (Name) đang để trống.` });
      return;
    }
    const key = trimmed.toLowerCase();
    if (nameFirstSeen.has(key)) {
      issues.push({
        type: 'duplicate',
        row: rowNum,
        text: `Dòng ${nameFirstSeen.get(key)} và ${rowNum}: trùng tên "${trimmed}".`,
      });
    } else {
      nameFirstSeen.set(key, rowNum);
    }
  });
  return issues;
}

// Tô đỏ các ô Name có vấn đề (trống hoặc trùng) và cập nhật banner cảnh báo phía trên bảng.
// Hàm này nhẹ (không renderTable lại), gọi được từ oninput của Name mà không mất focus/con trỏ.
function updateValidationUI() {
  const emptyRows = new Set();
  const duplicateRows = new Set();
  const nameFirstSeen = new Map();
  items.forEach((item, idx) => {
    const trimmed = (item.name || '').trim();
    if (!trimmed) { emptyRows.add(idx); return; }
    const key = trimmed.toLowerCase();
    if (nameFirstSeen.has(key)) {
      duplicateRows.add(idx);
      duplicateRows.add(nameFirstSeen.get(key));
    } else {
      nameFirstSeen.set(key, idx);
    }
  });
  items.forEach((item, idx) => {
    const el = document.getElementById(nameInputId(idx));
    if (!el) return;
    el.classList.toggle('input-error', emptyRows.has(idx) || duplicateRows.has(idx));
  });

  const issues = getValidationIssues();
  const banner = document.getElementById('validationBanner');
  if (!banner) return;
  if (issues.length === 0) {
    banner.style.display = 'none';
    banner.textContent = '';
    return;
  }
  const shown = issues.slice(0, 5).map(i => i.text).join(' ');
  const more = issues.length > 5 ? ` (và ${issues.length - 5} vấn đề khác)` : '';
  banner.textContent = `⚠ ${issues.length} vấn đề dữ liệu: ${shown}${more}`;
  banner.style.display = 'block';
}

// Gọi trước khi Export/Import: tên trống chặn hẳn (không thể export/import hợp lệ), trùng tên chỉ
// cảnh báo + hỏi xác nhận (có thể là chủ ý cập nhật lại đúng entry đó).
function confirmProceedDespiteIssues() {
  const issues = getValidationIssues();
  const blocking = issues.filter(i => i.type === 'empty');
  if (blocking.length > 0) {
    alert(
      `Không thể tiếp tục: có ${blocking.length} dòng đang để trống Tên (Name).\n` +
      blocking.slice(0, 5).map(i => i.text).join('\n') +
      (blocking.length > 5 ? `\n...và ${blocking.length - 5} dòng khác.` : '') +
      '\n\nHãy điền Tên cho các dòng này rồi thử lại.'
    );
    return false;
  }
  const duplicates = issues.filter(i => i.type === 'duplicate');
  if (duplicates.length > 0) {
    return confirm(
      `Phát hiện ${duplicates.length} cặp dòng trùng tên:\n` +
      duplicates.slice(0, 5).map(i => i.text).join('\n') +
      (duplicates.length > 5 ? `\n...và ${duplicates.length - 5} vấn đề khác.` : '') +
      '\n\nTrùng tên có thể khiến NB-Designer ghi đè không như ý muốn. Vẫn tiếp tục?'
    );
  }
  return true;
}

// ---------- Tìm kiếm / lọc ----------
function onSearchInput() {
  searchTerm = document.getElementById('searchBox').value.trim().toLowerCase();
  renderTable();
}

function itemMatchesSearch(item) {
  if (!searchTerm) return true;
  if ((item.name || '').toLowerCase().includes(searchTerm)) return true;
  return (item.states || []).some(state =>
    Object.values(state).some(v => (v || '').toLowerCase().includes(searchTerm))
  );
}

function updateSearchCount(visible, total) {
  const el = document.getElementById('searchCount');
  if (!el) return;
  el.textContent = searchTerm ? `${visible}/${total} dòng` : '';
}

// ---------- Khởi tạo ----------
document.addEventListener('DOMContentLoaded', () => {
  const restored = loadDraftIfAny();
  if (!restored) {
    // Bắt đầu với 1 dòng trống cho dễ dùng
    items.push(makeEmptyItem());
  }
  renderHeader();
  renderTable();

  // Nối các nút điều khiển cửa sổ tự vẽ (titlebar) tới main.js qua IPC
  document.getElementById('btnMinimize').onclick = () => ipcRenderer.send('window-minimize');
  document.getElementById('btnMaximize').onclick = () => ipcRenderer.send('window-maximize-toggle');
  document.getElementById('btnClose').onclick = () => ipcRenderer.send('window-close');
  // Nút X nhỏ riêng cho chế độ Mini (compact-mode)
  document.getElementById('btnCloseMini').onclick = () => ipcRenderer.send('window-close');
});

function makeEmptyItem() {
  return {
    name: '',
    status: 1,
    states: [makeEmptyState()]
  };
}

function makeEmptyState() {
  const state = {};
  for (let l = 1; l <= langCount; l++) {
    state[`lang${l}`] = '';
  }
  return state;
}

// ---------- Vẽ lại phần tiêu đề bảng (STT, Name, Status, Language1..N, Xóa) ----------
function renderHeader() {
  const headerRow = document.getElementById('headerRow');
  headerRow.innerHTML = '';

  const cols = [
    { text: 'STT', style: 'width: 35px;' },
    { text: 'Name', style: '' },
    { text: 'Status', style: 'width: 65px;' }
  ];
  for (let l = 1; l <= langCount; l++) {
    cols.push({ text: `Language${l}`, style: '' });
  }
  cols.push({ text: 'Xóa', style: 'width: 45px;' });

  cols.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.text;
    if (col.style) th.setAttribute('style', col.style);
    headerRow.appendChild(th);
  });
}

function nameInputId(itemIndex) {
  return `name-input-${itemIndex}`;
}

// ---------- Vẽ lại toàn bộ phần thân bảng dựa trên `items` ----------
function renderTable() {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';

  // Bước 1: chuẩn hoá số lượng "states" theo "status" cho MỌI item (kể cả đang bị ẩn bởi ô tìm
  // kiếm), để dữ liệu luôn nhất quán bất kể có đang lọc hay không.
  items.forEach(item => {
    const statusCount = Math.max(1, parseInt(item.status) || 1);
    item.status = statusCount;
    while (item.states.length < statusCount) item.states.push(makeEmptyState());
    while (item.states.length > statusCount) item.states.pop();
  });

  let visibleCount = 0;

  items.forEach((item, itemIndex) => {
    if (!itemMatchesSearch(item)) return;
    visibleCount++;

    const statusCount = item.status;

    for (let s = 0; s < statusCount; s++) {
      const tr = document.createElement('tr');
      if (s === 0) tr.classList.add('group-start');

      if (s === 0) {
        // Ô STT (rowspan theo số trạng thái) - giữ nguyên số thứ tự gốc trong `items`, không đánh
        // số lại theo vị trí hiển thị, để STT không nhảy lung tung khi đang gõ tìm kiếm.
        const tdStt = document.createElement('td');
        tdStt.textContent = itemIndex + 1;
        tdStt.rowSpan = statusCount;
        tr.appendChild(tdStt);

        // Ô Name
        const tdName = document.createElement('td');
        tdName.rowSpan = statusCount;
        const inputName = document.createElement('input');
        inputName.type = 'text';
        inputName.id = nameInputId(itemIndex);
        inputName.value = item.name;
        inputName.placeholder = 'Tên...';
        inputName.onfocus = () => { pendingEditSnapshot = snapshotState(); };
        inputName.onblur = () => { commitPendingEdit(); };
        inputName.oninput = (e) => {
          item.name = e.target.value;
          markDirty();
          scheduleAutosave();
          updateValidationUI();
        };
        inputName.onpaste = (e) => handleNamePaste(e, itemIndex);
        tdName.appendChild(inputName);
        tr.appendChild(tdName);

        // Ô Status
        const tdStatus = document.createElement('td');
        tdStatus.rowSpan = statusCount;
        const inputStatus = document.createElement('input');
        inputStatus.type = 'number';
        inputStatus.min = '1';
        inputStatus.value = item.status;
        inputStatus.onfocus = () => { pendingEditSnapshot = snapshotState(); };
        inputStatus.onblur = () => { commitPendingEdit(); };
        inputStatus.oninput = (e) => {
          let v = parseInt(e.target.value);
          if (!v || v < 1) v = 1;
          item.status = v;
          renderTable();
          markDirty();
          scheduleAutosave();
        };
        tdStatus.appendChild(inputStatus);
        tr.appendChild(tdStatus);
      }

      // Các ô Language cho trạng thái thứ s
      for (let l = 1; l <= langCount; l++) {
        const tdLang = document.createElement('td');
        const inputLang = document.createElement('input');
        inputLang.type = 'text';
        inputLang.id = langInputId(itemIndex, s, l);
        inputLang.value = item.states[s][`lang${l}`] || '';
        inputLang.placeholder = `Trạng thái ${s}`;
        inputLang.onfocus = () => { pendingEditSnapshot = snapshotState(); };
        inputLang.onblur = () => { commitPendingEdit(); };
        inputLang.oninput = (e) => {
          item.states[s][`lang${l}`] = e.target.value;
          markDirty();
          scheduleAutosave();
        };
        inputLang.onkeydown = (e) => handleLangKeydown(e, itemIndex, s, l);
        inputLang.onpaste = (e) => handleLangPaste(e, itemIndex, s, l);
        tdLang.appendChild(inputLang);
        tr.appendChild(tdLang);
      }

      if (s === 0) {
        // Ô nút Xóa (rowspan)
        const tdDel = document.createElement('td');
        tdDel.rowSpan = statusCount;
        const btnDel = document.createElement('button');
        btnDel.className = 'btn-del';
        btnDel.textContent = '✕';
        btnDel.onclick = () => {
          pushHistory(snapshotState());
          items.splice(itemIndex, 1);
          if (items.length === 0) items.push(makeEmptyItem());
          renderTable();
          markDirty();
          scheduleAutosave();
        };
        tdDel.appendChild(btnDel);
        tr.appendChild(tdDel);
      }

      tbody.appendChild(tr);
    }
  });

  updateValidationUI();
  updateSearchCount(visibleCount, items.length);
}

// ---------- Điều hướng bàn phím giữa các ô ngôn ngữ ----------
// Id duy nhất cho mỗi ô input ngôn ngữ, dựa trên item / trạng thái / cột ngôn ngữ.
function langInputId(itemIndex, stateIndex, langIndex) {
  return `lang-input-${itemIndex}-${stateIndex}-${langIndex}`;
}

// Focus vào 1 ô ngôn ngữ cụ thể và đặt vị trí con trỏ bên trong ô đó.
//   cursorMode: 'start' -> đặt con trỏ đầu ô, 'end' -> cuối ô, 'same' -> giữ nguyên vị trí cũ (dùng
//   khi nhảy lên/xuống, để con trỏ không bị nhảy về đầu/cuối một cách khó chịu).
function focusLangInput(itemIndex, stateIndex, langIndex, cursorMode, samePos) {
  const el = document.getElementById(langInputId(itemIndex, stateIndex, langIndex));
  if (!el) return;
  el.focus();
  let pos;
  if (cursorMode === 'start') pos = 0;
  else if (cursorMode === 'end') pos = el.value.length;
  else pos = Math.min(samePos || 0, el.value.length);
  el.setSelectionRange(pos, pos);
}

function handleLangKeydown(e, itemIndex, stateIndex, langIndex) {
  const input = e.target;
  const pos = input.selectionStart;
  const end = input.selectionEnd;
  const len = input.value.length;
  const item = items[itemIndex];

  switch (e.key) {
    case 'ArrowLeft':
      // Chỉ nhảy cột khi con trỏ đang ở vị trí ngoài cùng bên trái của ô (không chọn vùng text)
      if (pos === 0 && end === 0 && langIndex > 1) {
        e.preventDefault();
        focusLangInput(itemIndex, stateIndex, langIndex - 1, 'end');
      }
      break;

    case 'ArrowRight':
      // Chỉ nhảy cột khi con trỏ đang ở vị trí ngoài cùng bên phải của ô
      if (pos === len && end === len && langIndex < langCount) {
        e.preventDefault();
        focusLangInput(itemIndex, stateIndex, langIndex + 1, 'start');
      }
      break;

    case 'ArrowUp':
      if (stateIndex > 0) {
        e.preventDefault();
        focusLangInput(itemIndex, stateIndex - 1, langIndex, 'same', pos);
      }
      break;

    case 'ArrowDown':
      if (stateIndex < item.states.length - 1) {
        e.preventDefault();
        focusLangInput(itemIndex, stateIndex + 1, langIndex, 'same', pos);
      }
      break;

    case 'Enter':
      e.preventDefault();
      if (stateIndex < item.states.length - 1) {
        // Còn dòng trạng thái bên dưới -> nhảy xuống cùng cột ngôn ngữ
        focusLangInput(itemIndex, stateIndex + 1, langIndex, 'same', pos);
      } else {
        // Đang ở dòng trạng thái cuối cùng -> tự thêm 1 status mới rồi focus vào ô mới
        pushHistory(snapshotState());
        item.states.push(makeEmptyState());
        item.status = item.states.length;
        renderTable();
        markDirty();
        scheduleAutosave();
        const newStateIndex = item.states.length - 1;
        // Cần đợi DOM vẽ lại xong (renderTable tạo lại toàn bộ input) rồi mới focus được
        requestAnimationFrame(() => focusLangInput(itemIndex, newStateIndex, langIndex, 'start'));
      }
      break;
  }
}

// ---------- Dán nhiều ô kiểu Excel/Sheets ----------
// Tách các dòng dán ra (chuẩn hoá mọi kiểu xuống dòng về '\n', bỏ dòng trống cuối cùng thường có
// khi copy nguyên 1 vùng từ Excel).
function splitPastedRows(text) {
  const rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

// Dán vào 1 ô Language: nếu dữ liệu dán chỉ là 1 giá trị đơn (không có tab/xuống dòng), để trình
// duyệt tự dán bình thường vào ô đang gõ. Nếu là cả 1 vùng nhiều ô (có tab và/hoặc nhiều dòng),
// chủ động điền vào lưới bắt đầu từ ô hiện tại - giống hệt cách Excel/Google Sheets dán vào bảng:
// tự thêm dòng trạng thái mới nếu thiếu, nhưng KHÔNG tự thêm cột ngôn ngữ mới ngoài phạm vi đã có
// (tránh dán nhầm làm phình số cột ngoài ý muốn).
function handleLangPaste(e, itemIndex, stateIndex, langIndex) {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text || !/\t|\r|\n/.test(text)) return; // giá trị đơn - để hành vi dán mặc định xử lý

  e.preventDefault();
  const rows = splitPastedRows(text);

  pushHistory(snapshotState());
  const item = items[itemIndex];
  rows.forEach((rowText, rOffset) => {
    const targetState = stateIndex + rOffset;
    while (item.states.length <= targetState) {
      item.states.push(makeEmptyState());
    }
    const cols = rowText.split('\t');
    cols.forEach((val, cOffset) => {
      const targetLang = langIndex + cOffset;
      if (targetLang > langCount) return;
      item.states[targetState][`lang${targetLang}`] = val;
    });
  });
  item.status = item.states.length;

  renderTable();
  markDirty();
  scheduleAutosave();
  requestAnimationFrame(() => focusLangInput(itemIndex, stateIndex, langIndex, 'end'));
}

// Dán vào ô Name: 1 dòng đơn thì để mặc định gõ vào ô hiện tại. Dán nhiều dòng (ví dụ copy 1 cột
// tên từ Excel) sẽ tạo thêm hàng loạt dòng mới ngay sau dòng hiện tại, mỗi dòng 1 tên.
function handleNamePaste(e, itemIndex) {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text) return;
  const rows = splitPastedRows(text);
  if (rows.length <= 1) return; // giá trị đơn - để hành vi dán mặc định xử lý

  e.preventDefault();
  pushHistory(snapshotState());

  items[itemIndex].name = rows[0];
  const newItems = rows.slice(1).map(name => {
    const it = makeEmptyItem();
    it.name = name;
    return it;
  });
  items.splice(itemIndex + 1, 0, ...newItems);

  renderTable();
  markDirty();
  scheduleAutosave();
  requestAnimationFrame(() => {
    const el = document.getElementById(nameInputId(itemIndex));
    if (el) el.focus();
  });
}

// ---------- Toolbar: Thêm dòng ----------
function addRow() {
  pushHistory(snapshotState());
  items.push(makeEmptyItem());
  renderTable();
  markDirty();
  scheduleAutosave();
}

// ---------- Toolbar: Thêm cột ngôn ngữ ----------
function addLanguageColumn() {
  pushHistory(snapshotState());
  langCount++;
  items.forEach(item => {
    item.states.forEach(state => {
      if (state[`lang${langCount}`] === undefined) {
        state[`lang${langCount}`] = '';
      }
    });
  });
  renderHeader();
  renderTable();
  markDirty();
  scheduleAutosave();
}

// ---------- Toolbar: Chế độ thu nhỏ ----------
function toggleCompact() {
  isCompact = !isCompact;
  document.body.classList.toggle('compact-mode', isCompact);
  ipcRenderer.send('toggle-compact-mode', isCompact);

  const compactBtn = document.getElementById('compactBtn');
  compactBtn.textContent = isCompact ? '🔍 Phóng to' : '📌 Thu nhỏ Mini';
}

// ---------- Toolbar: Export CSV ----------
function exportExcel() {
  if (!confirmProceedDespiteIssues()) return;
  ipcRenderer.send('export-excel', { rows: items, langCount });
}

ipcRenderer.on('export-success', (event, message) => {
  markClean();
  alert(message);
});

ipcRenderer.on('export-error', (event, message) => {
  alert(message);
});

// ---------- Toolbar: Import tự động vào NB-Designer ----------
function importToNB() {
  if (!confirmProceedDespiteIssues()) return;

  const importBtn = document.getElementById('importBtn');
  importBtn.disabled = true;
  importBtn.textContent = '⏳ Đang import...';

  ipcRenderer.send('import-to-nb', { rows: items, langCount });
}

ipcRenderer.on('import-result', (event, result) => {
  const importBtn = document.getElementById('importBtn');
  importBtn.disabled = false;
  importBtn.textContent = '⚡ Import vào NB-Designer';

  if (result.success) markClean();
  alert(result.message);
});

// ---------- Toolbar: Nhập ngược 1 file CSV có sẵn vào bảng ----------
function importCsvToTable() {
  const hasContent = items.some(it =>
    (it.name || '').trim() ||
    (it.states || []).some(s => Object.values(s).some(v => (v || '').trim()))
  );
  if (hasContent) {
    const ok = confirm(
      'Nạp file CSV sẽ THAY THẾ toàn bộ dữ liệu đang có trong bảng hiện tại ' +
      '(vẫn có thể bấm Ctrl+Z để hoàn tác nếu đổi ý). Tiếp tục?'
    );
    if (!ok) return;
  }
  ipcRenderer.send('open-csv-for-table');
}

ipcRenderer.on('csv-loaded-into-table', (event, data) => {
  pushHistory(snapshotState());
  items = data.items;
  langCount = data.langCount;
  renderHeader();
  renderTable();
  // Dữ liệu vừa nạp khớp đúng với 1 file đã có sẵn trên đĩa, chưa có gì mới cần Export/Import.
  markClean();
  scheduleAutosave();
  alert(`Đã nạp ${items.length} mục từ file CSV vào bảng.`);
});

ipcRenderer.on('csv-load-error', (event, message) => {
  alert(message);
});
