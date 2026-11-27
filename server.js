const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// ルームごとの参加者と作成者を管理
const rooms = new Map();
const roomOwners = new Map();
// ルームごとの入室禁止ユーザー名
const roomBans = new Map();
const roomSettings = new Map();
const roomWarnings = new Map();
// ルームごとのお知らせ
const roomAnnouncements = new Map();
// ルームごとの管理者投票と厳重注意回数
const roomModerationVotes = new Map();
const roomVoteWarnings = new Map();
const roomChatMessages = new Map();

function broadcastPresence(roomName) {
  const users = rooms.get(roomName);
  if (!users) return;
  const presence = Array.from(users.entries()).map(([id, username]) => {
    const member = io.sockets.sockets.get(id);
    return { username, status: member && member.presenceStatus === "away" ? "away" : "online" };
  });
  io.to(roomName).emit("roomPresence", presence);
}

function defaultRoomSettings() {
  return { password: "", profanityFilter: false, sexualFilter: false, maxWarnings: 3 };
}
const PROFANITY_PATTERNS = [/死ね/i, /消えろ/i, /くたばれ/i, /きもい/i, /キモい/i, /うざい/i, /バカ/i, /ばか/i, /アホ/i, /あほ/i, /クソ/i, /くそ/i];
const SEXUAL_PATTERNS = [/下ネタ/i, /エロい?/i, /えろい?/i, /セックス/i, /裸になれ/i, /性的/i];
function blockedCategory(message, settings) {
  if (settings.profanityFilter && PROFANITY_PATTERNS.some(p => p.test(message))) return "暴言";
  if (settings.sexualFilter && SEXUAL_PATTERNS.some(p => p.test(message))) return "下ネタ・性的な表現";
  return "";
}

