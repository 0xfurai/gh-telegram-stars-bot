import { describe, expect, it } from "vitest";
import { parseRepositoryInput, type RepositoryInputError } from "../src/repo-input";
import { err, ok } from "../src/result";

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
    expect(parseRepositoryInput(input)).toEqual(ok({ owner, name }));
  });

  it.each<[string, RepositoryInputError]>([
    ["", "empty"],
    ["   ", "empty"],
    ["react", "not-a-repository"],
    ["yes/no maybe", "not-a-repository"],
    ["a/b/c", "not-a-repository"],
    ["https://github.com/owner", "not-a-repository"],
    ["https://github.com.evil.example/owner/repo", "not-github"],
    ["-owner/repo", "invalid-name"],
    ["owner-/repo", "invalid-name"],
    ["own--er/repo", "invalid-name"],
    ["o".repeat(40) + "/repo", "invalid-name"],
    ["owner/" + "r".repeat(101), "invalid-name"],
    ["owner/.", "invalid-name"],
    ["owner/..", "invalid-name"],
    ["owner/repo!", "invalid-name"],
    ["https://github.com/-owner/repo", "invalid-name"],
    ["https://gitlab.com/owner/repo", "not-github"],
    ["https://evil.example/github.com/owner/repo", "not-github"],
  ])("rejects %j as %s", (input, reason) => {
    expect(parseRepositoryInput(input)).toEqual(err(reason));
  });
});
