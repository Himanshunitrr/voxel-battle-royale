const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Shared per-match leaderboard.
let matchKillCounts = {};

app.use(express.static("client"));

app.get("/leaderboard", (req, res) => {
  const sorted = Object.entries(matchKillCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  res.json(sorted);
});

io.on("connection", (socket) => {
  console.log("Player connected: " + socket.id);
  
  socket.on("joinGame", (data) => {
    socket.broadcast.emit("playerJoined", { id: socket.id });
  });
  
  socket.on("playerUpdate", (data) => {
    socket.broadcast.emit("playerUpdate", data);
  });
  
  socket.on("bulletFired", (data) => {
    socket.broadcast.emit("bulletFired", data);
  });
  
  socket.on("reportKill", (data) => {
    const name = data.name;
    if (!matchKillCounts[name]) { matchKillCounts[name] = 0; }
    matchKillCounts[name]++;
    console.log("Match Leaderboard Updated:", matchKillCounts);
    io.emit("updateLeaderboard", matchKillCounts);
  });
  
  socket.on("disconnect", () => {
    console.log("Player disconnected: " + socket.id);
    socket.broadcast.emit("playerDisconnected", { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
