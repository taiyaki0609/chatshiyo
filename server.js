const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// 作られたルームを保存
const rooms = new Set();

io.on("connection", (socket) => {
  console.log("ユーザーが接続しました");

  // ルームを作る
  socket.on("createRoom", (room) => {
    room = room.trim();

    if (!room) {
      socket.emit("roomError", "ルーム名を入力してください");
      return;
    }

    if (rooms.has(room)) {
      socket.emit("roomError", "そのルームはすでに存在します");
      return;
    }

    rooms.add(room);

    socket.emit("roomCreated", room);

    console.log(`ルーム作成: ${room}`);
  });

  // ルームに入る
  socket.on("joinRoom", ({ username, room }) => {
    username = username.trim();
    room = room.trim();

    if (!username || !room) {
      socket.emit("roomError", "ユーザー名とルーム名を入力してください");
      return;
    }

    if (!rooms.has(room)) {
      socket.emit("roomError", "そのルームは存在しません");
      return;
    }

    socket.username = username;
    socket.room = room;

    socket.join(room);

    socket.to(room).emit("systemMessage", {
      message: `${username}さんが入室しました`
    });

    socket.emit("systemMessage", {
      message: `${room} に入りました`
    });
  });

  // チャット
  socket.on("chatMessage", (message) => {
    if (!socket.room || !socket.username) return;

    io.to(socket.room).emit("chatMessage", {
      username: socket.username,
      message: message
    });
  });

  // 切断
  socket.on("disconnect", () => {
    if (socket.room && socket.username) {
      socket.to(socket.room).emit("systemMessage", {
        message: `${socket.username}さんが退出しました`
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
