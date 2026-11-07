// Parses what users type for a repository: "owner/repo" or a GitHub URL.
//
// Strict on purpose: plain text that happens to contain a slash ("yes/no"
// with spaces around, "a/b/c") must not trigger a GitHub lookup. Names follow
// GitHub's rules: owners are 1-39 letters, digits or single hyphens (not at
// either end); repositories are 1-100 letters, digits, "-", "_" or ".", but
// not "." or "..".
import { err, ok, type Result } from "./result";

export interface RepositoryName {
  owner: string;
  name: string;
}

/** Why the input isn't a repository; each gets its own reply. */
export type RepositoryInputError =
  /** Nothing was given. */
  | "empty"
  /** A URL, but not on GitHub. */
  | "not-github"
  /** The shape is right, but the owner or repository name breaks GitHub's rules. */
  | "invalid-name"
  /** Not owner/repo or a repository URL (one part, three parts, spaces, a profile URL). */
  | "not-a-repository";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

function validName(owner: string, name: string): Result<RepositoryName, RepositoryInputError> {
  const repo = name.endsWith(".git") ? name.slice(0, -".git".length) : name;
  const valid = OWNER.test(owner) && REPOSITORY.test(repo) && repo !== "." && repo !== "..";
  return valid ? ok({ owner, name: repo }) : err("invalid-name");
}

function fromUrl(input: string): Result<RepositoryName, RepositoryInputError> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return err("not-a-repository");
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
    return err("not-github");
  }
  // github.com/owner/repo, optionally followed by /tree/main, /issues, ...
  const [owner, name] = url.pathname.split("/").filter((part) => part !== "");
  return owner !== undefined && name !== undefined ? validName(owner, name) : err("not-a-repository");
}

/** "owner/repo", "https://github.com/owner/repo[...]" or "github.com/owner/repo". */
export function parseRepositoryInput(text: string): Result<RepositoryName, RepositoryInputError> {
  const input = text.trim();
  if (input === "") {
    return err("empty");
  }
  if (/\s/.test(input)) {
    return err("not-a-repository");
  }
  // Any http(s) URL, or "github.com/..." without a scheme.
  if (/^https?:\/\//i.test(input) || /github\.com\//i.test(input)) {
    return fromUrl(input);
  }
  const [owner, name, ...rest] = input.split("/");
  return owner !== undefined && name !== undefined && rest.length === 0
    ? validName(owner, name)
    : err("not-a-repository");
}
