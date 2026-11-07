// Parses what users type for a repository: "owner/repo" or a GitHub URL.
//
// Strict on purpose: plain text that happens to contain a slash ("yes/no",
// "and/or") must not trigger a GitHub lookup. Names follow GitHub's rules:
// owners are 1-39 letters, digits or single hyphens (not at either end);
// repositories are 1-100 letters, digits, "-", "_" or ".", but not "." or "..".

export interface RepositoryName {
  owner: string;
  name: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

function validName(owner: string, name: string): RepositoryName | null {
  const repo = name.endsWith(".git") ? name.slice(0, -".git".length) : name;
  if (!OWNER.test(owner) || !REPOSITORY.test(repo) || repo === "." || repo === "..") {
    return null;
  }
  return { owner, name: repo };
}

function fromUrl(input: string): RepositoryName | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }
  // github.com/owner/repo, optionally followed by /tree/main, /issues, ...
  const [owner = "", name = ""] = url.pathname.split("/").filter((part) => part !== "");
  return validName(owner, name);
}

/** "owner/repo", "https://github.com/owner/repo[...]" or "github.com/owner/repo". */
export function parseRepositoryInput(text: string): RepositoryName | null {
  const input = text.trim();
  if (input === "" || /\s/.test(input)) {
    return null;
  }
  if (/github\.com\//i.test(input)) {
    return fromUrl(input);
  }
  const parts = input.split("/");
  return parts.length === 2 ? validName(parts[0] ?? "", parts[1] ?? "") : null;
}
