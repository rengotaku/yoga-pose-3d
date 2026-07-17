import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { usePoseStore } from "../../store/usePoseStore";
import { generateMannequin } from "./mannequin";

export const PoseViewer3D: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldLandmarks = usePoseStore((s) => s.worldLandmarks);
  const sceneRef = useRef<THREE.Scene | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f4f6); // gray-100
    sceneRef.current = scene;

    // Camera
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 1, 3); // Slightly elevated

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(2, 5, 3);
    scene.add(directionalLight);

    // Grid Floor
    const gridHelper = new THREE.GridHelper(10, 20, 0x000000, 0x000000);
    gridHelper.material.opacity = 0.1;
    gridHelper.material.transparent = true;
    gridHelper.position.y = -1; // Lower the grid a bit so it sits below the mannequin
    scene.add(gridHelper);

    // Animation Loop
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Handle Resize
    const handleResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationFrameId);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Update mannequin when landmarks change
  useEffect(() => {
    if (!sceneRef.current) return;
    const scene = sceneRef.current;

    // Remove old mannequin if exists
    const oldMannequin = scene.getObjectByName("mannequin");
    if (oldMannequin) {
      scene.remove(oldMannequin);
    }

    if (worldLandmarks && worldLandmarks.length > 0) {
      generateMannequin(worldLandmarks, scene);
    }
  }, [worldLandmarks]);

  return (
    <div className="w-full h-full min-h-[400px] rounded-lg overflow-hidden border border-gray-200 relative">
      <div ref={mountRef} className="absolute inset-0" />
      {!worldLandmarks && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50/80 pointer-events-none">
          <p className="text-gray-500 font-medium">
            画像をアップロードすると3Dモデルが表示されます
          </p>
        </div>
      )}
    </div>
  );
};
