import { watch } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src');

let buildTimeout = null;
let currentBuildProcess = null;
let pendingBuild = false;

function triggerBuild() {
  if (buildTimeout) {
    clearTimeout(buildTimeout);
  }

  buildTimeout = setTimeout(() => {
    if (currentBuildProcess) {
      pendingBuild = true;
      return;
    }
    runBuild();
  }, 300);
}

function runBuild() {
  pendingBuild = false;
  console.log('\n[Watcher] Change detected. Running next build...');
  
  const npmPath = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  
  currentBuildProcess = spawn(npmPath, ['run', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: `/Users/schomer/.nvm/versions/node/v24.16.0/bin:${process.env.PATH}`
    }
  });

  currentBuildProcess.on('exit', (code) => {
    currentBuildProcess = null;
    if (code === 0) {
      console.log('[Watcher] Build completed successfully.');
    } else {
      console.log(`[Watcher] Build failed with exit code ${code}`);
    }
    
    if (pendingBuild) {
      runBuild();
    }
  });
}

console.log(`[Watcher] Watching ${srcDir} recursively for changes...`);
watch(srcDir, { recursive: true }, (eventType, filename) => {
  if (filename) {
    if (filename.includes('.next') || filename.startsWith('.')) return;
    console.log(`[Watcher] File modified: ${filename}`);
    triggerBuild();
  }
});

// Run initial build on start
triggerBuild();
