import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { usePoseStore } from "../../store/usePoseStore";
import { generateMannequin } from "./mannequin";
import { computeActivations, aggregateByMuscle } from "./muscles";
import { MuscleLegend, type MuscleActivation } from "./MuscleLegend";
import { calculateCameraFit } from "./cameraFit";

export const PoseViewer3D: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldLandmarks = usePoseStore((s) => s.worldLandmarks);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  const [selectedMuscle, setSelectedMuscle] = useState<string | null>(null);
  const [hoveredMuscles, setHoveredMuscles] = useState<{
    ids: string[];
    x: number;
    y: number;
  } | null>(null);

  const muscles: MuscleActivation[] = useMemo(
    () =>
      worldLandmarks && worldLandmarks.length > 0
        ? aggregateByMuscle(computeActivations(worldLandmarks))
        : [],
    [worldLandmarks]
  );

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
    cameraRef.current = camera;

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
    controlsRef.current = controls;

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
      cameraRef.current = null;
      controlsRef.current = null;
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

      const newMannequin = scene.getObjectByName("mannequin");
      if (newMannequin && cameraRef.current && controlsRef.current) {
        const box = new THREE.Box3().setFromObject(newMannequin);
        const { position, target } = calculateCameraFit(box, cameraRef.current.fov);
        cameraRef.current.position.copy(position);
        controlsRef.current.target.copy(target);
        controlsRef.current.update();
      }
    }
  }, [worldLandmarks]);

  // Highlight selected muscle
  useEffect(() => {
    if (!sceneRef.current) return;
    const mannequin = sceneRef.current.getObjectByName("mannequin");
    if (!mannequin) return;

    mannequin.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const meshMuscles = child.userData.muscles as string[] | undefined;
        const mat = child.material as THREE.MeshStandardMaterial;

        if (mat.userData.originalEmissiveIntensity === undefined) {
          mat.userData.originalEmissiveIntensity = mat.emissiveIntensity;
          mat.userData.originalOpacity = mat.opacity;
          mat.userData.originalTransparent = mat.transparent;
        }

        if (selectedMuscle) {
          if (meshMuscles && meshMuscles.includes(selectedMuscle)) {
            mat.emissiveIntensity = mat.userData.originalEmissiveIntensity + 0.5;
            mat.opacity = 1;
            mat.transparent = mat.userData.originalTransparent;
          } else {
            mat.emissiveIntensity = 0;
            mat.opacity = 0.2;
            mat.transparent = true;
          }
        } else {
          mat.emissiveIntensity = mat.userData.originalEmissiveIntensity;
          mat.opacity = mat.userData.originalOpacity;
          mat.transparent = mat.userData.originalTransparent;
        }
        mat.needsUpdate = true;
      }
    });
  }, [selectedMuscle, worldLandmarks]);

  // Raycaster for hover
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handlePointerMove = (e: PointerEvent) => {
      if (!cameraRef.current || !sceneRef.current) return;

      const rect = mount.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, cameraRef.current);

      const mannequin = sceneRef.current.getObjectByName("mannequin");
      if (!mannequin) {
        setHoveredMuscles(null);
        return;
      }

      const intersects = raycaster.intersectObject(mannequin, true);
      let found = false;
      for (const hit of intersects) {
        const ids = hit.object.userData.muscles as string[] | undefined;
        if (ids && ids.length > 0) {
          setHoveredMuscles({ ids, x: e.clientX - rect.left, y: e.clientY - rect.top });
          found = true;
          break;
        }
      }
      if (!found) {
        setHoveredMuscles(null);
      }
    };

    const handlePointerLeave = () => {
      setHoveredMuscles(null);
    };

    mount.addEventListener("pointermove", handlePointerMove);
    mount.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      mount.removeEventListener("pointermove", handlePointerMove);
      mount.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, []);

  return (
    <div className="w-full flex flex-col gap-3">
      <div className="w-full h-full min-h-[400px] rounded-lg overflow-hidden border border-gray-200 relative">
        <div ref={mountRef} className="absolute inset-0" />
        {!worldLandmarks && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50/80 pointer-events-none">
            <p className="text-gray-500 font-medium">
              画像をアップロードすると3Dモデルが表示されます
            </p>
          </div>
        )}
        {hoveredMuscles && (
          <div
            className="absolute pointer-events-none bg-gray-900/90 text-white text-xs p-2 rounded shadow-lg transform -translate-x-1/2 -translate-y-full mt-[-10px] whitespace-nowrap z-10"
            style={{ left: hoveredMuscles.x, top: hoveredMuscles.y }}
          >
            {hoveredMuscles.ids.map((id) => {
              const m = muscles.find((m) => m.id === id);
              return m ? (
                <div key={id} className="flex justify-between gap-4">
                  <span>{m.label}</span>
                  <span className="font-mono text-gray-300">
                    {Math.round(m.value * 100)}
                  </span>
                </div>
              ) : null;
            })}
          </div>
        )}
      </div>
      {muscles.length > 0 && (
        <MuscleLegend
          activations={muscles}
          selectedMuscle={selectedMuscle}
          onSelectMuscle={setSelectedMuscle}
        />
      )}
    </div>
  );
};
