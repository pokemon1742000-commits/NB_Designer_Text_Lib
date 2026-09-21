// scripts/release.js
// Dùng: npm run release:auto -- "Nội dung commit"
// Tự làm 4 bước: git add -> git commit -m "<message>" -> npm run build -> git push.
const { execSync } = require('child_process');

const message = process.argv[2] || 'update';

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

run('git add -A');
run(`git commit -m "${message.replace(/"/g, '\\"')}"`);
run('npm run build');
run('git push');
