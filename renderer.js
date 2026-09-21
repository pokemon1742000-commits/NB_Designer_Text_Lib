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

// ---------- Khởi tạo ----------
document.addEventListener('DOMContentLoaded', () => {
  // Bắt đầu với 1 dòng trống cho dễ dùng
  items.push(makeEmptyItem());
  renderHeader();
  renderTable();
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

// ---------- Vẽ lại toàn bộ phần thân bảng dựa trên `items` ----------
function renderTable() {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';

  items.forEach((item, itemIndex) => {
    const statusCount = Math.max(1, parseInt(item.status) || 1);
    item.status = statusCount;

    // Đảm bảo mảng states có đúng số lượng phần tử = statusCount
    while (item.states.length < statusCount) {
      item.states.push(makeEmptyState());
    }
    while (item.states.length > statusCount) {
      item.states.pop();
    }

    for (let s = 0; s < statusCount; s++) {
      const tr = document.createElement('tr');
      if (s === 0) tr.classList.add('group-start');

      if (s === 0) {
        // Ô STT (rowspan theo số trạng thái)
        const tdStt = document.createElement('td');
        tdStt.textContent = itemIndex + 1;
        tdStt.rowSpan = statusCount;
        tr.appendChild(tdStt);

        // Ô Name
        const tdName = document.createElement('td');
        tdName.rowSpan = statusCount;
        const inputName = document.createElement('input');
        inputName.type = 'text';
        inputName.value = item.name;
        inputName.placeholder = 'Tên...';
        inputName.oninput = (e) => { item.name = e.target.value; };
        tdName.appendChild(inputName);
        tr.appendChild(tdName);

        // Ô Status
        const tdStatus = document.createElement('td');
        tdStatus.rowSpan = statusCount;
        const inputStatus = document.createElement('input');
        inputStatus.type = 'number';
        inputStatus.min = '1';
        inputStatus.value = item.status;
        inputStatus.oninput = (e) => {
          let v = parseInt(e.target.value);
          if (!v || v < 1) v = 1;
          item.status = v;
          renderTable();
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
        inputLang.oninput = (e) => {
          item.states[s][`lang${l}`] = e.target.value;
        };
        inputLang.onkeydown = (e) => handleLangKeydown(e, itemIndex, s, l);
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
          items.splice(itemIndex, 1);
          if (items.length === 0) items.push(makeEmptyItem());
          renderTable();
        };
        tdDel.appendChild(btnDel);
        tr.appendChild(tdDel);
      }

      tbody.appendChild(tr);
    }
  });
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
        item.states.push(makeEmptyState());
        item.status = item.states.length;
        renderTable();
        const newStateIndex = item.states.length - 1;
        // Cần đợi DOM vẽ lại xong (renderTable tạo lại toàn bộ input) rồi mới focus được
        requestAnimationFrame(() => focusLangInput(itemIndex, newStateIndex, langIndex, 'start'));
      }
      break;
  }
}

// ---------- Toolbar: Thêm dòng ----------
function addRow() {
  items.push(makeEmptyItem());
  renderTable();
}

// ---------- Toolbar: Thêm cột ngôn ngữ ----------
function addLanguageColumn() {
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
}

// ---------- Toolbar: Chế độ thu nhỏ ----------
function toggleCompact() {
  isCompact = !isCompact;
  document.body.classList.toggle('compact-mode', isCompact);
  ipcRenderer.send('toggle-compact-mode', isCompact);
}

// ---------- Toolbar: Export CSV ----------
function exportExcel() {
  ipcRenderer.send('export-excel', { rows: items, langCount });
}

ipcRenderer.on('export-success', (event, message) => {
  alert(message);
});

ipcRenderer.on('export-error', (event, message) => {
  alert(message);
});

// ---------- Toolbar: Import tự động vào NB-Designer ----------
function importToNB() {
  const importBtn = document.getElementById('importBtn');
  importBtn.disabled = true;
  importBtn.textContent = '⏳ Đang import...';

  ipcRenderer.send('import-to-nb', { rows: items, langCount });
}

ipcRenderer.on('import-result', (event, result) => {
  const importBtn = document.getElementById('importBtn');
  importBtn.disabled = false;
  importBtn.textContent = '⚡ Import vào NB-Designer';

  alert(result.message);
});
