import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { generateMannequin } from "./mannequin";
import { PoseLandmarker } from "@mediapipe/tasks-vision";

vi.mock("@mediapipe/tasks-vision", () => {
  return {
    PoseLandmarker: {
      POSE_CONNECTIONS: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
    },
  };
});

describe("generateMannequin", () => {
  it("creates a Three.js Group named 'mannequin' and adds it to the scene", () => {
    const scene = new THREE.Scene();
    const landmarks = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      { x: 2, y: 2, z: 2 },
    ];

    const mannequin = generateMannequin(landmarks, scene);

    expect(mannequin).toBeInstanceOf(THREE.Group);
    expect(mannequin.name).toBe("mannequin");
    expect(scene.children).toContain(mannequin);
  });

  it("applies correct coordinate transformation (x=x, y=-y, z=-z)", () => {
    const scene = new THREE.Scene();
    const landmarks = [{ x: 1, y: 2, z: 3 }];

    const mannequin = generateMannequin(landmarks, scene);

    // 1 sphere (joint)
    expect(mannequin.children.length).toBe(1);

    const headMesh = mannequin.children[0] as THREE.Mesh;
    expect(headMesh.position.x).toBe(1);
    expect(headMesh.position.y).toBe(-2);
    expect(headMesh.position.z).toBe(-3);
  });

  it("creates correct number of joints and limbs based on landmarks and connections", () => {
    const scene = new THREE.Scene();
    const landmarks = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      { x: 2, y: 2, z: 2 },
    ];

    const mannequin = generateMannequin(landmarks, scene);

    // 3 joints + 2 connections (defined in the mock above)
    expect(mannequin.children.length).toBe(5);

    // Filter by geometry type to distinguish joints and limbs
    const joints = mannequin.children.filter(
      (child) => (child as THREE.Mesh).geometry instanceof THREE.SphereGeometry
    );
    const limbs = mannequin.children.filter(
      (child) => (child as THREE.Mesh).geometry instanceof THREE.CylinderGeometry
    );

    expect(joints.length).toBe(3);
    expect(limbs.length).toBe(2);
  });

  it("positions limbs correctly between joints", () => {
    const scene = new THREE.Scene();
    const landmarks = [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 }, // 1st connection: length 2 along X
    ];

    // Temporarily override connections to just one
    const originalConnections = PoseLandmarker.POSE_CONNECTIONS;
    PoseLandmarker.POSE_CONNECTIONS = [{ start: 0, end: 1 }];

    const mannequin = generateMannequin(landmarks, scene);

    const limb = mannequin.children.find(
      (child) => (child as THREE.Mesh).geometry instanceof THREE.CylinderGeometry
    ) as THREE.Mesh;

    expect(limb).toBeDefined();

    // Midpoint between (0,0,0) and (2,0,0) is (1,0,0)
    expect(limb.position.x).toBeCloseTo(1);
    expect(limb.position.y).toBeCloseTo(0);
    expect(limb.position.z).toBeCloseTo(0);

    // Restore connections
    PoseLandmarker.POSE_CONNECTIONS = originalConnections;
  });
});
