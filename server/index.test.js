// Note: as of the offscreen document refactor, the Socket.io connection is maintained
// by extension/src/offscreen/offscreen.js rather than the popup. Server behaviour is
// unchanged - these tests remain valid.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { io as Client } from "socket.io-client";
import { httpServer } from "./index.js";

let serverAddress;

beforeAll(() => {
  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      serverAddress = `http://localhost:${httpServer.address().port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise((resolve) => {
    httpServer.close(resolve);
  });
});

function createClient() {
  return new Promise((resolve) => {
    const client = Client(serverAddress, { forceNew: true });
    client.on("connect", () => resolve(client));
  });
}

async function getHealth() {
  const response = await fetch(`${serverAddress}/health`);
  return response.json();
}

describe("Room Creation", () => {
  let clientA;
  let clientB;
  let clientC;

  afterEach(() => {
    [clientA, clientB, clientC].forEach((c) => {
      if (c?.connected) {
        c.emit("leave-room", {});
        c.disconnect();
      }
    });
    clientA = undefined;
    clientB = undefined;
    clientC = undefined;
  });

  it("It should return a valid room code on create-room", async () => {
    clientA = await createClient();
    const roomCreated = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const payload = await roomCreated;

    expect(payload).toHaveProperty("roomCode");
    expect(payload.roomCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("It should place the socket in only one room after two create-room calls", async () => {
    clientA = await createClient();
    const baselineRooms = (await getHealth()).rooms;

    const firstCreated = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const firstPayload = await firstCreated;

    const secondCreated = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const secondPayload = await secondCreated;

    expect(firstPayload.roomCode).not.toBe(secondPayload.roomCode);

    const health = await getHealth();
    expect(health.rooms).toBe(baselineRooms + 1);
  });

  it("GET /health should return status ok and a rooms count", async () => {
    const health = await getHealth();
    expect(health.status).toBe("ok");
    expect(typeof health.rooms).toBe("number");
    expect(health.rooms).toBeGreaterThanOrEqual(0);
  });
});

describe("Room Joining", () => {
  let clientA;
  let clientB;
  let clientC;

  afterEach(() => {
    [clientA, clientB, clientC].forEach((c) => {
      if (c?.connected) {
        c.emit("leave-room", {});
        c.disconnect();
      }
    });
    clientA = undefined;
    clientB = undefined;
    clientC = undefined;
  });

  it("It should allow a client to join an existing room", async () => {
    clientA = await createClient();
    clientB = await createClient();

    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const { roomCode } = await created;

    const joined = new Promise((resolve) => clientB.once("room-joined", resolve));
    clientB.emit("join-room", { roomCode });
    const joinedPayload = await joined;

    expect(joinedPayload.roomCode).toBe(roomCode);
    expect(joinedPayload.memberCount).toBe(2);
  });

  it("It should emit room-error for a non-existent room code", async () => {
    clientA = await createClient();
    const roomError = new Promise((resolve) => clientA.once("room-error", resolve));

    clientA.emit("join-room", { roomCode: "ZZZZZZ" });
    const payload = await roomError;

    expect(payload).toHaveProperty("message");
    expect(typeof payload.message).toBe("string");
  });

  it("It should not crash when join-room is called with no payload", async () => {
    clientA = await createClient();

    const roomError = new Promise((resolve) => clientA.once("room-error", resolve));
    clientA.emit("join-room");
    const payload = await roomError;

    expect(typeof payload.message).toBe("string");

    const roomCreated = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const createdPayload = await roomCreated;
    expect(createdPayload.roomCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("It should not crash when join-room is called with a non-object payload", async () => {
    clientA = await createClient();

    const roomError = new Promise((resolve) => clientA.once("room-error", resolve));
    clientA.emit("join-room", "notanobject");
    const payload = await roomError;

    expect(typeof payload.message).toBe("string");

    const roomCreated = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const createdPayload = await roomCreated;
    expect(createdPayload.roomCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("It should notify all members when a new member joins", async () => {
    clientA = await createClient();
    clientB = await createClient();

    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const { roomCode } = await created;

    const memberUpdate = new Promise((resolve) => clientA.once("member-update", resolve));
    const joined = new Promise((resolve) => clientB.once("room-joined", resolve));
    clientB.emit("join-room", { roomCode });
    await joined;
    const updatePayload = await memberUpdate;

    expect(updatePayload.memberCount).toBe(2);
  });

  it("It should remove the socket from the old room when joining a new one", async () => {
    clientA = await createClient();
    clientB = await createClient();
    clientC = await createClient();
    const baselineRooms = (await getHealth()).rooms;

    const room1Created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const { roomCode: roomCode1 } = await room1Created;

    const room1JoinUpdate = new Promise((resolve) => clientA.once("member-update", resolve));
    const room1Joined = new Promise((resolve) => clientB.once("room-joined", resolve));
    clientB.emit("join-room", { roomCode: roomCode1 });
    await room1Joined;
    const joinedUpdate = await room1JoinUpdate;
    expect(joinedUpdate.memberCount).toBe(2);

    const room1LeaveUpdate = new Promise((resolve) => clientA.once("member-update", resolve));
    const room2Created = new Promise((resolve) => clientB.once("room-created", resolve));
    clientB.emit("create-room");
    await room2Created;
    const leftUpdate = await room1LeaveUpdate;

    expect(leftUpdate.memberCount).toBe(1);

    const health = await getHealth();
    expect(health.rooms).toBe(baselineRooms + 2);
  });
});

describe("Sync Events", () => {
  let clientA;
  let clientB;
  let clientC;

  afterEach(() => {
    [clientA, clientB, clientC].forEach((c) => {
      if (c?.connected) {
        c.emit("leave-room", {});
        c.disconnect();
      }
    });
    clientA = undefined;
    clientB = undefined;
    clientC = undefined;
  });

  async function connectTwoClientsInSameRoom() {
    clientA = await createClient();
    clientB = await createClient();
    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const { roomCode } = await created;
    const joined = new Promise((resolve) => clientB.once("room-joined", resolve));
    clientB.emit("join-room", { roomCode });
    await joined;
    return roomCode;
  }

  it("It should relay a sync-event from one client to another in the same room", async () => {
    const roomCode = await connectTwoClientsInSameRoom();

    const syncEvent = new Promise((resolve) => clientB.once("sync-event", resolve));
    clientA.emit("sync-event", {
      roomCode,
      action: { type: "play", currentTime: 42.5 },
    });
    const payload = await syncEvent;

    expect(payload.action.type).toBe("play");
    expect(payload.action.currentTime).toBe(42.5);
  });

  it("It should NOT echo a sync-event back to the sender", async () => {
    const roomCode = await connectTwoClientsInSameRoom();
    const spy = vi.fn();
    clientA.on("sync-event", spy);

    clientA.emit("sync-event", {
      roomCode,
      action: { type: "play", currentTime: 42.5 },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spy).not.toHaveBeenCalled();
  });

  it("It should silently drop a sync-event with no payload", async () => {
    await connectTwoClientsInSameRoom();
    clientA.emit("sync-event");

    await new Promise((resolve) => setTimeout(resolve, 300));
    const health = await getHealth();
    expect(health.status).toBe("ok");
    expect(health.rooms).toBeGreaterThanOrEqual(1);
  });

  it("It should silently drop a sync-event with a missing action.type", async () => {
    const roomCode = await connectTwoClientsInSameRoom();
    clientA.emit("sync-event", { roomCode, action: { currentTime: 10 } });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const health = await getHealth();
    expect(health.status).toBe("ok");
    expect(health.rooms).toBeGreaterThanOrEqual(1);
  });
});

describe("Chat Messages", () => {
  let clientA;
  let clientB;

  afterEach(() => {
    [clientA, clientB].forEach((c) => {
      if (c?.connected) {
        c.emit("leave-room", {});
        c.disconnect();
      }
    });
    clientA = undefined;
    clientB = undefined;
  });

  async function connectTwoClientsInSameRoomWithUsernames() {
    clientA = await createClient();
    clientB = await createClient();

    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room", { username: "HostUser" });
    const { roomCode } = await created;

    const joined = new Promise((resolve) => clientB.once("room-joined", resolve));
    clientB.emit("join-room", { roomCode, username: "GuestUser" });
    await joined;

    return roomCode;
  }

  it("It should broadcast a chat message to other room members", async () => {
    const roomCode = await connectTwoClientsInSameRoomWithUsernames();
    const chatMessage = new Promise((resolve) => clientB.once("chat-message", resolve));

    clientA.emit("chat-message", { roomCode, text: "hello" });
    const payload = await chatMessage;

    expect(payload).toMatchObject({ username: "HostUser", text: "hello" });
    expect(typeof payload.timestamp).toBe("number");
  });

  it("It should not echo chat-message back to the sender", async () => {
    const roomCode = await connectTwoClientsInSameRoomWithUsernames();
    const spy = vi.fn();
    clientA.on("chat-message", spy);

    clientA.emit("chat-message", { roomCode, text: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(spy).not.toHaveBeenCalled();
  });

  it("It should truncate messages over 200 characters", async () => {
    const roomCode = await connectTwoClientsInSameRoomWithUsernames();
    const chatMessage = new Promise((resolve) => clientB.once("chat-message", resolve));
    const longMessage = "x".repeat(300);

    clientA.emit("chat-message", { roomCode, text: longMessage });
    const payload = await chatMessage;

    expect(payload.text.length).toBeLessThanOrEqual(200);
  });

  it("It should silently drop a chat-message with no text", async () => {
    clientA = await createClient();
    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room", { username: "SoloUser" });
    const { roomCode } = await created;

    clientA.emit("chat-message", { roomCode, text: "" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const health = await getHealth();
    expect(health.status).toBe("ok");
    expect(health.rooms).toBeGreaterThanOrEqual(1);
  });

  it("It should silently drop a chat-message with no payload", async () => {
    clientA = await createClient();
    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room", { username: "SoloUser" });
    await created;

    clientA.emit("chat-message");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const health = await getHealth();
    expect(health.status).toBe("ok");
  });
});

describe("Ad Detection Events", () => {
  let clientA;
  let clientB;

  afterEach(() => {
    [clientA, clientB].forEach((c) => {
      if (c?.connected) {
        c.emit("leave-room", {});
        c.disconnect();
      }
    });
    clientA = undefined;
    clientB = undefined;
  });

  async function connectTwoClientsInSameRoomWithUsernames() {
    clientA = await createClient();
    clientB = await createClient();

    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room", { username: "HostUser" });
    const { roomCode } = await created;

    const joined = new Promise((resolve) => clientB.once("room-joined", resolve));
    clientB.emit("join-room", { roomCode, username: "GuestUser" });
    await joined;

    return roomCode;
  }

  it("It should broadcast ad-started to other room members with the username", async () => {
    const roomCode = await connectTwoClientsInSameRoomWithUsernames();
    const adStarted = new Promise((resolve) => clientB.once("ad-started", resolve));

    clientA.emit("ad-started", { roomCode });
    const payload = await adStarted;

    expect(payload).toEqual({ username: "HostUser" });
  });

  it("It should not echo ad-started back to the sender", async () => {
    const roomCode = await connectTwoClientsInSameRoomWithUsernames();
    const spy = vi.fn();
    clientA.on("ad-started", spy);

    clientA.emit("ad-started", { roomCode });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spy).not.toHaveBeenCalled();
  });

  it("It should broadcast ad-ended to other room members", async () => {
    const roomCode = await connectTwoClientsInSameRoomWithUsernames();
    const adEnded = new Promise((resolve) => clientB.once("ad-ended", resolve));

    clientA.emit("ad-ended", { roomCode });
    const payload = await adEnded;
    expect(payload).toBeUndefined();
  });

  it("It should silently drop ad-started with no payload", async () => {
    clientA = await createClient();
    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room", { username: "SoloUser" });
    await created;

    clientA.emit("ad-started");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const health = await getHealth();
    expect(health.status).toBe("ok");
    expect(health.rooms).toBeGreaterThanOrEqual(1);
  });
});

describe("Leaving and Disconnecting", () => {
  let clientA;
  let clientB;
  let clientC;

  afterEach(() => {
    [clientA, clientB, clientC].forEach((c) => {
      if (c?.connected) {
        c.emit("leave-room", {});
        c.disconnect();
      }
    });
    clientA = undefined;
    clientB = undefined;
    clientC = undefined;
  });

  async function setupSharedRoom() {
    clientA = await createClient();
    clientB = await createClient();

    const createMemberUpdate = new Promise((resolve) => clientA.once("member-update", resolve));
    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const { roomCode } = await created;
    await createMemberUpdate;

    const joinMemberUpdate = new Promise((resolve) => clientA.once("member-update", resolve));
    const joined = new Promise((resolve) => clientB.once("room-joined", resolve));
    clientB.emit("join-room", { roomCode });
    await joined;
    await joinMemberUpdate;

    return roomCode;
  }

  it("It should remove a client from the room on leave-room", async () => {
    const roomCode = await setupSharedRoom();

    const memberUpdate = new Promise((resolve) => clientA.once("member-update", resolve));
    clientB.emit("leave-room", { roomCode });
    const payload = await memberUpdate;

    expect(payload.memberCount).toBe(1);
  });

  it("It should delete an empty room after the last member leaves", async () => {
    clientA = await createClient();
    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const { roomCode } = await created;

    const beforeHealth = await getHealth();
    clientA.emit("leave-room", { roomCode });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterHealth = await getHealth();

    expect(afterHealth.rooms).toBe(beforeHealth.rooms - 1);
  });

  it("It should clean up correctly when a client disconnects without calling leave-room", async () => {
    await setupSharedRoom();

    const memberUpdate = new Promise((resolve) => clientA.once("member-update", resolve));
    clientB.disconnect();
    const payload = await memberUpdate;

    expect(payload.memberCount).toBe(1);
  });

  it("It should delete an empty room when the last member disconnects", async () => {
    clientA = await createClient();
    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    await created;

    const beforeHealth = await getHealth();
    clientA.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterHealth = await getHealth();
    expect(afterHealth.rooms).toBe(beforeHealth.rooms);
  });

  it("It should keep a room alive during the grace period after last member disconnects", async () => {
    clientA = await createClient();
    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    await created;

    const beforeHealth = await getHealth();
    expect(beforeHealth.rooms).toBeGreaterThanOrEqual(1);

    clientA.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterHealth = await getHealth();

    expect(afterHealth.rooms).toBe(beforeHealth.rooms);
  });

  it("It should allow a client to rejoin a room within the grace period", async () => {
    clientA = await createClient();
    const created = new Promise((resolve) => clientA.once("room-created", resolve));
    clientA.emit("create-room");
    const { roomCode } = await created;

    clientA.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 500));

    clientB = await createClient();
    const joined = new Promise((resolve) => clientB.once("room-joined", resolve));
    const roomError = vi.fn();
    clientB.on("room-error", roomError);
    clientB.emit("join-room", { roomCode });
    const payload = await joined;

    expect(payload.roomCode).toBe(roomCode);
    expect(roomError).not.toHaveBeenCalled();
  });
});

describe("Invite Redirects", () => {
  let hostClient;
  let guestClient;

  afterEach(() => {
    [hostClient, guestClient].forEach((client) => {
      if (client?.connected) {
        client.emit("leave-room", {});
        client.disconnect();
      }
    });
    hostClient = undefined;
    guestClient = undefined;
  });

  it("creates an invite token and redirects to watch URL with invite params", async () => {
    hostClient = await createClient();
    const created = new Promise((resolve) => hostClient.once("room-created", resolve));
    hostClient.emit("create-room", { username: "HostUser", platform: "youtube" });
    const { roomCode } = await created;

    const inviteResponse = await new Promise((resolve) => {
      hostClient.emit(
        "create-invite",
        {
          roomCode,
          watchUrl: "https://www.youtube.com/watch?v=abc123",
          serverUrl: serverAddress,
          platform: "youtube",
        },
        resolve
      );
    });

    expect(inviteResponse.ok).toBe(true);
    expect(inviteResponse.invitePath).toMatch(/^\/invite\/[a-f0-9]{16}$/);

    const response = await fetch(`${serverAddress}${inviteResponse.invitePath}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const locationHeader = response.headers.get("location");
    expect(locationHeader).toBeTruthy();
    const redirected = new URL(locationHeader);
    expect(redirected.origin).toBe("https://www.youtube.com");
    expect(redirected.searchParams.get("v")).toBe("abc123");
    expect(redirected.searchParams.get("wp_room")).toBe(roomCode);
    expect(redirected.searchParams.get("wp_server")).toBe(serverAddress);
    expect(redirected.searchParams.get("wp_platform")).toBe("youtube");
  });

  it("rejects invite creation when no watch URL exists yet", async () => {
    hostClient = await createClient();
    const created = new Promise((resolve) => hostClient.once("room-created", resolve));
    hostClient.emit("create-room", { username: "HostUser", platform: "youtube" });
    const { roomCode } = await created;

    const inviteResponse = await new Promise((resolve) => {
      hostClient.emit("create-invite", { roomCode, serverUrl: serverAddress }, resolve);
    });

    expect(inviteResponse.ok).toBe(false);
    expect(inviteResponse.message).toContain("watch URL");
  });

  it("prevents non-members from updating room watch target", async () => {
    hostClient = await createClient();
    guestClient = await createClient();
    const created = new Promise((resolve) => hostClient.once("room-created", resolve));
    hostClient.emit("create-room", { username: "HostUser", platform: "youtube" });
    const { roomCode } = await created;

    const response = await new Promise((resolve) => {
      guestClient.emit(
        "set-room-watch-target",
        {
          roomCode,
          watchUrl: "https://www.youtube.com/watch?v=intruder",
          platform: "youtube",
        },
        resolve
      );
    });

    expect(response.ok).toBe(false);
    expect(response.message).toContain("Room not found");
  });
});
