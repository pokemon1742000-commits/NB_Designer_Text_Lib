// scripts/release.js
// ------------------------------------------------------------------
// Dùng: npm run release:auto -- "Nội dung commit"
//
// Chỉ 1 lệnh duy nhất, làm tuần tự theo đúng thứ tự:
//   1. Build app + TỰ ĐỘNG tạo GitHub Release, đính kèm file cài đặt (.exe)
//      (nhờ electron-builder --publish always, xem "build.publish" trong package.json)
//   2. git add -A
//   3. git commit -m "<message>"
//   4. git push
//
// YÊU CẦU TRƯỚC KHI CHẠY:
//   - Đã có git remote "origin" trỏ tới đúng repo GitHub (electron-builder tự dò owner/repo
//     từ remote này, không cần khai báo thêm trong package.json).
//   - Đã tạo GitHub Personal Access Token (quyền "repo") và set vào biến môi trường GH_TOKEN
//     trước khi chạy lệnh, ví dụ:
//       Windows CMD:        set GH_TOKEN=ghp_xxxxxxxxxxxxxxxx
//       Windows PowerShell:  $env:GH_TOKEN="ghp_xxxxxxxxxxxxxxxx"
//     (Nên set 1 lần trong biến môi trường hệ thống - Settings > Advanced system settings >
//      Environment Variables - để khỏi phải gõ lại mỗi lần mở terminal mới.)
// ------------------------------------------------------------------

const { execSync } = require('child_process');

const message = process.argv[2] || 'update';

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

// 1. Build + Publish GitHub Release (kèm file cài đặt .exe) - làm TRƯỚC tiên
run('npm run build:publish');

// 2. Đưa mọi thay đổi mã nguồn vào git
run('git add -A');

// 3. Commit - nếu không có gì thay đổi để commit (ví dụ chỉ build lại, code không đổi) thì
//    lệnh "git commit" sẽ báo lỗi và thoát khác 0; bắt lỗi ở đây để không làm dừng cả script.
try {
  run(`git commit -m "${message.replace(/"/g, '\\"')}"`);
} catch (err) {
  console.log('(Không có thay đổi mã nguồn nào để commit - bỏ qua bước này.)');
}

// 4. Đẩy code lên git
run('git push');

console.log('\nHoàn tất: đã build, tạo GitHub Release, commit và push xong.');
