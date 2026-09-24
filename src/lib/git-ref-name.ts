/**
 * Why `name` is not a branch name, or null when it is — the rules of
 * `git check-ref-format --branch`: no component starts with `.` or ends
 * with `.lock`, no `..`, no control character, space, `~`, `^`, `:`, `?`,
 * `*`, `[` or `\`, no leading, trailing or doubled `/`, no trailing `.`,
 * no `@{`, not `@` alone, not a leading `-`, and not `HEAD`. Free of
 * server imports: the config checks and the unit-name rule share it.
 */
export function checkBranchName(name: string): string | null {
  if (name === '' || name === '@' || name === 'HEAD') return 'is not a branch name';
  if (name.startsWith('-')) return 'must not start with a dash';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'contains a character git refuses (a space, a control character, or one of ~ ^ : ? * [ \\)';
  if (name.includes('..') || name.includes('@{')) return "must not contain '..' or '@{'";
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'must not start or end with, or double, a slash';
  if (name.endsWith('.')) return 'must not end with a dot';
  if (name.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))) {
    return "has a component that starts with '.' or ends with '.lock'";
  }
  return null;
}
