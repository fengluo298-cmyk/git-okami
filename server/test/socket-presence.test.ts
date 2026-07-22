import test from "node:test";
import assert from "node:assert/strict";
import { SocketPresence } from "../src/socketPresence.js";

test("socket presence keeps a user online until the last socket disconnects", () => {
  const presence = new SocketPresence();

  presence.add("user-a", "socket-a");
  presence.add("user-a", "socket-b");

  assert.equal(presence.has("user-a"), true);
  assert.equal(presence.socketCount("user-a"), 2);
  assert.equal(presence.userCount(), 1);

  presence.remove("user-a", "socket-a");
  assert.equal(presence.has("user-a"), true);
  assert.equal(presence.socketCount("user-a"), 1);

  presence.remove("user-a", "socket-b");
  assert.equal(presence.has("user-a"), false);
  assert.equal(presence.socketCount("user-a"), 0);
  assert.equal(presence.userCount(), 0);
});

test("socket presence tolerates repeated disconnect and releases entries after multiple rounds", () => {
  const presence = new SocketPresence();

  for (let index = 0; index < 5; index += 1) {
    const socketId = `socket-${index}`;
    presence.add("user-a", socketId);
    assert.equal(presence.has("user-a"), true);
    presence.remove("user-a", socketId);
    presence.remove("user-a", socketId);
  }

  presence.remove("missing-user", "missing-socket");
  assert.equal(presence.has("user-a"), false);
  assert.equal(presence.userCount(), 0);
});
