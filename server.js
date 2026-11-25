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
      } else {
        if (roomOwners.get(roomName) === targetSocket.id) {
          roomOwners.set(roomName, users.keys().next().value);
        }
        if (notice) {
          io.to(roomName).emit("systemMessage", { message: notice });
        }
      }
    }
    sendRoomList();
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

    console.log(`ルーム作成: ${roomName}`);
    socket.emit("roomCreated", roomName);
    sendRoomList();
  });

  socket.on("getRooms", () => sendRoomList());

  socket.on("joinRoom", ({ username, room, password = "" }) => {
    username = String(username || "").trim();
    room = String(room || "").trim();

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
    socket.to(room).emit("systemMessage", {
      message: `${username}さんが入室しました`
    });
    sendRoomList();
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

    const message = String(rawMessage || "").trim();
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

      if (socket.username !== "たい焼き") {
        socket.emit("kickError", "退去コマンドを使えるのは「たい焼き」だけです");
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
      } else if (roomOwners.get(socket.room) && !users.has(roomOwners.get(socket.room))) {
        roomOwners.set(socket.room, users.keys().next().value);
      }

      sendRoomList();
      return;
    }

    if (moderateMessage(message)) return;

    io.to(socket.room).emit("chatMessage", {
      username: socket.username,
      message
    });
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
