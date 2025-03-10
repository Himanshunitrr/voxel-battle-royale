"use strict";
import * as THREE from "three";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.18.0/dist/cannon-es.js";

(() => {
	// GLOBAL VARIABLES
	let scene, camera, renderer, world, socket;
	let player, playerBody; // local player and physics body
	let hfBody; // physics terrain body
	let otherPlayers = {}; // remote players keyed by socket id
	let guns = []; // gun models lying in the world
	let bullets = []; // active bullets

	let killCounts = {}; // global leaderboard
	const keys = {}; // keyboard state

	// Global alivePlayers: networked players
	let alivePlayers = {};
	// Array for bots
	let botPlayers = [];
	// Global counter for unique bot IDs
	let botCounter = 0;

	// UI elements
	const healthDisplay = document.getElementById("healthDisplay");
	const leaderboardList = document.getElementById("leaderboardList");
	const gameOverOverlay = document.getElementById("gameOverOverlay");

	// --- Pre-game: Name & Pointer Lock ---
	let playerName = localStorage.getItem("playerName") || "";
	const preGameOverlay = document.getElementById("preGameOverlay");
	const startGameButton = document.getElementById("startGameButton");
	startGameButton.addEventListener("click", () => {
		const inputName = document.getElementById("playerNameInput").value.trim();
		playerName =
			inputName !== ""
				? inputName
				: "Player" + Math.floor(Math.random() * 1000);
		localStorage.setItem("playerName", playerName);
		preGameOverlay.style.display = "none";
		initGame();
	});
	if (playerName !== "") {
		preGameOverlay.style.display = "none";
		setTimeout(() => {
			initGame();
		}, 1000);
	}

	let isDead = false; // freeze updates when dead

	// --- BOT FUNCTIONS ---
	function spawnBot() {
		// Spawn bot randomly in x,z between -40 and 40 (server values scaled by 10 in createTree).
		const x = Math.random() * 80 - 40;
		const z = Math.random() * 80 - 40;
		// In physics terrain, elementSize is 10 so actual position will be x*10.
		const y = getGroundHeight(x * 10, z * 10) + playerHeightOffset;
		const botMesh = createOtherPlayer();
		botMesh.position.set(x * 10, y, z * 10);
		botMesh.userData.collisionRadius = 1.5; // fixed collision radius
		const bot = {
			id: "bot_" + botCounter++,
			mesh: botMesh,
			health: 100,
			hasGun: true,
			gun: null,
			currentDirection: new THREE.Vector3(
				Math.random() - 0.5,
				0,
				Math.random() - 0.5
			).normalize(),
			changeDirTime: Math.random() * 3 + 2,
			fireCooldown: 0,
			bulletSpeed: 80, // Bot bullet speed
		};
		botMesh.userData.botId = bot.id;
		const gun = createGunModel(0, 0, 0);
		gun.rotation.set(0, -Math.PI / 2, 0);
		gun.position.set(0.7, 1.25, 0);
		botMesh.add(gun);
		bot.hasGun = true;
		bot.gun = gun;
		botMesh.userData.health = bot.health;
		botMesh.userData.isBot = true;
		botPlayers.push(bot);
		scene.add(botMesh);
	}

	function updateBot(bot, delta) {
		const detectionRange = 20;
		const attackDistance = 10;
		const botSpeed = 5;
		const target = player;
		const botPos = bot.mesh.position;
		const targetPos = player.position;
		const dist = botPos.distanceTo(targetPos);
		if (dist < detectionRange) {
			bot.currentDirection.copy(targetPos).sub(botPos).normalize();
			if (dist > attackDistance) {
				bot.mesh.position.add(
					bot.currentDirection.clone().multiplyScalar(botSpeed * delta)
				);
			}
			bot.fireCooldown -= delta;
			if (bot.fireCooldown <= 0) {
				shootBulletFromBot(bot);
				bot.fireCooldown = 1.5;
			}
		} else {
			bot.changeDirTime -= delta;
			if (bot.changeDirTime <= 0) {
				const angle = Math.random() * Math.PI * 2;
				bot.currentDirection.set(Math.cos(angle), 0, Math.sin(angle));
				bot.changeDirTime = Math.random() * 3 + 2;
			}
			bot.mesh.position.add(
				bot.currentDirection.clone().multiplyScalar(botSpeed * delta)
			);
		}
		const desiredY =
			getGroundHeight(bot.mesh.position.x, bot.mesh.position.z) +
			playerHeightOffset;
		bot.mesh.position.y = desiredY;
	}

	function shootBulletFromBot(bot) {
		const spawnPos = new THREE.Vector3();
		bot.mesh.localToWorld(spawnPos.copy(bot.gun.position));
		const direction = new THREE.Vector3()
			.subVectors(player.position, spawnPos)
			.normalize();
		const bulletGeom = new THREE.BoxGeometry(0.2, 0.2, 0.2);
		const bulletMat = new THREE.MeshLambertMaterial({ color: 0xff0000 });
		const bulletMesh = new THREE.Mesh(bulletGeom, bulletMat);
		bulletMesh.position.copy(spawnPos);
		scene.add(bulletMesh);
		const bullet = {
			mesh: bulletMesh,
			direction: direction.clone(),
			life: bulletLifetime,
			owner: bot.id, // unique bot ID
			speed: bot.bulletSpeed,
		};
		bullets.push(bullet);
	}
	// --- END BOT FUNCTIONS ---

	// --- CAMERA & CONTROL ---
	let yaw = 0,
		pitch = 0;
	window.addEventListener("mousemove", (event) => {
		if (document.pointerLockElement === renderer.domElement) {
			yaw -= event.movementX * 0.002;
			pitch -= event.movementY * 0.002;
			pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
		} else {
			yaw = THREE.MathUtils.lerp(
				-Math.PI,
				Math.PI,
				event.clientX / window.innerWidth
			);
			pitch = THREE.MathUtils.lerp(
				THREE.MathUtils.degToRad(85),
				THREE.MathUtils.degToRad(-40),
				event.clientY / window.innerHeight
			);
		}
	});
	// Reverse A and D keys: A moves right, D moves left.
	let isAiming = false;
	let isRightShoulder = true;
	const defaultDistance = 3,
		defaultHeight = 3;
	const aimDistance = 2,
		aimHeight = 2;
	const shoulderOffset = 1.5;

	// --- GAMEPLAY PARAMETERS ---
	const playerHeightOffset = 1;
	let canJump = false;
	const jumpImpulse = 8;
	const pickupRange = 2;
	const bulletLifetime = 3;

	// --- AEROPLANE SPAWN ---
	let plane,
		planeSpeed = 25;

	// --- TERRAIN FUNCTIONS ---
	function getGroundHeight(x, z) {
		return 3 + 3 * Math.sin(x * 0.05) * Math.cos(z * 0.05);
	}
	function createTerrain() {
		// Increase elementSize to 10 for a 10x larger physics terrain.
		const gridSize = 101,
			elementSize = 10;
		const matrix = [];
		for (let i = 0; i < gridSize; i++) {
			const row = [];
			for (let j = 0; j < gridSize; j++) {
				let x = i - gridSize / 2,
					z = j - gridSize / 2;
				row.push(getGroundHeight(x * elementSize, z * elementSize));
			}
			matrix.push(row);
		}
		const hfShape = new CANNON.Heightfield(matrix, { elementSize });
		hfBody = new CANNON.Body({ mass: 0 });
		hfBody.addShape(hfShape);
		hfBody.position.set(
			(-gridSize / 2) * elementSize,
			0,
			(-gridSize / 2) * elementSize
		);
		world.addBody(hfBody);

		// Visual terrain: 1000 x 1000 plane.
		const size = 1000,
			segments = 100;
		const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
		geometry.rotateX(-Math.PI / 2);
		const vertices = geometry.attributes.position;
		for (let i = 0; i < vertices.count; i++) {
			let x = vertices.getX(i),
				z = vertices.getZ(i);
			vertices.setY(i, getGroundHeight(x, z));
		}
		vertices.needsUpdate = true;
		geometry.computeVertexNormals();
		const material = new THREE.MeshLambertMaterial({
			color: 0x228b22,
			side: THREE.DoubleSide,
		});
		const terrain = new THREE.Mesh(geometry, material);
		scene.add(terrain);
	}

	// --- AEROPLANE SPAWN ---
	function createAeroplane() {
		plane = new THREE.Group();
		const bodyGeo = new THREE.BoxGeometry(4, 1, 1);
		const bodyMat = new THREE.MeshLambertMaterial({ color: 0x808080 });
		const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
		plane.add(bodyMesh);
		const wingGeo = new THREE.BoxGeometry(1, 0.2, 3);
		const wingMat = new THREE.MeshLambertMaterial({ color: 0x606060 });
		const leftWing = new THREE.Mesh(wingGeo, wingMat);
		leftWing.position.set(-1, 0, 0);
		plane.add(leftWing);
		const rightWing = new THREE.Mesh(wingGeo, wingMat);
		rightWing.position.set(1, 0, 0);
		plane.add(rightWing);
		plane.position.set(-50, 80, 0);
		scene.add(plane);
	}

	// --- UTILITY: NAME TAG ---
	function createNameTag(name) {
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		ctx.font = "Bold 24px Arial";
		const textWidth = ctx.measureText(name).width;
		canvas.width = textWidth;
		canvas.height = 30;
		ctx.font = "Bold 24px Arial";
		ctx.fillStyle = "white";
		ctx.fillText(name, 0, 24);
		const texture = new THREE.CanvasTexture(canvas);
		const material = new THREE.SpriteMaterial({
			map: texture,
			transparent: true,
		});
		const sprite = new THREE.Sprite(material);
		sprite.scale.set(canvas.width / 50, canvas.height / 50, 1);
		return sprite;
	}

	// --- UI UPDATE ---
	function updateUI() {
		healthDisplay.textContent =
			"Health: " + (player ? player.userData.health : 0);
		const entries = Object.entries(killCounts).sort((a, b) => b[1] - a[1]);
		let html = "";
		for (let i = 0; i < Math.min(3, entries.length); i++) {
			html += `<li>${entries[i][0]}: ${entries[i][1]}</li>`;
		}
		leaderboardList.innerHTML = html;
	}

	// --- LEADERBOARD SYNC ---
	function setupLeaderboardSync() {
		socket.on("updateLeaderboard", (data) => {
			killCounts = data;
			updateUI();
		});
	}

	// --- INITIALIZE GAME ---
	function initGame() {
		killCounts = {};
		alivePlayers = {};
		botPlayers = [];
		init();
		createAeroplane();
		createTerrain();
		setupLeaderboardSync();
		// Spawn 5 bots initially.
		for (let i = 0; i < 50; i++) {
			spawnBot();
		}
	}

	// --- MAIN INITIALIZATION ---
	function init() {
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0x87ceeb);
		camera = new THREE.PerspectiveCamera(
			75,
			window.innerWidth / window.innerHeight,
			0.1,
			1000
		);
		renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setSize(window.innerWidth, window.innerHeight);
		document.body.appendChild(renderer.domElement);

		if (playerName !== "") {
			renderer.domElement.requestPointerLock?.();
		}

		const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
		scene.add(ambientLight);
		const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
		directionalLight.position.set(5, 10, 7.5);
		scene.add(directionalLight);

		world = new CANNON.World();
		world.gravity.set(0, -9.82, 0);
		world.broadphase = new CANNON.NaiveBroadphase();
		world.solver.iterations = 10;

		const groundMaterial = new CANNON.Material();
		const groundShape = new CANNON.Plane();
		const groundBody = new CANNON.Body({ mass: 0, material: groundMaterial });
		groundBody.addShape(groundShape);
		groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
		world.addBody(groundBody);

		createTerrain();

		socket = io();
		socket.emit("joinGame", { name: playerName });
		alivePlayers[socket.id] = true;

		socket.on("environment", (env) => {
			env.trees.forEach((pos) => {
				// Multiply tree positions by 10 to match the larger terrain.
				createTree(pos.x, pos.z);
			});
			env.guns.forEach((pos) => {
				const gun = createGunModel(pos.x * 10, pos.y, pos.z * 10);
				scene.add(gun);
				guns.push(gun);
			});
		});

		socket.on("allPlayers", (playersData) => {
			playersData.forEach((data) => {
				alivePlayers[data.id] = true;
				if (!otherPlayers[data.id]) {
					const otherMesh = createOtherPlayer();
					otherMesh.userData.id = data.id;
					otherMesh.userData.name = data.name;
					otherMesh.userData.collisionRadius = 1.5;
					const tag = createNameTag(data.name);
					tag.position.set(0, 3, 0);
					otherMesh.add(tag);
					otherPlayers[data.id] = otherMesh;
					scene.add(otherMesh);
				}
			});
		});

		socket.on("playerJoined", (data) => {
			alivePlayers[data.id] = true;
			if (!otherPlayers[data.id]) {
				const otherMesh = createOtherPlayer();
				otherMesh.userData.id = data.id;
				otherMesh.userData.name = data.name;
				otherMesh.userData.collisionRadius = 1.5;
				const tag = createNameTag(data.name);
				tag.position.set(0, 3, 0);
				otherMesh.add(tag);
				otherPlayers[data.id] = otherMesh;
				scene.add(otherMesh);
			}
		});

		socket.on("playerUpdate", (data) => {
			if (data.id === socket.id) return;
			if (!alivePlayers[data.id]) return;
			if (data.health <= 0) {
				if (otherPlayers[data.id]) {
					scene.remove(otherPlayers[data.id]);
					delete otherPlayers[data.id];
					delete alivePlayers[data.id];
				}
				return;
			}
			let otherMesh = otherPlayers[data.id];
			if (!otherMesh) {
				otherMesh = createOtherPlayer();
				otherMesh.userData.id = data.id;
				otherMesh.userData.name = data.name;
				otherMesh.userData.collisionRadius = 1.5;
				const tag = createNameTag(data.name);
				tag.position.set(0, 3, 0);
				otherMesh.add(tag);
				otherPlayers[data.id] = otherMesh;
				scene.add(otherMesh);
			}
			otherMesh.position.set(data.position.x, data.position.y, data.position.z);
			otherMesh.userData.health = data.health;
			if (data.hasGun) {
				if (!otherMesh.userData.gun) {
					const gun = createGunModel(0, 0, 0);
					gun.rotation.set(0, -Math.PI / 2, 0);
					gun.position.set(0.7, 1.25, 0);
					otherMesh.add(gun);
					otherMesh.userData.gun = gun;
				}
			} else {
				if (otherMesh.userData.gun) {
					otherMesh.remove(otherMesh.userData.gun);
					otherMesh.userData.gun = null;
				}
			}
		});

		socket.on("playerDisconnected", (data) => {
			if (otherPlayers[data.id]) {
				scene.remove(otherPlayers[data.id]);
				delete otherPlayers[data.id];
				delete alivePlayers[data.id];
			}
		});

		socket.on("bulletFired", (data) => {
			spawnBullet(data.position, data.direction, data.id);
		});

		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("mousedown", onMouseDown);

		createAeroplane();
		createPlayer();
		player.userData.collisionRadius = 1.5;
		const localTag = createNameTag(playerName);
		localTag.position.set(0, 3, 0);
		player.add(localTag);

		playerBody.addEventListener("collide", (e) => {
			if (e.body === hfBody) {
				canJump = true;
			}
		});

		animate();
	}

	// --- WORLD OBJECT CREATION FUNCTIONS ---
	function createTree(x, z) {
		// Scale the input coordinates by 10 to match the new terrain.
		x *= 10;
		z *= 10;
		const baseY = getGroundHeight(x, z);
		// Increase trunk size by 10×.
		const trunkGeo = new THREE.CylinderGeometry(2.5, 2.5, 30, 8);
		const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8b4513 });
		const trunk = new THREE.Mesh(trunkGeo, trunkMat);
		trunk.position.set(0, 15, 0);
		// Increase leaves size by 10×.
		const leavesGeo = new THREE.SphereGeometry(15, 8, 8);
		const leavesMat = new THREE.MeshLambertMaterial({ color: 0x228b22 });
		const leaves = new THREE.Mesh(leavesGeo, leavesMat);
		leaves.position.set(0, 35, 0);
		const tree = new THREE.Group();
		tree.add(trunk);
		tree.add(leaves);
		tree.position.set(x, baseY, z);
		scene.add(tree);
	}

	function createGunModel(x, y, z) {
		const gun = new THREE.Group();
		const barrelGeo = new THREE.BoxGeometry(1.5, 0.3, 0.3);
		const barrelMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
		const barrel = new THREE.Mesh(barrelGeo, barrelMat);
		barrel.position.set(0.75, 0.1, 0);
		gun.add(barrel);
		const handleGeo = new THREE.BoxGeometry(0.3, 0.7, 0.3);
		const handleMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
		const handle = new THREE.Mesh(handleGeo, handleMat);
		handle.position.set(0.3, -0.35, 0);
		gun.add(handle);
		const stockGeo = new THREE.BoxGeometry(0.5, 0.4, 0.7);
		const stockMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
		const stock = new THREE.Mesh(stockGeo, stockMat);
		stock.position.set(-0.25, 0.2, 0);
		gun.add(stock);
		gun.rotation.set(0, 0, 0);
		gun.position.set(x, y, z);
		if (x !== 0 || y !== 0 || z !== 0) {
			const gunShape = new CANNON.Box(new THREE.Vector3(0.75, 0.35, 0.35));
			const gunBody = new CANNON.Body({ mass: 0 });
			gunBody.addShape(gunShape);
			gunBody.position.set(x, y, z);
			world.addBody(gunBody);
		}
		return gun;
	}

	function createPlayer() {
		player = new THREE.Group();
		player.userData.health = 100;
		player.userData.hasGun = false;
		player.userData.gun = null;
		const torsoGeo = new THREE.BoxGeometry(1, 2, 0.5);
		const torsoMat = new THREE.MeshLambertMaterial({ color: 0x0000ff });
		const torso = new THREE.Mesh(torsoGeo, torsoMat);
		torso.position.set(0, 1, 0);
		player.add(torso);
		const headGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
		const headMat = new THREE.MeshLambertMaterial({ color: 0xffe0bd });
		const head = new THREE.Mesh(headGeo, headMat);
		head.position.set(0, 2.4, 0);
		player.add(head);
		const armGeo = new THREE.BoxGeometry(0.4, 1.5, 0.4);
		const armMat = new THREE.MeshLambertMaterial({ color: 0xffe0bd });
		const leftArm = new THREE.Mesh(armGeo, armMat);
		leftArm.position.set(-0.7, 1.25, 0);
		player.add(leftArm);
		const rightArm = new THREE.Mesh(armGeo, armMat);
		rightArm.position.set(0.7, 1.25, 0);
		player.add(rightArm);
		const legGeo = new THREE.BoxGeometry(0.5, 1.8, 0.5);
		const legMat = new THREE.MeshLambertMaterial({ color: 0x0000ff });
		const leftLeg = new THREE.Mesh(legGeo, legMat);
		leftLeg.position.set(-0.3, 0, 0);
		player.add(leftLeg);
		const rightLeg = new THREE.Mesh(legGeo, legMat);
		rightLeg.position.set(0.3, 0, 0);
		player.add(rightLeg);
		const startX = 0,
			startZ = 0;
		const startY = getGroundHeight(startX, startZ) + playerHeightOffset;
		player.position.set(startX, startY, startZ);
		scene.add(player);
		const shape = new CANNON.Box(new THREE.Vector3(0.5, 1, 0.5));
		playerBody = new CANNON.Body({ mass: 1 });
		playerBody.addShape(shape);
		playerBody.position.set(startX, startY, startZ);
		world.addBody(playerBody);
		player.userData.collisionRadius = 1.5;
	}

	function createOtherPlayer() {
		const other = new THREE.Group();
		const torso = new THREE.Mesh(
			new THREE.BoxGeometry(1, 2, 0.5),
			new THREE.MeshLambertMaterial({ color: 0x00aa00 })
		);
		torso.position.set(0, 1, 0);
		other.add(torso);
		const head = new THREE.Mesh(
			new THREE.BoxGeometry(0.8, 0.8, 0.8),
			new THREE.MeshLambertMaterial({ color: 0xffe0bd })
		);
		head.position.set(0, 2.4, 0);
		other.add(head);
		const leftArm = new THREE.Mesh(
			new THREE.BoxGeometry(0.4, 1.5, 0.4),
			new THREE.MeshLambertMaterial({ color: 0xffe0bd })
		);
		leftArm.position.set(-0.7, 1.25, 0);
		other.add(leftArm);
		const rightArm = new THREE.Mesh(
			new THREE.BoxGeometry(0.4, 1.5, 0.4),
			new THREE.MeshLambertMaterial({ color: 0xffe0bd })
		);
		rightArm.position.set(0.7, 1.25, 0);
		other.add(rightArm);
		const leftLeg = new THREE.Mesh(
			new THREE.BoxGeometry(0.5, 1.8, 0.5),
			new THREE.MeshLambertMaterial({ color: 0x0000ff })
		);
		leftLeg.position.set(-0.3, 0, 0);
		other.add(leftLeg);
		const rightLeg = new THREE.Mesh(
			new THREE.BoxGeometry(0.5, 1.8, 0.5),
			new THREE.MeshLambertMaterial({ color: 0x0000ff })
		);
		rightLeg.position.set(0.3, 0, 0);
		other.add(rightLeg);
		other.userData.collisionRadius = 1.5;
		return other;
	}

	// --- BULLET HANDLING FUNCTIONS ---
	function shootBullet() {
		// Player bullet: speed = 100.
		const forward = camera.getWorldDirection(new THREE.Vector3()).normalize();
		let spawnPos = new THREE.Vector3();
		if (player.userData.hasGun && player.userData.gun) {
			player.localToWorld(spawnPos.copy(player.userData.gun.position));
		} else {
			spawnPos.copy(player.position).add(new THREE.Vector3(0, 2, 0));
		}
		const raycaster = new THREE.Raycaster(camera.position, forward);
		const objectsToTest = scene.children.filter((obj) => obj !== player);
		const intersects = raycaster.intersectObjects(objectsToTest, true);
		let targetPoint;
		if (intersects.length > 0) {
			targetPoint = intersects[0].point;
		} else {
			targetPoint = camera.position
				.clone()
				.add(forward.clone().multiplyScalar(1000));
		}
		const direction = new THREE.Vector3()
			.subVectors(targetPoint, spawnPos)
			.normalize();
		const bulletGeom = new THREE.BoxGeometry(0.2, 0.2, 0.2);
		const bulletMat = new THREE.MeshLambertMaterial({ color: 0xff0000 });
		const bulletMesh = new THREE.Mesh(bulletGeom, bulletMat);
		bulletMesh.position.copy(spawnPos);
		scene.add(bulletMesh);
		const bullet = {
			mesh: bulletMesh,
			direction: direction.clone(),
			life: bulletLifetime,
			owner: socket.id,
			speed: 150,
		};
		bullets.push(bullet);
		socket.emit("bulletFired", { position: spawnPos, direction: direction });
	}
	function spawnBullet(position, direction, ownerId) {
		const bulletGeom = new THREE.BoxGeometry(0.2, 0.2, 0.2);
		const bulletMat = new THREE.MeshLambertMaterial({ color: 0xff0000 });
		const bulletMesh = new THREE.Mesh(bulletGeom, bulletMat);
		bulletMesh.position.copy(
			new THREE.Vector3(position.x, position.y, position.z)
		);
		scene.add(bulletMesh);
		const bullet = {
			mesh: bulletMesh,
			direction: new THREE.Vector3(direction.x, direction.y, direction.z),
			life: bulletLifetime,
			owner: ownerId,
			speed: ownerId.startsWith("bot") ? 80 : 100,
		};
		bullets.push(bullet);
	}

	// --- CROSSHAIR UPDATE ---
	function updateCrosshair() {
		const crosshair = document.getElementById("crosshair");
		const aimDistanceFixed = 10;
		const aimPoint = camera.position
			.clone()
			.add(
				camera
					.getWorldDirection(new THREE.Vector3())
					.multiplyScalar(aimDistanceFixed)
			);
		aimPoint.project(camera);
		const x = (aimPoint.x * 0.5 + 0.5) * window.innerWidth;
		const y = (-aimPoint.y * 0.5 + 0.5) * window.innerHeight;
		crosshair.style.left = `${x - 5}px`;
		crosshair.style.top = `${y - 5}px`;
	}

	// --- ANIMATION LOOP ---
	const clock = new THREE.Clock();
	function animate() {
		if (isDead) return;
		requestAnimationFrame(animate);
		const delta = clock.getDelta();
		world.step(1 / 60, delta, 3);

		if (plane) {
			plane.position.x += planeSpeed * delta;
			if (plane.position.x > 500) {
				playerBody.velocity.y = -5;
				scene.remove(plane);
				plane = null;
			} else {
				playerBody.position
					.copy(plane.position)
					.vadd(new CANNON.Vec3(0, -10, 0));
			}
		}

		const desiredY =
			getGroundHeight(playerBody.position.x, playerBody.position.z) +
			playerHeightOffset;
		if (playerBody.position.y < desiredY) {
			playerBody.position.y = desiredY;
			playerBody.velocity.y = 0;
		}
		player.position.copy(playerBody.position);
		player.rotation.y = yaw;

		const camDir = camera
			.getWorldDirection(new THREE.Vector3())
			.setY(0)
			.normalize();
		const right = new THREE.Vector3()
			.crossVectors(new THREE.Vector3(0, 1, 0), camDir)
			.normalize();
		const speed = 8;
		let vx = 0,
			vz = 0;
		if (keys["KeyW"]) {
			vx += camDir.x * speed;
			vz += camDir.z * speed;
		}
		if (keys["KeyA"]) {
			vx += right.x * speed;
			vz += right.z * speed;
		}
		if (keys["KeyD"]) {
			vx -= right.x * speed;
			vz -= right.z * speed;
		}
		if (keys["KeyS"]) {
			vx -= camDir.x * speed;
			vz -= camDir.z * speed;
		}
		playerBody.velocity.x = vx;
		playerBody.velocity.z = vz;

		updateCamera();
		updateCrosshair();
		updateUI();

		// Gun pickup.
		for (let i = guns.length - 1; i >= 0; i--) {
			const gun = guns[i];
			if (
				!player.userData.hasGun &&
				player.position.distanceTo(gun.position) < pickupRange
			) {
				player.add(gun);
				gun.position.set(0.7, 1.25, 0);
				gun.rotation.set(0, -Math.PI / 2, 0);
				player.userData.hasGun = true;
				player.userData.gun = gun;
				guns.splice(i, 1);
			}
		}

		// --- BULLET COLLISION UPDATE USING SUBSTEPS ---
		const subSteps = 4;
		for (let i = bullets.length - 1; i >= 0; i--) {
			const bullet = bullets[i];
			const subDelta = delta / subSteps;
			let collided = false;
			for (let step = 0; step < subSteps; step++) {
				bullet.mesh.position.add(
					bullet.direction.clone().multiplyScalar(bullet.speed * subDelta)
				);
				// Check collision with remote players.
				for (const id in otherPlayers) {
					if (!alivePlayers[id]) continue;
					const other = otherPlayers[id];
					if (
						bullet.mesh.position.distanceTo(other.position) <
						other.userData.collisionRadius
					) {
						const damage = 20;
						if (
							bullet.owner === socket.id &&
							other.userData.health > 0 &&
							other.userData.health - damage <= 0
						) {
							recordKill(playerName);
						}
						other.userData.health -= damage;
						if (other.userData.health <= 0) {
							scene.remove(other);
							delete otherPlayers[id];
							delete alivePlayers[id];
						}
						collided = true;
						break;
					}
				}
				// Check collision with local player.
				if (!collided && bullet.owner !== socket.id) {
					if (
						bullet.mesh.position.distanceTo(player.position) <
						player.userData.collisionRadius
					) {
						const damage = 20;
						player.userData.health -= damage;
						collided = true;
					}
				}
				if (collided) break;
			}
			bullet.life -= delta;
			if (collided || bullet.life <= 0) {
				scene.remove(bullet.mesh);
				bullets.splice(i, 1);
			}
		}

		// Safety check for local player collision.
		for (let i = bullets.length - 1; i >= 0; i--) {
			const bullet = bullets[i];
			if (
				bullet.owner !== socket.id &&
				bullet.mesh.position.distanceTo(player.position) <
					player.userData.collisionRadius
			) {
				const damage = 20;
				player.userData.health -= damage;
				scene.remove(bullet.mesh);
				bullets.splice(i, 1);
			}
		}
		if (player.userData.health <= 0) {
			handleLocalDeath();
			return;
		}

		// Update bots.
		for (let i = 0; i < botPlayers.length; i++) {
			updateBot(botPlayers[i], delta);
		}
		// Check bullet collisions with bots.
		for (let i = bullets.length - 1; i >= 0; i--) {
			const bullet = bullets[i];
			for (let j = 0; j < botPlayers.length; j++) {
				const bot = botPlayers[j];
				// Prevent bot from being hit by its own bullet.
				if (bullet.owner === bot.id) continue;
				if (
					bullet.mesh.position.distanceTo(bot.mesh.position) <
					bot.mesh.userData.collisionRadius
				) {
					const damage = 20;
					bot.health -= damage;
					scene.remove(bullet.mesh);
					bullets.splice(i, 1);
					if (bot.health <= 0) {
						scene.remove(bot.mesh);
						botPlayers.splice(j, 1);
						spawnBot(); // Spawn new bot on kill.
					}
					break;
				}
			}
		}

		socket.emit("playerUpdate", {
			id: socket.id,
			position: player.position,
			health: player.userData.health,
			name: playerName,
			hasGun: player.userData.hasGun,
		});
		renderer.render(scene, camera);
	}

	function updateCamera() {
		const distance = isAiming ? aimDistance : defaultDistance;
		const height = isAiming ? aimHeight : defaultHeight;
		const lateral = isRightShoulder ? shoulderOffset : -shoulderOffset;
		const relPos = new THREE.Vector3(lateral, height, -distance);
		relPos.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
		const targetCamPos = player.position.clone().add(relPos);
		camera.position.lerp(targetCamPos, 0.1);
		const camDir = new THREE.Vector3(
			Math.sin(yaw) * Math.cos(pitch),
			Math.sin(pitch),
			Math.cos(yaw) * Math.cos(pitch)
		);
		const aimTarget = camera.position.clone().add(camDir);
		camera.lookAt(aimTarget);
	}

	function recordKill(name) {
		if (!killCounts[name]) killCounts[name] = 0;
		killCounts[name]++;
		socket.emit("reportKill", { name });
	}

	function handleLocalDeath() {
		isDead = true;
		delete alivePlayers[socket.id];
		scene.remove(player);
		window.removeEventListener("keydown", onKeyDown);
		window.removeEventListener("keyup", onKeyUp);
		window.removeEventListener("mousedown", onMouseDown);
		socket.emit("playerDied", { id: socket.id });
		socket.disconnect();
		gameOverOverlay.style.display = "flex";
	}

	function onKeyDown(event) {
		if (isDead || event.repeat) return;
		keys[event.code] = true;
		if (event.code === "Space") {
			if (plane) {
				playerBody.velocity.y = jumpImpulse;
				scene.remove(plane);
				plane = null;
			} else if (canJump) {
				playerBody.velocity.y = jumpImpulse;
				canJump = false;
			}
		}
		if (event.code === "KeyQ") {
			isRightShoulder = !isRightShoulder;
		}
	}
	function onKeyUp(event) {
		if (!isDead) keys[event.code] = false;
	}
	function onMouseDown(event) {
		if (!isDead && player.userData.hasGun) {
			shootBullet();
		}
	}
})();
