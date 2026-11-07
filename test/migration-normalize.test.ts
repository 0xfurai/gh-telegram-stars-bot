import { describe, expect, it } from "vitest";
import { normalizeExport } from "../scripts/migration/normalize";

const NOW = "2026-11-07T10:00:00.000Z";
const T = "2025-09-06T20:37:27+00:00";

describe("normalizeExport", () => {
  it("fills nullable columns with the old schema's defaults", () => {
    const data = normalizeExport(
      {
        chats: [{ id: 1, is_active: null, created_at: null, updated_at: null }],
        repositories: [
          { id: 1, github_id: 10, full_name: "a/b", description: null, html_url: "u", stars_count: null, is_archived: null, created_at: null, updated_at: null },
        ],
        subscriptions: [{ chat_id: 1, repository_id: 1, created_at: null }],
        starEvents: [{ repository_id: 1, stars_count: 2, previous_stars_count: 1, created_at: null }],
      },
      NOW,
    );

    expect(data).toEqual({
      chats: [{ id: 1, is_active: true, created_at: NOW, updated_at: NOW }],
      repositories: [
        { id: 1, github_id: 10, full_name: "a/b", description: null, html_url: "u", stars_count: 0, is_archived: false, created_at: NOW, updated_at: NOW },
      ],
      subscriptions: [{ chat_id: 1, repository_id: 1, created_at: NOW }],
      starEvents: [{ repository_id: 1, stars_count: 2, previous_stars_count: 1, created_at: NOW }],
    });
  });

  it("keeps values that are set, false included", () => {
    const data = normalizeExport(
      {
        chats: [{ id: 1, is_active: false, created_at: T, updated_at: T }],
        repositories: [],
        subscriptions: [],
        starEvents: [],
      },
      NOW,
    );

    expect(data.chats).toEqual([{ id: 1, is_active: false, created_at: T, updated_at: T }]);
  });

  it("drops subscriptions and star events that refer to nothing", () => {
    const data = normalizeExport(
      {
        chats: [],
        repositories: [],
        subscriptions: [
          { chat_id: null, repository_id: 1, created_at: T },
          { chat_id: 1, repository_id: null, created_at: T },
        ],
        starEvents: [{ repository_id: null, stars_count: 2, previous_stars_count: 1, created_at: T }],
      },
      NOW,
    );

    expect(data.subscriptions).toEqual([]);
    expect(data.starEvents).toEqual([]);
  });
});
