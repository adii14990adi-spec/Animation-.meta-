import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LoadedCharacterSession } from '../engine/types';

interface Props {
  session: LoadedCharacterSession | null;
  loading: boolean;
  error: string | null;
  selectedBoneName: string | null;
  onSelectBone: (name: string | null) => void;
}

export default function CharacterViewer({ session, loading, error, selectedBoneName, onSelectBone }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const skeletonHelperRef = useRef<THREE.SkeletonHelper | null>(null);
  const markerRef = useRef<THREE.Mesh | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showWireframe, setShowWireframe] = useState(false);
  const [hasScene, setHasScene] = useState(false);

  // Init renderer once
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f17);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / Math.max(mount.clientHeight, 1), 0.01, 1000);
    camera.position.set(1.5, 1.2, 2.5);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.9, 0);
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(2, 3, 2);
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0x93c5fd, 0.5);
    fill.position.set(-2, 1, -2);
    scene.add(fill);

    const grid = new THREE.GridHelper(4, 20, 0x334155, 0x1e293b);
    scene.add(grid);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      // Keep bone marker glued to selected bone
      if (markerRef.current && session?.sceneRoot) {
        const bone = findBone(session.sceneRoot, selectedBoneName);
        if (bone) {
          bone.getWorldPosition(markerRef.current.position);
        }
      }
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    // Tap/click bone picking (works with touch on Android Chrome)
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointerDown = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const bones: THREE.Bone[] = [];
      if (session?.sceneRoot) {
        session.sceneRoot.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone); });
      }
      const hits = raycaster.intersectObjects(bones, false);
      if (hits.length > 0) onSelectBone(hits[0].object.name || null);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach / detach session scene
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // Remove previous character group
    const prev = scene.getObjectByName('__inspected_character__');
    if (prev) scene.remove(prev);

    if (!session?.sceneRoot) {
      setHasScene(false);
      skeletonHelperRef.current = null;
      return;
    }
    const root = session.sceneRoot;
    root.name = '__inspected_character__';
    scene.add(root);
    setHasScene(true);

    // Frame the character
    const box = new THREE.Box3().setFromObject(root);
    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.5);
      const cam = cameraRef.current;
      const controls = controlsRef.current;
      if (cam && controls) {
        const dist = maxDim * 2.2;
        cam.position.set(center.x + dist * 0.6, center.y + dist * 0.4, center.z + dist * 0.8);
        controls.target.copy(center);
        controls.update();
      }
    }

    const helper = new THREE.SkeletonHelper(root);
    (helper.material as THREE.Material).depthTest = false;
    helper.renderOrder = 999;
    scene.add(helper);
    skeletonHelperRef.current = helper;
    helper.visible = showSkeleton;

    return () => {
      if (helper.parent) helper.parent.remove(helper);
      if (root.parent) root.parent.remove(root);
      skeletonHelperRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Wireframe toggle
  useEffect(() => {
    if (!session?.sceneRoot) return;
    session.sceneRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => { if (m && 'wireframe' in m) (m as THREE.MeshStandardMaterial).wireframe = showWireframe; });
      }
    });
  }, [session, showWireframe]);

  useEffect(() => {
    if (skeletonHelperRef.current) skeletonHelperRef.current.visible = showSkeleton;
  }, [showSkeleton]);

  // Bone highlight marker
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (markerRef.current) {
      scene.remove(markerRef.current);
      (markerRef.current.geometry as THREE.BufferGeometry).dispose();
      (markerRef.current.material as THREE.Material).dispose();
      markerRef.current = null;
    }
    if (!selectedBoneName || !session?.sceneRoot) return;
    const bone = findBone(session.sceneRoot, selectedBoneName);
    if (!bone) return;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false }),
    );
    marker.renderOrder = 1000;
    bone.getWorldPosition(marker.position);
    scene.add(marker);
    markerRef.current = marker;
  }, [selectedBoneName, session]);

  const resetCamera = () => {
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!cam || !controls || !session?.sceneRoot) return;
    const box = new THREE.Box3().setFromObject(session.sceneRoot);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const dist = maxDim * 2.2;
    cam.position.set(center.x + dist * 0.6, center.y + dist * 0.4, center.z + dist * 0.8);
    controls.target.copy(center);
    controls.update();
  };

  return (
    <div className="viewer-card">
      <div className="viewer-toolbar" role="toolbar" aria-label="3D viewer controls">
        <button type="button" className="btn btn-sm" onClick={resetCamera} disabled={!hasScene}>⟲ Reset camera</button>
        <label className="toggle">
          <input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} />
          Skeleton
        </label>
        <label className="toggle">
          <input type="checkbox" checked={showWireframe} onChange={(e) => setShowWireframe(e.target.checked)} />
          Wireframe
        </label>
        {selectedBoneName && (
          <span className="bone-chip">
            Bone: <code>{selectedBoneName}</code>
            <button type="button" className="chip-x" onClick={() => onSelectBone(null)} aria-label="Clear bone selection">×</button>
          </span>
        )}
      </div>
      <div className="viewer-canvas" ref={mountRef}>
        {loading && <div className="viewer-overlay"><span className="spinner" /> Loading &amp; inspecting…</div>}
        {!loading && error && <div className="viewer-overlay viewer-error">⚠️ {error}</div>}
        {!loading && !error && !hasScene && (
          <div className="viewer-overlay viewer-empty">
            <p>No character loaded yet.</p>
            <p className="muted">Upload a <code>.gltf + .bin</code> bundle or tap “Load repository character”.</p>
            <p className="muted">Drag to rotate · Pinch / scroll to zoom · Tap a bone to highlight it.</p>
          </div>
        )}
      </div>
      <p className="viewer-hint muted">Touch: 1 finger rotate · 2 finger pinch zoom / pan. Mouse: drag rotate · wheel zoom · right-drag pan.</p>
    </div>
  );
}

function findBone(root: THREE.Object3D, name: string | null): THREE.Bone | null {
  if (!name) return null;
  let found: THREE.Bone | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Bone).isBone && o.name === name) found = o as THREE.Bone;
  });
  return found;
}
