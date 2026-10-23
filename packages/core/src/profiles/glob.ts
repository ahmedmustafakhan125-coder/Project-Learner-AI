/**
 * The globs profile architecture rules are written in, compiled to regular
 * expressions. Paths are repository-relative with forward slashes.
 *
 * `**` matches any number of directories (including none), `*` anything but
 * a slash, `?` one character, and `a|b` either pattern. Nothing else is
 * special, so a rule cannot express more than `verifyBlueprint` checks.
 */
export function globToRegExp(glob: string): RegExp {
  const alternatives = glob.split('|').map((part) => part.trim());
  if (alternatives.some((part) => part === '')) {
    throw new Error(`Empty alternative in glob '${glob}'.`);
  }
  return new RegExp(`^(?:${alternatives.map(compileOne).join('|')})$`);
}

export function matchesGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

function compileOne(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/';
      // `**/` is zero or more whole directories; a trailing `**` is anything.
      out += slashAfter ? '(?:[^/]+/)*' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()[\]\\]/g, '\\$&');
    }
  }
  return out;
}
