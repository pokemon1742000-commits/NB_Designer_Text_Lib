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
