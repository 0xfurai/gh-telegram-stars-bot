import { describe, expect, it } from "vitest";
import { parseRepositoryInput } from "../src/repo-input";

describe("parseRepositoryInput", () => {
  it.each([
    ["microsoft/vscode", "microsoft", "vscode"],
    ["  facebook/react  ", "facebook", "react"],
    ["owner/repo_with_underscores", "owner", "repo_with_underscores"],
    ["owner/repo.js", "owner", "repo.js"],
    ["my-org/.github", "my-org", ".github"],
    ["https://github.com/facebook/react", "facebook", "react"],
    ["https://github.com/facebook/react/", "facebook", "react"],
    ["https://github.com/facebook/react.git", "facebook", "react"],
    ["https://github.com/facebook/react?tab=readme", "facebook", "react"],
    ["https://github.com/facebook/react#readme", "facebook", "react"],
    ["https://github.com/facebook/react/tree/main/packages", "facebook", "react"],
    ["https://www.github.com/facebook/react", "facebook", "react"],
    ["http://github.com/facebook/react", "facebook", "react"],
    ["HTTPS://GitHub.com/Facebook/React", "Facebook", "React"],
    ["github.com/facebook/react", "facebook", "react"],
  ])("parses %s", (input, owner, name) => {
    expect(parseRepositoryInput(input)).toEqual({ owner, name });
  });

  it.each([
    "",
    "react",
    "yes/no maybe",
    "a/b/c",
    "-owner/repo",
    "owner-/repo",
    "own--er/repo",
    "o".repeat(40) + "/repo",
    "owner/" + "r".repeat(101),
    "owner/.",
    "owner/..",
    "owner/re po",
    "owner/repo!",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner",
    "https://github.com.evil.example/owner/repo",
    "https://evil.example/github.com/owner/repo",
  ])("rejects %j", (input) => {
    expect(parseRepositoryInput(input)).toBeNull();
  });
});
