// 内置 Python 引擎的【平台路径形态】契约(见 src/media-studio/bakuan-engine.ts)。
//
// 2026-07-25 实测发现:这个文件原来把路径写死成 POSIX 形态(`python-runtime/bin/python3`、
// `.venv/bin/pip`),一个 win32 分支都没有——Windows 安装包里的引擎因此【永远】provision 不出来
// (找不到解释器/pip),而错误只会在用户真的点了采集/读评论时才冒出来。这类"路径静默拼错"
// 靠肉眼 review 很难发现,所以两个平台的形态都在这里锁死。
//
// 平台常量在模块加载时求值,所以每个用例都要 resetModules + 改 process.platform 后重新 import。
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const realPlatform = process.platform;

const loadAs = async (platform: NodeJS.Platform) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.resetModules();
  return import('../src/media-studio/bakuan-engine.js');
};

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.resetModules();
});

describe('bakuan-engine 路径形态', () => {
  it('POSIX:venv 可执行文件在 .venv/bin,无扩展名', async () => {
    const { venvExecutable } = await loadAs('darwin');
    expect(venvExecutable('/e', 'python')).toBe(path.join('/e', '.venv', 'bin', 'python'));
    expect(venvExecutable('/e', 'pip')).toBe(path.join('/e', '.venv', 'bin', 'pip'));
    expect(venvExecutable('/e', 'yt-dlp')).toBe(path.join('/e', '.venv', 'bin', 'yt-dlp'));
  });

  it('Windows:venv 可执行文件在 .venv\\Scripts,带 .exe', async () => {
    const { venvExecutable } = await loadAs('win32');
    expect(venvExecutable('C:\\e', 'python')).toBe(path.join('C:\\e', '.venv', 'Scripts', 'python.exe'));
    expect(venvExecutable('C:\\e', 'pip')).toBe(path.join('C:\\e', '.venv', 'Scripts', 'pip.exe'));
    expect(venvExecutable('C:\\e', 'yt-dlp')).toBe(path.join('C:\\e', '.venv', 'Scripts', 'yt-dlp.exe'));
  });

  it('POSIX:内置解释器在 python-runtime/bin/python3', async () => {
    const { bundledPythonPath } = await loadAs('linux');
    expect(bundledPythonPath('/r')).toBe(path.join('/r', 'python-runtime', 'bin', 'python3'));
  });

  // python-build-standalone 的 Windows 归档没有 bin/ 层,解释器直接在顶层。
  it('Windows:内置解释器在 python-runtime\\python.exe(归档顶层,没有 bin/)', async () => {
    const { bundledPythonPath } = await loadAs('win32');
    expect(bundledPythonPath('C:\\r')).toBe(path.join('C:\\r', 'python-runtime', 'python.exe'));
    expect(bundledPythonPath('C:\\r')).not.toContain('bin');
  });
});
