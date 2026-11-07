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
  /** A link, but not to GitHub (with or without a scheme). */
  | "not-github"
  /** The shape is right, but the owner or repository name breaks GitHub's rules. */
  | "invalid-name"
  /** Not owner/repo or a repository link: empty, one part, three parts, spaces, a profile link. */
  | "not-a-repository";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const HTTP_URL = /^https?:\/\//i;
// Any other scheme ("ftp:"), or a mistyped one ("https:/github.com").
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function validName(owner: string, name: string): Result<RepositoryName, RepositoryInputError> {
  const repo = name.endsWith(".git") ? name.slice(0, -".git".length) : name;
  if (owner === "" || repo === "") {
    return err("not-a-repository");
  }
  const valid = OWNER.test(owner) && REPOSITORY.test(repo) && repo !== "." && repo !== "..";
  return valid ? ok({ owner, name: repo }) : err("invalid-name");
}

function fromUrl(input: string): Result<RepositoryName, RepositoryInputError> {
  let url: URL;
  try {
    url = new URL(HTTP_URL.test(input) ? input : `https://${input}`);
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

/**
 * A link: an http(s) URL, or a host typed without a scheme. GitHub owner
 * names can't contain dots, so a dotted first part ("gitlab.com/...",
 * "github.com/...") is a host.
 */
function looksLikeLink(input: string): boolean {
  return HTTP_URL.test(input) || (input.split("/")[0] ?? "").includes(".");
}

/** "owner/repo", "https://github.com/owner/repo[...]" or "github.com/owner/repo". */
export function parseRepositoryInput(text: string): Result<RepositoryName, RepositoryInputError> {
  const input = text.trim();
  if (input === "" || /\s/.test(input)) {
    return err("not-a-repository");
  }
  if (looksLikeLink(input)) {
    return fromUrl(input);
  }
  if (OTHER_SCHEME.test(input)) {
    return err("not-a-repository");
  }
  const [owner, name, ...rest] = input.split("/");
  return owner !== undefined && name !== undefined && rest.length === 0
    ? validName(owner, name)
    : err("not-a-repository");
}
