import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { parseDockerEnv } from "../src/deploy.js";

test("parses only whitelisted container variables and keeps equals in values", () => {
  const token = `${randomBytes(24).toString("base64url")}==`;
  const cloudId = randomUUID();
  const parsed = parseDockerEnv(JSON.stringify([
    `ATLASSIAN_CLOUD_ID=${cloudId}`,
    `ATLASSIAN_API_TOKEN=${token}`,
    "ATLASSIAN_EMAIL=media-test@example.invalid",
    "ATLASSIAN_SITE_URL=https://example.atlassian.net",
    "ATLASSIAN_AUTH_MODE=scoped",
    "UNRELATED_SECRET=excluded",
    "ATLASSIAN_API_TOKEN_EXPIRES_ON=2032-01-01T00:00:00Z",
  ]));

  assert.deepEqual(parsed, {
    ATLASSIAN_CLOUD_ID: cloudId,
    ATLASSIAN_API_TOKEN: token,
    ATLASSIAN_EMAIL: "media-test@example.invalid",
    ATLASSIAN_SITE_URL: "https://example.atlassian.net",
    ATLASSIAN_AUTH_MODE: "scoped",
    ATLASSIAN_API_TOKEN_EXPIRES_ON: "2032-01-01T00:00:00Z",
  });
});

test("ignores unrelated and malformed lines when parsing plain Docker environment text", () => {
  const parsed = parseDockerEnv("ATLASSIAN_EMAIL=media-test@example.invalid\nnot-an-assignment\nHOME=/tmp\n");
  assert.deepEqual(parsed, { ATLASSIAN_EMAIL: "media-test@example.invalid" });
});
