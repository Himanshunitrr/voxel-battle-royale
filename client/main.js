"use strict";
import * as THREE from "three";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.18.0/dist/cannon-es.js";

(() => {
	// GLOBAL VARIABLES
	let scene, camera, renderer, world, socket;
	let player, playerBody; // local player and its physics body
	let hfBody; // physics heightfield for terrain
	let otherPlayers = {}; // remote players (keyed by id)
	let guns = []; // gun models in the world
	let bullets = []; // active bullets

	let killCounts = {}; // leaderboard
	const keys = {}; // keyboard state

	// Global alivePlayers: keys are ids of players that are alive.
	let alivePlayers = {};

	// UI elements
	const healthDisplay = document.getElementById("healthDisplay");
	const leaderboardList = document.getElementById("leaderboardList");
	const gameOverOverlay = document.getElementById("gameOverOverlay");

	// Pre-game: get player name
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
		setTimeout(initGame, 1000);
	}

	let isDead = false; // flag to freeze local updates

	// CAMERA & CONTROLS
	let yaw = 0,
		pitch = 0;
	window.addEventListener("mousemove", (event) => {
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
	});
	let isAiming = false;
	// Reverse A and D: A moves right, D moves left.
	let isRightShoulder = true;
	const defaultDistance = 3,
		defaultHeight = 3;
	const aimDistance = 2,
		aimHeight = 2;
	const shoulderOffset = 0.5;

	// GAMEPLAY PARAMETERS
	const playerHeightOffset = 1;
	let canJump = false;
	const jumpImpulse = 8;
	const pickupRange = 2;
	const bulletSpeed = 20;
	const bulletLifetime = 3;

	// AEROPLANE (spawn platform)
	let plane,
		planeSpeed = 5;

	// COMMON TERRAIN: deterministic height function
	function getGroundHeight(x, z) {
		return 3 + 3 * Math.sin(x * 0.05) * Math.cos(z * 0.05);
	}
	function createTerrain() {
		// Create physics heightfield
		const gridSize = 101,
			elementSize = 1;
		const matrix = [];
		for (let i = 0; i < gridSize; i++) {
			const row = [];
			for (let j = 0; j < gridSize; j++) {
				let x = i - gridSize / 2,
					z = j - gridSize / 2;
				row.push(getGroundHeight(x, z));
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

		// Create visual terrain mesh
		const size = 100,
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

	// AEROPLANE SPAWN
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

	// UTILITY: create name tag sprite
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

	// UI UPDATE
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

	// LEADERBOARD SYNC
	function setupLeaderboardSync() {
		socket.on("updateLeaderboard", (data) => {
			killCounts = data;
			updateUI();
		});
	}

	// INITIALIZE GAME
	function initGame() {
		killCounts = {};
		// Clear alivePlayers
		alivePlayers = {};
		init();
		createAeroplane();
		createTerrain();
		setupLeaderboardSync();
	}

	// MAIN INITIALIZATION
	function init() {
		// Scene, camera, renderer
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

		// Lights
		const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
		scene.add(ambientLight);
		const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
		directionalLight.position.set(5, 10, 7.5);
		scene.add(directionalLight);

		// Physics world
		world = new CANNON.World();
		world.gravity.set(0, -9.82, 0);
		world.broadphase = new CANNON.NaiveBroadphase();
		world.solver.iterations = 10;

		// Ground physics
		const groundMaterial = new CANNON.Material();
		const groundShape = new CANNON.Plane();
		const groundBody = new CANNON.Body({ mass: 0, material: groundMaterial });
		groundBody.addShape(groundShape);
		groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
		world.addBody(groundBody);

		// Create common terrain
		createTerrain();

		// Connect to server
		socket = io();
		socket.emit("joinGame", { name: playerName });

		// Mark this local player as alive
		alivePlayers[socket.id] = true;

		// Receive environment (trees and guns)
		socket.on("environment", (env) => {
			env.trees.forEach((pos) => {
				createTree(pos.x, pos.z);
			});
			env.guns.forEach((pos) => {
				const gun = createGunModel(pos.x, pos.y, pos.z);
				scene.add(gun);
				guns.push(gun);
			});
		});

		// Receive current players
		socket.on("allPlayers", (playersData) => {
			playersData.forEach((data) => {
				// Mark each remote player as alive
				alivePlayers[data.id] = true;
				if (!otherPlayers[data.id]) {
					const otherMesh = createOtherPlayer();
					otherMesh.userData.id = data.id;
					otherMesh.userData.name = data.name;
					const tag = createNameTag(data.name);
					tag.position.set(0, 3, 0);
					otherMesh.add(tag);
					otherPlayers[data.id] = otherMesh;
					scene.add(otherMesh);
				}
			});
		});

		// Update remote players in real time
		socket.on("playerUpdate", (data) => {
			if (data.id === socket.id) return;
			if (!alivePlayers[data.id]) return; // ignore updates for dead players
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
				const tag = createNameTag(data.name);
				tag.position.set(0, 3, 0);
				otherMesh.add(tag);
				otherPlayers[data.id] = otherMesh;
				scene.add(otherMesh);
			}
			otherMesh.position.set(data.position.x, data.position.y, data.position.z);
			otherMesh.userData.health = data.health;
			// Update gun state for remote player
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

		// Input listeners
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("mousedown", onMouseDown);

		// Spawn aeroplane for entry
		createAeroplane();
		// Create local player
		createPlayer();
		const localTag = createNameTag(playerName);
		localTag.position.set(0, 3, 0);
		player.add(localTag);

		// Allow jumping when colliding with terrain
		playerBody.addEventListener("collide", (e) => {
			if (e.body === hfBody) {
				canJump = true;
			}
		});

		animate();
	}

	// WORLD OBJECT FUNCTIONS

	function createTree(x, z) {
		// Adjust tree's vertical placement so trunk base sits on terrain.
		const baseY = getGroundHeight(x, z);
		const trunkGeo = new THREE.CylinderGeometry(0.25, 0.25, 3, 8);
		const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8b4513 });
		const trunk = new THREE.Mesh(trunkGeo, trunkMat);
		trunk.position.set(0, 1.5, 0);
		const leavesGeo = new THREE.SphereGeometry(1.5, 8, 8);
		const leavesMat = new THREE.MeshLambertMaterial({ color: 0x228b22 });
		const leaves = new THREE.Mesh(leavesGeo, leavesMat);
		leaves.position.set(0, 3.5, 0);
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
		// For world guns, we keep a fixed orientation.
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
		return other;
	}

	// BULLET HANDLING
	function shootBullet() {
		const forward = camera.getWorldDirection(new THREE.Vector3()).normalize();
		let spawnPos = new THREE.Vector3();
		if (player.userData.hasGun && player.userData.gun) {
			player.localToWorld(spawnPos.copy(player.userData.gun.position));
		} else {
			spawnPos.copy(player.position).add(new THREE.Vector3(0, 2, 0));
		}
		const bulletGeom = new THREE.BoxGeometry(0.2, 0.2, 0.2);
		const bulletMat = new THREE.MeshLambertMaterial({ color: 0xff0000 });
		const bulletMesh = new THREE.Mesh(bulletGeom, bulletMat);
		bulletMesh.position.copy(spawnPos);
		scene.add(bulletMesh);
		const bullet = {
			mesh: bulletMesh,
			direction: forward.clone(),
			life: bulletLifetime,
			owner: socket.id,
		};
		bullets.push(bullet);
		socket.emit("bulletFired", { position: spawnPos, direction: forward });
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
		};
		bullets.push(bullet);
	}

	// CROSSHAIR UPDATE
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

	// ANIMATION LOOP
	const clock = new THREE.Clock();
	function animate() {
		if (isDead) return;
		requestAnimationFrame(animate);
		const delta = clock.getDelta();
		world.step(1 / 60, delta, 3);

		// Aeroplane movement
		if (plane) {
			plane.position.x += planeSpeed * delta;
			if (plane.position.x > 50) {
				playerBody.velocity.y = -5;
				scene.remove(plane);
				plane = null;
			} else {
				playerBody.position
					.copy(plane.position)
					.vadd(new CANNON.Vec3(0, -10, 0));
			}
		}

		// Keep player on terrain
		const desiredY =
			getGroundHeight(playerBody.position.x, playerBody.position.z) +
			playerHeightOffset;
		if (playerBody.position.y < desiredY) {
			playerBody.position.y = desiredY;
			playerBody.velocity.y = 0;
		}
		player.position.copy(playerBody.position);
		player.rotation.y = yaw;

		// Movement: Note that A and D are reversed
		const camDir = camera
			.getWorldDirection(new THREE.Vector3())
			.setY(0)
			.normalize();
		const right = new THREE.Vector3()
			.crossVectors(new THREE.Vector3(0, 1, 0), camDir)
			.normalize();
		const speed = 5;
		let vx = 0,
			vz = 0;
		if (keys["KeyW"]) {
			vx += camDir.x * speed;
			vz += camDir.z * speed;
		}
		if (keys["KeyA"]) {
			vx += right.x * speed;
			vz += right.z * speed;
		} // A moves right
		if (keys["KeyD"]) {
			vx -= right.x * speed;
			vz -= right.z * speed;
		} // D moves left
		if (keys["KeyS"]) {
			vx -= camDir.x * speed;
			vz -= camDir.z * speed;
		}
		playerBody.velocity.x = vx;
		playerBody.velocity.z = vz;

		updateCamera();
		updateCrosshair();
		updateUI();

		// Gun pickup: if close enough to a gun, attach it with proper orientation
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

		// Update bullets and check collision with remote players
		for (let i = bullets.length - 1; i >= 0; i--) {
			const bullet = bullets[i];
			bullet.mesh.position.add(
				bullet.direction.clone().multiplyScalar(bulletSpeed * delta)
			);
			bullet.life -= delta;
			for (const id in otherPlayers) {
				if (!alivePlayers[id]) continue;
				const other = otherPlayers[id];
				if (bullet.mesh.position.distanceTo(other.position) < 1) {
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
					scene.remove(bullet.mesh);
					bullets.splice(i, 1);
					break;
				}
			}
			if (bullet.life <= 0) {
				scene.remove(bullet.mesh);
				bullets.splice(i, 1);
			}
		}

		// Check bullet collisions with local player
		for (let i = bullets.length - 1; i >= 0; i--) {
			const bullet = bullets[i];
			if (
				bullet.owner !== socket.id &&
				bullet.mesh.position.distanceTo(player.position) < 1
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
		// Emit local update if still alive
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

	// LOCAL DEATH HANDLING: update alivePlayers and freeze input/updates
	function handleLocalDeath() {
		isDead = true;
		// Remove local player from alive list
		delete alivePlayers[socket.id];
		scene.remove(player);
		window.removeEventListener("keydown", onKeyDown);
		window.removeEventListener("keyup", onKeyUp);
		window.removeEventListener("mousedown", onMouseDown);
		socket.emit("playerDied", { id: socket.id });
		socket.disconnect();
		gameOverOverlay.style.display = "flex";
	}

	// INPUT HANDLERS
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

	// SETUP GLOBAL ALIVE PLAYERS: on receiving new players, mark them as alive.
	function addAlivePlayer(id) {
		alivePlayers[id] = true;
	}

	// MAIN INITIALIZATION END
})();
