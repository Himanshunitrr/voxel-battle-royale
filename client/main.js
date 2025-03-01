"use strict";
import * as THREE from "three";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.18.0/dist/cannon-es.js";

// Wrap everything in an IIFE to avoid duplicate declarations.
(() => {
  // ------------------------
  // Global Variables
  // ------------------------
  let scene, camera, renderer, world, socket;
  let player, playerBody;          // Local player
  let hfBody;                      // Cannon.js heightfield (for physics)
  let otherPlayers = {};           // Other players keyed by socket ID
  let guns = [];                   // Guns available in the world
  let bullets = [];                // Active bullets
  
  // Shared per-match leaderboard.
  let killCounts = {};
  
  // UI Elements
  const healthDisplay = document.getElementById("healthDisplay");
  const leaderboardList = document.getElementById("leaderboardList");
  const minimapCanvas = document.getElementById("minimap");
  const minimapCtx = minimapCanvas.getContext("2d");
  
  // Pre-game: Get player name (or assign random)
  let playerName = localStorage.getItem("playerName") || "";
  const preGameOverlay = document.getElementById("preGameOverlay");
  const startGameButton = document.getElementById("startGameButton");
  startGameButton.addEventListener("click", () => {
    const inputName = document.getElementById("playerNameInput").value.trim();
    playerName = inputName !== "" ? inputName : "Player" + Math.floor(Math.random() * 1000);
    localStorage.setItem("playerName", playerName);
    preGameOverlay.style.display = "none";
    initGame();
  });
  if (playerName !== "") {
    preGameOverlay.style.display = "none";
    setTimeout(initGame, 1000);
  }
  
  // ------------------------
  // Camera & Control Settings
  // ------------------------
  let yaw = 0, pitch = 0;
  const mouseSensitivity = 1.0; // We'll compute rotation directly from cursor position.
  // Instead of pointer lock, we compute yaw & pitch from mouse position:
  window.addEventListener("mousemove", (event) => {
    // Map cursor X from 0→window.innerWidth to yaw range (-PI to PI)
    yaw = THREE.MathUtils.lerp(-Math.PI, Math.PI, event.clientX / window.innerWidth);
    // Map cursor Y from 0→window.innerHeight to pitch range (85° to -40°)
    pitch = THREE.MathUtils.lerp(THREE.MathUtils.degToRad(85), THREE.MathUtils.degToRad(-40), event.clientY / window.innerHeight);
  });
  
  // ------------------------
  // Gameplay Parameters
  // ------------------------
  const playerHeightOffset = 1;
  let canJump = false; // Only used while in the aeroplane.
  const jumpImpulse = 8; // Only allowed while in the aeroplane.
  const pickupRange = 2;
  const bulletSpeed = 20;
  const bulletLifetime = 3;
  
  // ------------------------
  // Aeroplane Spawn Parameters
  // ------------------------
  let plane, planeSpeed = 5;
  
  // ------------------------
  // Height Function & Heightfield Creation (for physics)
  // ------------------------
  function getGroundHeight(x, z) {
    return 3 + 3 * Math.sin(x * 0.05) * Math.cos(z * 0.05);
  }
  function createHeightfield() {
    // For physics, we use a grid of size 101×101 (for a 100×100 island)
    const gridSize = 101;
    const elementSize = 1;
    let matrix = [];
    for (let i = 0; i < gridSize; i++) {
      let row = [];
      for (let j = 0; j < gridSize; j++) {
        let x = i - gridSize / 2;
        let z = j - gridSize / 2;
        row.push(getGroundHeight(x, z));
      }
      matrix.push(row);
    }
    const hfShape = new CANNON.Heightfield(matrix, { elementSize });
    hfBody = new CANNON.Body({ mass: 0 });
    hfBody.addShape(hfShape);
    hfBody.position.set(-gridSize / 2 * elementSize, 0, -gridSize / 2 * elementSize);
    world.addBody(hfBody);
  }
  
  // ------------------------
  // Visual Terrain Creation (Smooth)
  // ------------------------
  function createSmoothTerrain() {
    // Create a plane geometry and displace its vertices smoothly.
    const size = 100;
    const segments = 100;
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const vertices = geometry.attributes.position;
    for (let i = 0; i < vertices.count; i++) {
      const x = vertices.getX(i);
      const z = vertices.getZ(i);
      const y = getGroundHeight(x, z);
      vertices.setY(i, y);
    }
    vertices.needsUpdate = true;
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ color: 0x228b22, side: THREE.DoubleSide });
    const terrain = new THREE.Mesh(geometry, material);
    scene.add(terrain);
  }
  
  // ------------------------
  // Aeroplane Spawn Logic
  // ------------------------
  function createAeroplane() {
    plane = new THREE.Group();
    // Use a simple box for the aeroplane body
    const bodyGeo = new THREE.BoxGeometry(4, 1, 1);
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x808080 });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    plane.add(bodyMesh);
    // Wings
    const wingGeo = new THREE.BoxGeometry(1, 0.2, 3);
    const wingMat = new THREE.MeshLambertMaterial({ color: 0x606060 });
    const leftWing = new THREE.Mesh(wingGeo, wingMat);
    leftWing.position.set(-1, 0, 0);
    plane.add(leftWing);
    const rightWing = new THREE.Mesh(wingGeo, wingMat);
    rightWing.position.set(1, 0, 0);
    plane.add(rightWing);
    // For a 100×100 island, spawn from -50 to +50. (Here we spawn at -50)
    plane.position.set(-50, 80, 0);
    scene.add(plane);
    window.plane = plane;
  }
  
  // ------------------------
  // Create Name Tag (Sprite) for Player Names
  // ------------------------
  function createNameTag(name) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = "Bold 24px Arial";
    const textWidth = context.measureText(name).width;
    canvas.width = textWidth;
    canvas.height = 30;
    context.font = "Bold 24px Arial";
    context.fillStyle = "white";
    context.fillText(name, 0, 24);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(canvas.width / 50, canvas.height / 50, 1);
    return sprite;
  }
  
  // ------------------------
  // UI Update Functions
  // ------------------------
  function updateUI() {
    healthDisplay.textContent = "Health: " + (player ? player.userData.health : 100);
    const entries = Object.entries(killCounts);
    entries.sort((a, b) => b[1] - a[1]);
    let html = "";
    for (let i = 0; i < Math.min(3, entries.length); i++) {
      html += `<li>${entries[i][0]}: ${entries[i][1]}</li>`;
    }
    leaderboardList.innerHTML = html;
    // Update minimap using a simple mapping.
    minimapCtx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
    minimapCtx.strokeStyle = "#fff";
    minimapCtx.strokeRect(0, 0, minimapCanvas.width, minimapCanvas.height);
    const mapScale = minimapCanvas.width / 100;
    const mapX = (player.position.x + 50) * mapScale;
    const mapY = (player.position.z + 50) * mapScale;
    minimapCtx.fillStyle = "red";
    minimapCtx.beginPath();
    minimapCtx.arc(mapX, mapY, 5, 0, Math.PI * 2);
    minimapCtx.fill();
  }
  function updateMinimapAndUI() {
    updateUI();
  }
  
  // ------------------------
  // Leaderboard Sync via Server
  // ------------------------
  function setupLeaderboardSync() {
    socket.on("updateLeaderboard", (data) => {
      killCounts = data;
      updateUI();
    });
  }
  
  // ------------------------
  // Game Initialization (after pre-game)
  // ------------------------
  function initGame() {
    killCounts = {};
    init();
    createAeroplane();
    // Create smooth terrain for visuals.
    createSmoothTerrain();
    setupLeaderboardSync();
  }
  
  // ------------------------
  // Main Initialization Function
  // ------------------------
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
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 7.5);
    scene.add(directionalLight);
    
    world = new CANNON.World();
    world.gravity.set(0, -9.82, 0);
    world.broadphase = new CANNON.NaiveBroadphase();
    world.solver.iterations = 10;
    
    // Ground plane for physics fallback.
    const groundMaterial = new CANNON.Material();
    const groundShape = new CANNON.Plane();
    const groundBody = new CANNON.Body({ mass: 0, material: groundMaterial });
    groundBody.addShape(groundShape);
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);
    
    createHeightfield();
    
    socket = io();
    socket.emit("joinGame", { name: playerName });
    socket.on("playerUpdate", (data) => {
      if (data.id !== socket.id) {
        if (!otherPlayers[data.id]) {
          const otherMesh = createOtherPlayer();
          otherMesh.userData.id = data.id;
          otherMesh.userData.name = data.name || "Unknown";
          const nameTag = createNameTag(otherMesh.userData.name);
          nameTag.position.set(0, 3, 0);
          otherMesh.add(nameTag);
          scene.add(otherMesh);
          otherPlayers[data.id] = otherMesh;
        }
        otherPlayers[data.id].position.set(
          data.position.x,
          data.position.y,
          data.position.z
        );
        otherPlayers[data.id].userData.health = data.health;
      }
    });
    socket.on("playerDisconnected", (data) => {
      if (otherPlayers[data.id]) {
        scene.remove(otherPlayers[data.id]);
        delete otherPlayers[data.id];
      }
    });
    socket.on("bulletFired", (data) => {
      spawnBullet(data.position, data.direction, data.id);
    });
    
    // We no longer use pointer lock—mouse position drives view.
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    
    createAeroplane();
    // Instead of voxel island, we now use smooth terrain (created in initGame via createSmoothTerrain).
    // However, you can also call createIsland() if you want a voxel version.
    spawnTrees();
    spawnGuns();
    createPlayer();
    
    // Attach local name tag.
    player.userData.name = playerName;
    const localNameTag = createNameTag(playerName);
    localNameTag.position.set(0, 3, 0);
    player.add(localNameTag);
    
    // Set up collision listener for the heightfield.
    playerBody.addEventListener("collide", (e) => {
      if (e.body === hfBody) { canJump = true; }
    });
    
    animate();
  }
  
  // ------------------------
  // Create Island (if needed; not used when using smooth terrain)
  // ------------------------
  function createIsland() {
    const island = new THREE.Group();
    const islandSize = 100;
    const voxelSize = 1;
    const voxelGeo = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
    const voxelMat = new THREE.MeshLambertMaterial({ color: 0x228b22 });
    for (let x = -islandSize / 2; x < islandSize / 2; x++) {
      for (let z = -islandSize / 2; z < islandSize / 2; z++) {
        const h = Math.floor(3 + 3 * Math.sin(x * 0.05) * Math.cos(z * 0.05));
        for (let y = 0; y < h; y++) {
          const voxel = new THREE.Mesh(voxelGeo, voxelMat);
          voxel.position.set(x * voxelSize, y * voxelSize, z * voxelSize);
          island.add(voxel);
        }
      }
    }
    scene.add(island);
  }
  
  // ------------------------
  // Pointer Lock & Mouse Handling (removed pointer lock—using absolute mouse position)
  // ------------------------
  // (We no longer use pointer lock events. The mousemove listener above handles view rotation.)
  
  // ------------------------
  // Keyboard & Mouse Input (Single Declaration)
  // ------------------------
  const keys = {};
  function onKeyDown(event) {
    if (event.repeat) return;
    keys[event.code] = true;
    // Allow jump only while in the aeroplane.
    if (event.code === "Space") {
      if (plane) {
        playerBody.velocity.y = jumpImpulse;
        scene.remove(plane);
        plane = null;
        console.log("Jump from aeroplane!");
      }
    }
    if (event.code === "KeyQ") {
      isRightShoulder = !isRightShoulder;
    }
  }
  function onKeyUp(event) {
    keys[event.code] = false;
  }
  function onMouseDown(event) {
    if (player.userData.hasGun) { shootBullet(); }
  }
  
  // ------------------------
  // Camera Update Function
  // ------------------------
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
  
  // ------------------------
  // Bullet Handling
  // ------------------------
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
    bulletMesh.position.copy(new THREE.Vector3(position.x, position.y, position.z));
    scene.add(bulletMesh);
    const bullet = {
      mesh: bulletMesh,
      direction: new THREE.Vector3(direction.x, direction.y, direction.z),
      life: bulletLifetime,
      owner: ownerId,
    };
    bullets.push(bullet);
  }
  
  // ------------------------
  // Crosshair Update
  // ------------------------
  function updateCrosshair() {
    const crosshair = document.getElementById("crosshair");
    const aimDistanceFixed = 10;
    const aimPoint = camera.position
      .clone()
      .add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(aimDistanceFixed));
    aimPoint.project(camera);
    const x = (aimPoint.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-aimPoint.y * 0.5 + 0.5) * window.innerHeight;
    crosshair.style.left = `${x - 5}px`;
    crosshair.style.top = `${y - 5}px`;
  }
  
  // ------------------------
  // Animation and Game Loop
  // ------------------------
  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    
    // Aeroplane movement & forced drop:
    if (plane) {
      plane.position.x += planeSpeed * delta;
      if (plane.position.x > 50) {
        if (plane) { playerBody.velocity.y = -5; }
        scene.remove(plane);
        plane = null;
      } else {
        if (plane) {
          playerBody.position.copy(plane.position).vadd(new CANNON.Vec3(0, -10, 0));
        }
      }
    }
    
    world.step(delta);
    
    // Manual ground check: ensure player stays above terrain.
    const desiredY = getGroundHeight(playerBody.position.x, playerBody.position.z) + playerHeightOffset;
    if (playerBody.position.y < desiredY) {
      playerBody.position.y = desiredY;
      playerBody.velocity.y = 0;
    }
    
    player.position.copy(playerBody.position);
    player.rotation.y = yaw;
    
    // Movement: update continuously based on camera's horizontal view.
    const camDir = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), camDir).normalize();
    const speed = 5;
    let vx = 0, vz = 0;
    if (keys["KeyW"]) { vx += camDir.x * speed; vz += camDir.z * speed; }
    if (keys["KeyS"]) { vx -= camDir.x * speed; vz -= camDir.z * speed; }
    if (keys["KeyA"]) { vx -= right.x * speed; vz -= right.z * speed; }
    if (keys["KeyD"]) { vx += right.x * speed; vz += right.z * speed; }
    playerBody.velocity.x = vx;
    playerBody.velocity.z = vz;
    
    updateCamera();
    updateCrosshair();
    updateUI();
    
    // Gun pickup.
    for (let i = guns.length - 1; i >= 0; i--) {
      const gun = guns[i];
      if (!player.userData.hasGun && player.position.distanceTo(gun.position) < pickupRange) {
        player.add(gun);
        gun.position.set(0.7, 1.25, 0);
        player.userData.hasGun = true;
        player.userData.gun = gun;
        guns.splice(i, 1);
        console.log("Gun picked up!");
      }
    }
    
    // Update bullets.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const bullet = bullets[i];
      bullet.mesh.position.add(bullet.direction.clone().multiplyScalar(bulletSpeed * delta));
      bullet.life -= delta;
      for (const id in otherPlayers) {
        const other = otherPlayers[id];
        if (bullet.mesh.position.distanceTo(other.position) < 1) {
          if (bullet.owner === socket.id) { recordKill(playerName); }
          other.userData.health = (other.userData.health || 100) - 20;
          console.log("Player", id, "hit! Health:", other.userData.health);
          if (other.userData.health <= 0) {
            scene.remove(other);
            delete otherPlayers[id];
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
    
    socket.emit("playerUpdate", {
      id: socket.id,
      position: player.position,
      health: player.userData.health,
      name: playerName,
      hasGun: player.userData.hasGun,
    });
    
    renderer.render(scene, camera);
    updateMinimapAndUI();
  }
  
  animate();
  updateUI();
  updateMinimapAndUI();
  // (initGame() is triggered after pre-game.)
  
  // ------------------------
  // Keyboard & Mouse Input (Single Declaration)
  // ------------------------
  const keys = {};
  function onKeyDown(event) {
    if (event.repeat) return;
    keys[event.code] = true;
    // Allow jump only if the player is still in the aeroplane.
    if (event.code === "Space") {
      if (plane) {
        playerBody.velocity.y = jumpImpulse;
        scene.remove(plane);
        plane = null;
        console.log("Jump from aeroplane!");
      }
    }
    if (event.code === "KeyQ") {
      isRightShoulder = !isRightShoulder;
    }
  }
  function onKeyUp(event) {
    keys[event.code] = false;
  }
  function onMouseDown(event) {
    if (player.userData.hasGun) { shootBullet(); }
  }
  
  // ------------------------
  // End of IIFE
})();
