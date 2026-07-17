import * as THREE from "three";
import { PoseLandmarker } from "@mediapipe/tasks-vision";

export const generateMannequin = (
  worldLandmarks: { x: number; y: number; z: number }[],
  scene: THREE.Scene
) => {
  // Clear previous mannequin objects
  const mannequinGroup = new THREE.Group();
  mannequinGroup.name = "mannequin";
  scene.add(mannequinGroup);

  const material = new THREE.MeshStandardMaterial({
    color: 0x3b82f6,
    roughness: 0.5,
    metalness: 0.1,
  });

  // Create joints (spheres)
  const jointGeometry = new THREE.SphereGeometry(0.04, 16, 16);
  const headGeometry = new THREE.SphereGeometry(0.08, 32, 32);

  worldLandmarks.forEach((landmark, index) => {
    // MediaPipe -> Three.js coordinate mapping
    // MediaPipe: X right, Y down, Z away (depth smaller = closer)
    // Three.js: X right, Y up, Z towards viewer
    const vec = new THREE.Vector3(landmark.x, -landmark.y, -landmark.z);

    const geometry = index === 0 ? headGeometry : jointGeometry;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(vec);
    mannequinGroup.add(mesh);
  });

  // Create connections (capsules/cylinders)
  const connections = PoseLandmarker.POSE_CONNECTIONS;
  const cylinderMaterial = new THREE.MeshStandardMaterial({
    color: 0x93c5fd,
    roughness: 0.5,
    metalness: 0.1,
  });

  connections.forEach((conn) => {
    const start = worldLandmarks[conn.start];
    const end = worldLandmarks[conn.end];

    if (!start || !end) return;

    const startVec = new THREE.Vector3(start.x, -start.y, -start.z);
    const endVec = new THREE.Vector3(end.x, -end.y, -end.z);

    const distance = startVec.distanceTo(endVec);
    // Use a cylinder for the limb
    const cylinderGeometry = new THREE.CylinderGeometry(0.02, 0.02, distance, 8);
    // Cylinder is aligned along Y axis by default.
    const cylinder = new THREE.Mesh(cylinderGeometry, cylinderMaterial);

    // Position at the midpoint
    cylinder.position.copy(startVec).lerp(endVec, 0.5);

    // Make the cylinder point from start to end
    // A cylinder's default orientation is Y-up.
    cylinder.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      endVec.clone().sub(startVec).normalize()
    );

    mannequinGroup.add(cylinder);
  });

  return mannequinGroup;
};
