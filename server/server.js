const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Shared leaderboard
let matchKillCounts = {};

// Define a common environment with fixed positions for trees and guns
const environment = {
	trees: [],
	guns: [],
};
// Generate 30 trees deterministically
for (let i = 0; i < 30; i++) {
	let x = ((i * 7) % 100) - 50;
	let z = ((i * 13) % 100) - 50;
	environment.trees.push({ x, z });
}
// Generate 20 guns
for (let i = 0; i < 20; i++) {
	let x = ((i * 11) % 80) - 40;
	let z = ((i * 17) % 80) - 40;
	let y = 1;
	environment.guns.push({ x, y, z });
}

// Track connected players
let players = {};

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
		players[socket.id] = {
			id: socket.id,
			name: data.name || "Player" + Math.floor(Math.random() * 1000),
			position: { x: 0, y: 0, z: 0 },
			health: 100,
			hasGun: false,
		};

		// Send common environment to new client
		socket.emit("environment", environment);
		// Send current players (except self)
		socket.emit(
			"allPlayers",
			Object.values(players).filter((p) => p.id !== socket.id)
		);
		socket.broadcast.emit("playerJoined", {
			id: socket.id,
			name: players[socket.id].name,
		});
	});

	socket.on("playerUpdate", (data) => {
		if (players[socket.id]) {
			players[socket.id] = { ...players[socket.id], ...data };
		}
		socket.broadcast.emit("playerUpdate", data);
	});

	socket.on("playerDied", (data) => {
		console.log("Player died: " + data.id);
		delete players[data.id];
		socket.broadcast.emit("playerDisconnected", { id: data.id });
	});

	socket.on("bulletFired", (data) => {
		socket.broadcast.emit("bulletFired", data);
	});

	socket.on("reportKill", (data) => {
		const name = data.name;
		if (!matchKillCounts[name]) {
			matchKillCounts[name] = 0;
		}
		matchKillCounts[name]++;
		console.log("Match Leaderboard Updated:", matchKillCounts);
		io.emit("updateLeaderboard", matchKillCounts);
	});

	socket.on("disconnect", () => {
		console.log("Player disconnected: " + socket.id);
		delete players[socket.id];
		socket.broadcast.emit("playerDisconnected", { id: socket.id });
	});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});
