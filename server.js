const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));


// ルームを管理
// rooms = {
//   "ゲーム部屋": Map(socket.id → username),
//   "雑談部屋": Map(socket.id → username)
// }
const rooms = new Map();


io.on("connection", (socket) => {

  console.log("ユーザーが接続しました");


  // =========================
  // ルーム一覧を送る
  // =========================

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


  // =========================
  // ルームを作る
  // =========================

  socket.on("createRoom", (roomName) => {

    roomName = roomName.trim();

    if (!roomName) {
      socket.emit(
        "roomError",
        "ルーム名を入力してください"
      );
      return;
    }


    // 同じ名前のルームがある
    if (rooms.has(roomName)) {

      socket.emit(
        "roomError",
        "そのルームはすでにあります"
      );

      return;
    }


    // 新しいルームを作成
    rooms.set(
      roomName,
      new Map()
    );


    console.log(
      `ルーム作成: ${roomName}`
    );


    // 作成した人に通知
    socket.emit(
      "roomCreated",
      roomName
    );


    // 全員のルーム一覧を更新
    sendRoomList();

  });


  // =========================
  // ルーム一覧を要求
  // =========================

  socket.on("getRooms", () => {

    sendRoomList();

  });


  // =========================
  // ルームに入る
  // =========================

  socket.on("joinRoom", ({ username, room }) => {

    username = username.trim();
    room = room.trim();


    if (!username) {

      socket.emit(
        "roomError",
        "ユーザー名を入力してください"
      );

      return;
    }


    if (!room) {

      socket.emit(
        "roomError",
        "ルームを選択してください"
      );

      return;
    }


    // ルームが存在しない
    if (!rooms.has(room)) {

      socket.emit(
        "roomError",
        "そのルームはありません"
      );

      return;
    }


    // すでに別のルームにいる場合は退出
    if (socket.room) {

      const oldRoom = rooms.get(socket.room);

      if (oldRoom) {

        oldRoom.delete(socket.id);

        socket.leave(socket.room);

        if (oldRoom.size === 0) {

          rooms.delete(socket.room);

        }

      }

    }


    // 新しいルームに入る
    socket.username = username;
    socket.room = room;

    socket.join(room);


    const users = rooms.get(room);

    users.set(
      socket.id,
      username
    );


    console.log(
      `${username} が ${room} に入室`
    );


    // 本人に入室成功を通知
    socket.emit(
      "roomJoined",
      room
    );


    // 同じルームの人に通知
    socket.to(room).emit(
      "systemMessage",
      {
        message: `${username}さんが入室しました`
      }
    );


    // 全員のルーム一覧を更新
    sendRoomList();

  });


  // =========================
  // チャット
  // =========================

  socket.on("chatMessage", (message) => {

    if (!socket.room || !socket.username) {
      return;
    }


    message = String(message).trim();

    if (!message) {
      return;
    }


    io.to(socket.room).emit(
      "chatMessage",
      {
        username: socket.username,
        message: message
      }
    );

  });


  // =========================
  // 切断
  // =========================

  socket.on("disconnect", () => {

    if (socket.room) {

      const room = rooms.get(
        socket.room
      );


      if (room) {

        room.delete(socket.id);


        // 誰もいなくなったらルームを削除
        if (room.size === 0) {

          rooms.delete(
            socket.room
          );

        }
        else {

          socket.to(socket.room).emit(
            "systemMessage",
            {
              message:
                `${socket.username}さんが退出しました`
            }
          );

        }

      }

    }


    // ルーム一覧を更新
    sendRoomList();


    console.log(
      "ユーザーが切断しました"
    );

  });

});


server.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );

});
