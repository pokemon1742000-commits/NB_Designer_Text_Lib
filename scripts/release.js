// Dùng: npm run release:auto -- "Nội dung commit"
// Publish thêm GitHub Release: npm run release:auto -- --publish "Nội dung commit"

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_REMOTE = 'https://github.com/pokemon1742000-commits/NB_Designer_Text_Lib';
const args = process.argv.slice(2);
const publish = args.includes('--publish');
const messageParts = args.filter((arg) => arg !== '--publish');

if (messageParts.some((arg) => arg.startsWith('--'))) {
  throw new Error('Tham số không hợp lệ. Dùng: npm run release:auto -- [--publish] "Nội dung commit"');
}

function normalizeRemote(url) {
  return url.trim().replace(/\/$/, '').replace(/\.git$/, '').toLowerCase();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);
  if (process.platform === 'win32' && command === 'npm') {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    return;
  }
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

function getGitHubToken() {
  const environmentToken = process.env.GH_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  try {
    const storedToken = execFileSync('gh', ['auth', 'token'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return storedToken || null;
  } catch {
    return null;
  }
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Version không hợp lệ: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function getCommittedVersion() {
  return JSON.parse(git(['show', 'HEAD:package.json'])).version;
}

function resolveNextVersion(currentVersion, committedVersion) {
  if (currentVersion === committedVersion) return bumpPatch(currentVersion);
  const pendingVersion = bumpPatch(committedVersion);
  if (currentVersion === pendingVersion) return currentVersion;
  throw new Error(
    `Version working tree (${currentVersion}) không khớp version đã commit (${committedVersion}). ` +
      `Hãy kiểm tra package.json trước khi release.`
  );
}

function ensureNoUnexpectedUntrackedFiles() {
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  const unexpected = status
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => line.startsWith('?? '));
  if (unexpected.length) {
    throw new Error(
      `Có file chưa được theo dõi; hãy kiểm tra và git add thủ công trước khi release:\n${unexpected.join('\n')}`
    );
  }
}

const packagePath = path.join(ROOT, 'package.json');
const lockPath = path.join(ROOT, 'package-lock.json');
const packageJson = readJson(packagePath);
const lockJson = readJson(lockPath);
const currentVersion = packageJson.version;
const committedVersion = getCommittedVersion();
const nextVersion = resolveNextVersion(currentVersion, committedVersion);
const remote = git(['remote', 'get-url', 'origin']);
const branch = git(['branch', '--show-current']);

if (normalizeRemote(remote) !== normalizeRemote(EXPECTED_REMOTE)) {
  throw new Error(`Remote origin không đúng: ${remote}`);
}
if (!branch) throw new Error('Không xác định được branch hiện tại.');
if (publish) {
  const githubToken = getGitHubToken();
  if (!githubToken) {
    throw new Error(
      'Chưa tìm thấy GitHub token. Hãy chạy "gh auth login" một lần hoặc set GH_TOKEN tạm thời.'
    );
  }
  process.env.GH_TOKEN = githubToken;
}
ensureNoUnexpectedUntrackedFiles();

packageJson.version = nextVersion;
lockJson.version = nextVersion;
if (lockJson.packages && lockJson.packages['']) lockJson.packages[''].version = nextVersion;
writeJson(packagePath, packageJson);
writeJson(lockPath, lockJson);
console.log(`Version: ${currentVersion} -> ${nextVersion}`);

try {
  run('npm', ['run', publish ? 'build:publish' : 'build']);

  const helperPath = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'auto_import.exe');
  if (!fs.existsSync(helperPath)) throw new Error(`Thiếu helper sau build: ${helperPath}`);

  run('git', ['add', '-u']);
  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged) throw new Error('Không có thay đổi để commit sau khi tăng version.');

  const commitMessage = messageParts.join(' ').trim() || `Release v${nextVersion}`;
  run('git', ['commit', '-m', commitMessage]);
  run('git', ['push', 'origin', branch]);

  console.log(`\nHoàn tất release v${nextVersion}.`);
  console.log(`Installer: dist/NB TextLib Exporter Setup ${nextVersion}.exe`);
  if (publish) console.log('GitHub Release đã được publish bởi electron-builder.');
} catch (error) {
  console.error('Release thất bại; chưa push thay đổi lên GitHub.');
  throw error;
}