io.on("connection", (socket) => {
  console.log("ユーザーが接続しました");

  function sendRoomList() {
    const roomList = [];
    for (const [roomName, users] of rooms) {
      roomList.push({
        name: roomName,
        users: Array.from(users.values()),
        count: users.size,
        hasPassword: Boolean(roomSettings.get(roomName)?.password)
      });
    }
    io.emit("roomList", roomList);
  }

  // ルームから退出させる共通処理
  function removeFromRoom(targetSocket, notice) {
    const roomName = targetSocket.room;
    if (!roomName) return;

    const activePoll = roomModerationVotes.get(roomName);
    if (activePoll && (activePoll.ownerId === targetSocket.id || activePoll.targetId === targetSocket.id)) {
      roomModerationVotes.delete(roomName);
      io.to(roomName).emit("moderationVoteCancelled", "投票の開始者または対象者が退出したため、投票を中止しました");
    } else if (activePoll && activePoll.eligibleIds.delete(targetSocket.id)) {
      io.to(roomName).emit("moderationVoteChanged");
    }

    const users = rooms.get(roomName);
    if (users) {
      users.delete(targetSocket.id);
      targetSocket.leave(roomName);
      targetSocket.room = null;

      if (users.size === 0) {
        rooms.delete(roomName);
        roomOwners.delete(roomName);
        roomBans.delete(roomName);
        roomSettings.delete(roomName);
        roomWarnings.delete(roomName);
        roomAnnouncements.delete(roomName);
        roomModerationVotes.delete(roomName);
        roomVoteWarnings.delete(roomName);
        roomChatMessages.delete(roomName);
      } else {
        if (roomOwners.get(roomName) === targetSocket.id) {
          const newOwnerId = users.keys().next().value;
          roomOwners.set(roomName, newOwnerId);
          const settings = roomSettings.get(roomName) || defaultRoomSettings();
          io.to(newOwnerId).emit("roomSettingsData", {
            isOwner: true,
            passwordEnabled: Boolean(settings.password),
            profanityFilter: settings.profanityFilter,
            sexualFilter: settings.sexualFilter,
            maxWarnings: settings.maxWarnings
          });
          io.to(newOwnerId).emit("announcementOwnerChanged", true);
        }
        if (notice) {
          io.to(roomName).emit("systemMessage", { message: notice });
        }
      }
    }
    sendRoomList();
    broadcastPresence(roomName);
  }

  socket.on("createRoom", (roomName) => {
    roomName = String(roomName || "").trim();

    if (!roomName) {
      socket.emit("roomError", "ルーム名を入力してください");
      return;
    }
    if (rooms.has(roomName)) {
      socket.emit("roomError", "そのルームはすでにあります");
      return;
    }

    rooms.set(roomName, new Map());
    roomOwners.set(roomName, socket.id);
    roomBans.set(roomName, new Set());
    roomSettings.set(roomName, defaultRoomSettings());
    roomWarnings.set(roomName, new Map());
    roomAnnouncements.set(roomName, []);
    roomVoteWarnings.set(roomName, new Map());
    roomChatMessages.set(roomName, new Map());

    console.log(`ルーム作成: ${roomName}`);
    socket.emit("roomCreated", roomName);
    sendRoomList();
  });

  socket.on("setUsername", (name) => {
    socket.username = String(name || "").trim();
  });

  socket.on("getRoomPasswords", () => {
    if (String(socket.username || "").trim() !== "たい焼き") {
      socket.emit("roomPasswordsError", "権限がありません");
      return;
    }
    const result = [];
    for (const [roomName, users] of rooms) {
      const password = roomSettings.get(roomName)?.password || "";
      result.push({
        roomName,
        password: password ? password : "パスワード未設定"
      });
    }
    socket.emit("roomPasswordsData", result);
  });

  socket.on("getRooms", () => sendRoomList());

  // 「たい焼き」だけがルーム一覧からルーム全体を削除できる
  socket.on("deleteRoom", (data = {}) => {
    const requestedUsername = String(data.username || socket.username || "").trim();
    if (requestedUsername !== "たい焼き") {
      socket.emit("deleteRoomError", "権限がありません");
      return;
    }
    socket.username = requestedUsername;

    const roomName = String(data.roomName || "").trim();
    const users = rooms.get(roomName);
    if (!roomName || !users) {
      socket.emit("deleteRoomError", "削除するルームが見つかりません");
      return;
    }

    io.to(roomName).emit("roomDeleted", {
      room: roomName,
      message: "「" + roomName + "」は「たい焼き」によって削除されました"
    });

    for (const id of users.keys()) {
      const member = io.sockets.sockets.get(id);
      if (member) {
        member.leave(roomName);
        member.room = null;
      }
    }

    rooms.delete(roomName);
    roomOwners.delete(roomName);
    roomBans.delete(roomName);
    roomSettings.delete(roomName);
    roomWarnings.delete(roomName);
    roomAnnouncements.delete(roomName);
    roomModerationVotes.delete(roomName);
    roomVoteWarnings.delete(roomName);
    roomChatMessages.delete(roomName);

    sendRoomList();
    socket.emit("deleteRoomSuccess", roomName);
  });

  socket.on("presenceUpdate", (status) => {
    if (!socket.room) return;
    socket.presenceStatus = status === "away" ? "away" : "online";
    broadcastPresence(socket.room);
  });

  socket.on("markMessageRead", (messageId) => {
    if (!socket.room) return;
    const messages = roomChatMessages.get(socket.room);
    const item = messages && messages.get(String(messageId));
    if (!item || item.senderId === socket.id || item.readBy.has(socket.id)) return;
    item.readBy.add(socket.id);
    io.to(socket.room).emit("messageReadCount", { messageId: item.id, readCount: item.readBy.size });
  });

  socket.on("joinRoom", ({ username, room, password = "" }) => {
    username = String(username || "").trim();
    room = String(room || "").trim();
    socket.username = username;

    if (!username) {
      socket.emit("roomError", "ユーザー名を入力してください");
      return;
    }
    if (!room) {
      socket.emit("roomError", "ルームを選択してください");
      return;
    }
    if (!rooms.has(room)) {
      socket.emit("roomError", "そのルームはありません");
      return;
    }

    const settings = roomSettings.get(room) || defaultRoomSettings();
    if (settings.password && String(password) !== settings.password) {
      socket.emit("passwordRequired", room);
      return;
    }

    // 退去コマンドで入室禁止になったユーザーは再入室できない
    const bannedNames = roomBans.get(room);
    if (bannedNames && bannedNames.has(username)) {
      socket.emit("roomError", "このルームへの入室は禁止されています");
      return;
    }

    if (socket.room) {
      removeFromRoom(socket, `${socket.username}さんが退出しました`);
    }

    socket.username = username;
    socket.room = room;
    socket.join(room);

    const users = rooms.get(room);
    users.set(socket.id, username);

    console.log(`${username} が ${room} に入室`);
    socket.emit("roomJoined", room);
    socket.presenceStatus = "online";
    socket.to(room).emit("systemMessage", {
      message: `${username}さんが入室しました`
    });
    sendRoomList();
    broadcastPresence(room);
  });

  function publicModerationVote(roomName, viewerId) {
    const poll = roomModerationVotes.get(roomName);
    if (!poll) return null;
    const counts = { support: 0, oppose: 0, warning: 0 };
    for (const choice of poll.votes.values()) counts[choice]++;
    return {
      id: poll.id,
      targetName: poll.targetName,
      counts,
      eligibleCount: poll.eligibleIds.size,
      votedCount: poll.votes.size,
      canVote: poll.eligibleIds.has(viewerId) && !poll.votes.has(viewerId),
      hasVoted: poll.votes.has(viewerId),
      isOwner: roomOwners.get(roomName) === viewerId
    };
  }

  socket.on("getModerationVote", () => {
    if (!socket.room) return;
    socket.emit("moderationVoteData", publicModerationVote(socket.room, socket.id));
  });

  socket.on("startModerationVote", (targetNameRaw) => {
    const roomName = socket.room;
    if (!roomName || roomOwners.get(roomName) !== socket.id) {
      socket.emit("moderationVoteError", "投票を開始できるのはルームオーナーだけです");
      return;
    }
    if (roomModerationVotes.has(roomName)) {
      socket.emit("moderationVoteError", "すでに進行中の投票があります");
      return;
    }
    const targetName = String(targetNameRaw || "").trim();
    if (!targetName) {
      socket.emit("moderationVoteError", "対象者のユーザー名を入力してください");
      return;
    }
    const users = rooms.get(roomName);
    const targets = users ? Array.from(users.entries()).filter(([id, name]) => name === targetName) : [];
    if (targets.length === 0) {
      socket.emit("moderationVoteError", "そのユーザーはこのルームにいません");
      return;
    }
    if (targets.length > 1) {
      socket.emit("moderationVoteError", "同じ名前の参加者が複数いるため、投票を開始できません");
      return;
    }
    if (targets[0][0] === socket.id) {
      socket.emit("moderationVoteError", "自分自身を対象にした投票は開始できません");
      return;
    }
    const eligibleIds = new Set(Array.from(users.keys()).filter(id => id !== targets[0][0]));
    if (eligibleIds.size === 0) {
      socket.emit("moderationVoteError", "投票できる参加者がいません");
      return;
    }
    roomModerationVotes.set(roomName, {
      id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
      targetId: targets[0][0],
      targetName,
      ownerId: socket.id,
      eligibleIds,
      votes: new Map()
    });
    io.to(roomName).emit("moderationVoteChanged");
    io.to(roomName).emit("systemMessage", { message: targetName + "さんについて、ルームオーナーが管理投票を開始しました" });
  });

  socket.on("castModerationVote", (choice) => {
    const roomName = socket.room;
    const poll = roomName && roomModerationVotes.get(roomName);
    if (!poll || !poll.eligibleIds.has(socket.id)) {
      socket.emit("moderationVoteError", "この投票には参加できません");
      return;
    }
    if (poll.votes.has(socket.id)) {
      socket.emit("moderationVoteError", "投票は1人1回までです");
      return;
    }
    if (!["support", "oppose", "warning"].includes(choice)) {
      socket.emit("moderationVoteError", "無効な投票です");
      return;
    }
    poll.votes.set(socket.id, choice);
    io.to(roomName).emit("moderationVoteChanged");
  });

  socket.on("closeModerationVote", () => {
    const roomName = socket.room;
    const poll = roomName && roomModerationVotes.get(roomName);
    if (!poll || roomOwners.get(roomName) !== socket.id || poll.ownerId !== socket.id) {
      socket.emit("moderationVoteError", "投票を終了できるのは投票を開始したルームオーナーだけです");
      return;
    }
    if (poll.votes.size < poll.eligibleIds.size) {
      socket.emit("moderationVoteError", "オーナーを含む全員の投票が終わってから結果を確定してください");
      return;
    }

    const counts = { support: 0, oppose: 0, warning: 0 };
    for (const choice of poll.votes.values()) counts[choice]++;
    const total = poll.votes.size;
    let outcome = "no_majority";
    if (total > 0 && counts.support > total / 2) outcome = "ban";
    else if (total > 0 && counts.oppose > total / 2) outcome = "safe";
    else if (total > 0 && counts.warning > total / 2) outcome = "warning";

    roomModerationVotes.delete(roomName);
    let warningCount = roomVoteWarnings.get(roomName) || new Map();
    roomVoteWarnings.set(roomName, warningCount);
    let shouldBan = outcome === "ban";
    if (outcome === "warning") {
      const nextCount = (warningCount.get(poll.targetName) || 0) + 1;
      warningCount.set(poll.targetName, nextCount);
      if (nextCount >= 3) shouldBan = true;
      io.to(roomName).emit("moderationVoteResult", {
        outcome: shouldBan ? "ban_after_warnings" : "warning",
        targetName: poll.targetName,
        counts,
        warningCount: nextCount
      });
    } else {
      io.to(roomName).emit("moderationVoteResult", {
        outcome,
        targetName: poll.targetName,
        counts,
        warningCount: warningCount.get(poll.targetName) || 0
      });
    }

    if (shouldBan) {
      if (!roomBans.has(roomName)) roomBans.set(roomName, new Set());
      roomBans.get(roomName).add(poll.targetName);
      const targetSocket = io.sockets.sockets.get(poll.targetId);
      if (targetSocket && targetSocket.room === roomName) {
        targetSocket.emit("kicked", {
          room: roomName,
          message: "ルーム内の投票結果により、このルームから追放されました。"
        });
        removeFromRoom(targetSocket, poll.targetName + "さんが投票結果により追放されました");
      }
    } else if (outcome === "warning") {
      io.to(roomName).emit("systemMessage", {
        message: poll.targetName + "さんは厳重注意です（" + warningCount.get(poll.targetName) + "/3回）"
      });
    } else if (outcome === "safe") {
      io.to(roomName).emit("systemMessage", { message: poll.targetName + "さんは今回、追放・厳重注意の対象になりませんでした" });
    } else {
      io.to(roomName).emit("systemMessage", { message: "過半数に達した選択肢がないため、今回の投票は判定保留です" });
    }
    io.to(roomName).emit("moderationVoteChanged");
  });

  socket.on("getAnnouncements", () => {
    if (!socket.room) return;
    socket.emit("announcementData", {
      announcements: roomAnnouncements.get(socket.room) || [],
      isOwner: roomOwners.get(socket.room) === socket.id
    });
  });

  socket.on("postAnnouncement", (data = {}) => {
    if (!socket.room || roomOwners.get(socket.room) !== socket.id) {
      socket.emit("announcementError", "お知らせを投稿できるのはルーム管理者だけです");
      return;
    }
    const text = String(data.text || "").trim();
    const id = String(data.id || "");
    if (!text) {
      socket.emit("announcementError", "お知らせの内容を入力してください");
      return;
    }
    if (text.length > 500) {
      socket.emit("announcementError", "お知らせは500文字以内にしてください");
      return;
    }

    const announcements = roomAnnouncements.get(socket.room) || [];
    let postedAnnouncement = null;
    if (id) {
      const target = announcements.find(item => item.id === id);
      if (!target) {
        socket.emit("announcementError", "編集するお知らせが見つかりません");
        return;
      }
      target.text = text;
      target.updatedAt = Date.now();
    } else {
      postedAnnouncement = {
        id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
        text,
        author: socket.username,
        createdAt: Date.now()
      };
      announcements.unshift(postedAnnouncement);
      if (announcements.length > 30) announcements.length = 30;
    }
    roomAnnouncements.set(socket.room, announcements);
    io.to(socket.room).emit("announcementsChanged", announcements);
    if (postedAnnouncement) io.to(socket.room).emit("newAnnouncement", postedAnnouncement);
    socket.emit("announcementSaved");
  });

  socket.on("deleteAnnouncement", (id) => {
    if (!socket.room || roomOwners.get(socket.room) !== socket.id) {
      socket.emit("announcementError", "お知らせを削除できるのはルーム管理者だけです");
      return;
    }
    const announcements = roomAnnouncements.get(socket.room) || [];
    const next = announcements.filter(item => item.id !== String(id));
    if (next.length === announcements.length) {
      socket.emit("announcementError", "削除するお知らせが見つかりません");
      return;
    }
    roomAnnouncements.set(socket.room, next);
    io.to(socket.room).emit("announcementsChanged", next);
  });

  socket.on("getRoomSettings", () => {
    if (!socket.room) return;
    const settings = roomSettings.get(socket.room) || defaultRoomSettings();
    socket.emit("roomSettingsData", {
      isOwner: roomOwners.get(socket.room) === socket.id,
      passwordEnabled: Boolean(settings.password),
      profanityFilter: settings.profanityFilter,
      sexualFilter: settings.sexualFilter,
      maxWarnings: settings.maxWarnings
    });
  });

  socket.on("setRoomSettings", (data = {}) => {
    if (!socket.room || roomOwners.get(socket.room) !== socket.id) {
      socket.emit("roomSettingsError", "ルーム作成者だけが設定を変更できます");
      return;
    }
    const password = String(data.password || "").trim();
    if (password.length > 32) {
      socket.emit("roomSettingsError", "パスワードは32文字以内にしてください");
      return;
    }
    const settings = {
      password,
      profanityFilter: Boolean(data.profanityFilter),
      sexualFilter: Boolean(data.sexualFilter),
      maxWarnings: [1, 2, 3, 5].includes(Number(data.maxWarnings)) ? Number(data.maxWarnings) : 3
    };
    roomSettings.set(socket.room, settings);
    io.to(socket.room).emit("roomSettingsChanged");
    socket.emit("roomSettingsSaved", { passwordEnabled: Boolean(password) });
  });

  function moderateMessage(message) {
    const settings = roomSettings.get(socket.room) || defaultRoomSettings();
    const category = blockedCategory(message, settings);
    if (!category) return false;
    const warnings = roomWarnings.get(socket.room) || new Map();
    roomWarnings.set(socket.room, warnings);
    const count = (warnings.get(socket.id) || 0) + 1;
    warnings.set(socket.id, count);
    socket.emit("moderationWarning", { category, count, maxWarnings: settings.maxWarnings });
    if (count >= settings.maxWarnings) {
      const roomName = socket.room;
      if (!roomBans.has(roomName)) roomBans.set(roomName, new Set());
      roomBans.get(roomName).add(socket.username);
      socket.emit("kicked", {
        room: roomName,
        message: "ルームのルールに繰り返し違反したため、このルームから追放されました。"
      });
      removeFromRoom(socket, socket.username + "さんがルール違反により追放されました");
    }
    return true;
  }

  // /move out 名前 で、ルーム作成者が指定した人を退去させる
  socket.on("chatMessage", (rawMessage) => {
    if (!socket.room || !socket.username) return;

    const message = String(rawMessage && typeof rawMessage === "object" ? rawMessage.message || "" : rawMessage || "").trim();
    const replyToId = rawMessage && typeof rawMessage === "object" ? String(rawMessage.replyToId || "") : "";
    if (!message) return;

    // /Anonymous 宛先 メッセージ で、同じルームの相手に匿名メッセージを送る
    if (/^\/anonymous(?:\s|$)/i.test(message)) {
      const anonymousBody = message.slice(10).trim();
      const separator = anonymousBody.indexOf(" ");
      if (separator === -1) {
        socket.emit("anonymousError", "使い方：/Anonymous ユーザー名 メッセージ");
        return;
      }

      const targetName = anonymousBody.slice(0, separator).trim();
      const anonymousText = anonymousBody.slice(separator + 1).trim();

      if (!targetName || !anonymousText) {
        socket.emit("anonymousError", "宛先のユーザー名とメッセージを入力してください");
        return;
      }
      if (moderateMessage(anonymousText)) return;

      const users = rooms.get(socket.room);
      const targets = users
        ? Array.from(users.entries()).filter(([id, name]) =>
            id !== socket.id && name === targetName
          )
        : [];

      if (targets.length === 0) {
        socket.emit("anonymousError", `「${targetName}」さんはこのルームにいません`);
        return;
      }

      if (targets.length > 1) {
        socket.emit("anonymousError", `「${targetName}」さんが複数いるため送信できません`);
        return;
      }

      const targetSocket = io.sockets.sockets.get(targets[0][0]);
      if (!targetSocket || targetSocket.room !== socket.room) {
        socket.emit("anonymousError", "相手がこのルームにいません");
        return;
      }

      // 受信者には送信者の名前やIDを渡さない
      targetSocket.emit("anonymousMessage", { username: socket.username, message: anonymousText });
      socket.emit("systemMessage", {
        message: `${targetName}さんに匿名メッセージを送信しました`
      });
      return;
    }

    if (message.toLowerCase().startsWith("/move out")) {
      const targetName = message.slice(9).trim();

      if (!targetName) {
        socket.emit("kickError", "使い方：/move out ユーザー名");
        return;
      }

      if (!["たい焼き", "けいまる"].includes(socket.username)) {
        socket.emit("kickError", "退去コマンドを使えるのは「たい焼き」と「けいまる」だけです");
        return;
      }

      if (targetName === socket.username) {
        socket.emit("kickError", "自分自身を退去させることはできません");
        return;
      }

      const users = rooms.get(socket.room);
      const targets = users
        ? Array.from(users.entries()).filter(([id, name]) =>
            id !== socket.id && name === targetName
          )
        : [];

      if (targets.length === 0) {
        socket.emit("kickError", `「${targetName}」さんはこのルームにいません`);
        return;
      }

      // 退去させたユーザー名を、このルームの入室禁止リストに追加
      if (!roomBans.has(socket.room)) {
        roomBans.set(socket.room, new Set());
      }
      roomBans.get(socket.room).add(targetName);

      // 同じ名前の参加者が複数いる場合は該当者全員を退去
      for (const [targetId] of targets) {
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
          targetSocket.emit("kicked", {
            room: socket.room,
            message: `ルーム作成者によって「${socket.room}」から退去させられました。`
          });
          targetSocket.leave(socket.room);
          targetSocket.room = null;
        }
        users.delete(targetId);
      }

      io.to(socket.room).emit("systemMessage", {
        message: `${targetName}さんがルームから退去しました`
      });

      if (users.size === 0) {
        rooms.delete(socket.room);
        roomOwners.delete(socket.room);
        roomBans.delete(socket.room);
        roomSettings.delete(socket.room);
        roomWarnings.delete(socket.room);
        roomAnnouncements.delete(socket.room);
        roomModerationVotes.delete(socket.room);
        roomVoteWarnings.delete(socket.room);
        roomChatMessages.delete(socket.room);
      } else if (roomOwners.get(socket.room) && !users.has(roomOwners.get(socket.room))) {
        roomOwners.set(socket.room, users.keys().next().value);
        const newOwnerId = roomOwners.get(socket.room);
        io.to(newOwnerId).emit("announcementOwnerChanged", true);
        const settings = roomSettings.get(socket.room) || defaultRoomSettings();
        io.to(newOwnerId).emit("roomSettingsData", {
          isOwner: true,
          passwordEnabled: Boolean(settings.password),
          profanityFilter: settings.profanityFilter,
          sexualFilter: settings.sexualFilter,
          maxWarnings: settings.maxWarnings
        });
      }

      sendRoomList();
      broadcastPresence(socket.room);
      return;
    }

    if (moderateMessage(message)) return;

    const messageId = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 9);
    const storedMessages = roomChatMessages.get(socket.room) || new Map();
    let replyTo = null;
    if (replyToId) {
      const original = storedMessages.get(replyToId);
      if (original) replyTo = { id: original.id, username: original.username, message: original.message.slice(0, 120) };
    }
    const chatItem = { id: messageId, senderId: socket.id, username: socket.username, message, replyTo, readBy: new Set() };
    storedMessages.set(messageId, chatItem);
    while (storedMessages.size > 300) storedMessages.delete(storedMessages.keys().next().value);
    roomChatMessages.set(socket.room, storedMessages);
    io.to(socket.room).emit("chatMessage", { id: messageId, username: socket.username, message, replyTo });
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      removeFromRoom(socket, `${socket.username}さんが退出しました`);
    } else {
      sendRoomList();
    }
    console.log("ユーザーが切断しました");
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
