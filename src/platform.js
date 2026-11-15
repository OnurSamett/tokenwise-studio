// Pure platform/path decisions: injectable so Windows behavior is tested on macOS.
import path from 'node:path';
export const pathsFor = (platform = process.platform) => platform === 'win32' ? path.win32 : path.posix;
export function samePath(a, b, platform = process.platform) {
  const p = pathsFor(platform);
  const clean = value => p.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b);
}
export function withinPath(file, root, platform = process.platform) {
  const p = pathsFor(platform), rel = p.relative(p.resolve(root), p.resolve(file));
  return !rel || (rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel));
}
export function gitCommonDir(repo, gitOutput, platform = process.platform) {
  return pathsFor(platform).resolve(repo, gitOutput.trim());
}
export function systemProjectPath(file, { platform = process.platform, env = process.env } = {}) {
  const p = pathsFor(platform), abs = p.resolve(file);
  if (platform === 'win32') {
    const dirs = [env.SystemRoot || 'C:\\Windows', env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.ProgramData || 'C:\\ProgramData'];
    return samePath(abs, p.parse(abs).root, platform) || dirs.some(dir => withinPath(abs, dir, platform));
  }
  return ['/', '/Library', '/System', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/Applications', '/Volumes'].includes(abs)
    || withinPath(abs, '/Library', platform) || withinPath(abs, '/System', platform);
}
export function platformFeatures(platform = process.platform) {
  return { nativeDictation: platform === 'darwin', playtest: platform === 'darwin', sparkle: platform === 'darwin', browserNotifications: platform !== 'darwin' };
}
