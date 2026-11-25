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

io.on("connection", (socket) => {
  console.log("ユーザーが接続しました");

  function sendRoomList() {
    const roomList = [];
    for (const [roomName, users] of rooms) {
      roomList.push({
        name: roomName,
        users: Array.from(users.values()),
        count: users.size
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

    console.log(`ルーム作成: ${roomName}`);
    socket.emit("roomCreated", roomName);
    sendRoomList();
  });

  socket.on("getRooms", () => sendRoomList());

  socket.on("joinRoom", ({ username, room }) => {
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

  // /move out 名前 で、ルーム作成者が指定した人を退去させる
  socket.on("chatMessage", (rawMessage) => {
    if (!socket.room || !socket.username) return;

    const message = String(rawMessage || "").trim();
    if (!message) return;

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
      } else if (roomOwners.get(socket.room) && !users.has(roomOwners.get(socket.room))) {
        roomOwners.set(socket.room, users.keys().next().value);
      }

      sendRoomList();
      return;
    }

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
