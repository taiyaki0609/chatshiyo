const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL と SUPABASE_ANON_KEY を Render の Environment に設定してください。");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use(express.static("public"));

app.get("/test-supabase", async (req, res) => {
  try {
    const { error } = await supabase.from("users").select("user_id").limit(1);
    if (error) {
      console.error("Supabase接続テスト:", error.message);
      return res.status(500).send("Supabaseへの問い合わせに失敗しました。RenderのLogsを確認してください。");
    }
    res.send("Supabaseへの問い合わせに成功しました！");
  } catch (err) {
    console.error("Supabase接続テスト:", err.message);
    res.status(500).send("接続テスト中にエラーが発生しました。");
  }
});

// Socket.IO の接続ごとに Supabase Auth のトークンを検証する
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error("ログインが必要です。いったんログインし直してください。"));

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return next(new Error("ログイン情報を確認できません。もう一度ログインしてください。"));
    }

    socket.authUser = data.user;
    socket.authUsername =
      (data.user.user_metadata && data.user.user_metadata.username) ||
      (data.user.email ? data.user.email.split("@")[0] : "ユーザー");
    next();
  } catch (err) {
    console.error("認証エラー:", err.message);
    next(new Error("認証中にエラーが発生しました。"));
  }
});

// 現在のプロセス内でルームを管理する（サーバー再起動で消える簡易方式）
const rooms = new Map();

function makeRoomList() {
  return Array.from(rooms.entries()).map(([name, users]) => ({
    name,
    users: Array.from(users.values()),
    count: users.size
  }));
}
function sendRoomList() {
  io.emit("roomList", makeRoomList());
}
function leaveCurrentRoom(socket, announce = true) {
  if (!socket.room) return;
  const oldName = socket.room;
  const oldRoom = rooms.get(oldName);
  if (oldRoom) {
    oldRoom.delete(socket.id);
    socket.leave(oldName);
    if (oldRoom.size === 0) rooms.delete(oldName);
    else if (announce) {
      socket.to(oldName).emit("systemMessage", {
        message: `${socket.authUsername}さんが退出しました`
      });
    }
  }
  socket.room = null;
  sendRoomList();
}

io.on("connection", (socket) => {
  console.log(`ログイン済みユーザーが接続: ${socket.authUsername}`);

  socket.on("createRoom", (rawName) => {
    const roomName = String(rawName || "").trim().slice(0, 30);
    if (!roomName) return socket.emit("roomError", "ルーム名を入力してください");
    if (rooms.has(roomName)) return socket.emit("roomError", "そのルームはすでにあります");

    rooms.set(roomName, new Map());
    socket.emit("roomCreated", roomName);
    sendRoomList();
  });

  socket.on("getRooms", () => sendRoomList());

  socket.on("joinRoom", (payload) => {
    const room = String((payload && payload.room) || "").trim();
    if (!room) return socket.emit("roomError", "ルームを選択してください");
    if (!rooms.has(room)) return socket.emit("roomError", "そのルームはありません");

    leaveCurrentRoom(socket, true);
    socket.room = room;
    socket.join(room);
    rooms.get(room).set(socket.id, socket.authUsername);

    socket.emit("roomJoined", room);
    socket.to(room).emit("systemMessage", {
      message: `${socket.authUsername}さんが入室しました`
    });
    sendRoomList();
  });

  socket.on("chatMessage", (rawMessage) => {
    if (!socket.room || !socket.authUsername) return;
    const message = String(rawMessage || "").trim().slice(0, 2000);
    if (!message) return;
    io.to(socket.room).emit("chatMessage", {
      username: socket.authUsername,
      message
    });
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket, true);
    console.log(`切断: ${socket.authUsername}`);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
