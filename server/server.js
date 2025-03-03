const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Shared leaderboard object (global kill counts)
let matchKillCounts = {};

// Define common environment with fixed positions
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

// Track connected players (alive only)
let players = {};

app.use(express.static(path.join(__dirname, "..", "client")));

// Serve the leaderboard HTML page
app.get("/leaderboard", (req, res) => {
	res.sendFile(path.join(__dirname, "..", "client", "leaderboard.html"));
});

// New route to serve the global leaderboard JSON data
app.get("/api/leaderboard", (req, res) => {
	// Sort leaderboard data by kills in descending order and return top 10.
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

		// Send common environment to the new client
		socket.emit("environment", environment);
		// Send all current alive players (except self)
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
