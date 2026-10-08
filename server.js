const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("ユーザーが接続しました");

  socket.on("joinRoom", ({ username, room }) => {
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

  socket.on("chatMessage", (message) => {
    if (!socket.room || !socket.username) return;

    io.to(socket.room).emit("chatMessage", {
      username: socket.username,
      message: message
    });
  });

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
