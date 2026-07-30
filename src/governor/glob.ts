/**
 * glob.ts — the one gitignore-ish path matcher the governor shares.
 *
 * Both the forbidden deny-list and glob-scoped rules ask the same question: does
 * this project-relative path match a pattern? `**` spans path segments, `*`/`?`
 * stay within one, and a bare folder/file prefix (no wildcards) matches the path
 * itself and everything under it (so `src/api` covers `src/api/x.ts`).
 */

/** The non-wildcard prefix of a pattern (used for dir matching + command scan). */
export function literalPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?]/);
  const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  return prefix.replace(/\/+$/, "");
}

/** Translate a glob to an anchored RegExp (`**` spans segments, `*`/`?` don't). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // collapse `**/` so it can match zero segments
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Does one project-relative POSIX path match one glob pattern? */
export function globMatch(relPosixPath: string, glob: string): boolean {
  if (globToRegExp(glob).test(relPosixPath)) return true;
  const prefix = literalPrefix(glob);
  return prefix !== "" && (relPosixPath === prefix || relPosixPath.startsWith(prefix + "/"));
}

/** Does any of `relPaths` match any of `globs`? */
export function anyPathMatches(relPaths: string[], globs: string[]): boolean {
  return globs.some((g) => relPaths.some((p) => globMatch(p, g)));
}
