import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PreviewCharacter } from '../engine/previewCharacter';
import type { RetargetResult } from '../engine/retarget';

export type PlaybackMode = 'retargeted';

export interface PreviewOptions {
  speed: number;
  loop: boolean;
  inPlace: boolean;
  showSkeleton: boolean;
}

interface Props {
  character: PreviewCharacter | null;
  loading: boolean;
  error: string | null;
  clip: RetargetResult | null;
  clipLabel: string;
  options: PreviewOptions;
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

export default function AnimationPreview({
  character,
  loading,
  error,
  clip,
  clipLabel,
  options,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const skeletonHelperRef = useRef<THREE.SkeletonHelper | null>(null);
  const attachedRootRef = useRef<THREE.Object3D | null>(null);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [scrub, setScrub] = useState(0);
  const [duration, setDuration] = useState(0);

  // ---- renderer / scene bootstrap -------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, Math.max(mount.clientHeight, 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f17);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / Math.max(mount.clientHeight, 1), 0.01, 1000);
    camera.position.set(2.2, 1.6, 3.2);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.8;
    controls.target.set(0, 0.9, 0);
    controls.enablePan = true;
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(2, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x93c5fd, 0.5);
    fill.position.set(-2, 1, -2);
    scene.add(fill);
    scene.add(new THREE.GridHelper(4, 20, 0x334155, 0x1e293b));

    const clock = new THREE.Clock();
    let raf = 0;
    let lastReported = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const mixer = mixerRef.current;
      const action = actionRef.current;
      if (mixer && action) {
        const dt = Math.min(clock.getDelta(), 0.1);
        mixer.update(dt);
        const d = action.getClip().duration || 1;
        const t = ((action.time % d) + d) % d;
        // Only re-render React state when the value visibly changes (avoids
        // re-rendering at 60fps on a mid-range phone).
        const rounded = Math.round(t * 100) / 100;
        if (rounded !== lastReported) {
          lastReported = rounded;
          setScrub(rounded);
        }
      } else {
        clock.getDelta();
      }
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
      rendererRef.current = null;
    };
  }, []);

  // ---- attach character ------------------------------------------------------
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (attachedRootRef.current) {
      scene.remove(attachedRootRef.current);
      attachedRootRef.current = null;
    }
    if (skeletonHelperRef.current) {
      scene.remove(skeletonHelperRef.current);
      skeletonHelperRef.current = null;
    }
    mixerRef.current?.stopAllAction();
    mixerRef.current = null;
    actionRef.current = null;
    setDuration(0);
    setScrub(0);
    setPlaying(false);

    if (!character) return;

    const root = character.sceneRoot;
    scene.add(root);
    attachedRootRef.current = root;

    // SkeletonHelper snapshots the bone hierarchy at construction, so it must be
    // built only after the character is attached to the live scene.
    const helper = new THREE.SkeletonHelper(root);
    const helperMaterial = helper.material as THREE.LineBasicMaterial;
    helperMaterial.depthTest = false;
    helperMaterial.transparent = true;
    helper.renderOrder = 10;
    helper.visible = options.showSkeleton;
    scene.add(helper);
    skeletonHelperRef.current = helper;

    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (cam && controls) {
      controls.target.copy(center);
      cam.position.set(center.x + maxDim * 1.4, center.y + maxDim * 0.35, center.z + maxDim * 2.1);
      cam.near = maxDim / 1000;
      cam.far = maxDim * 100;
      cam.updateProjectionMatrix();
      controls.update();
    }

    const mixer = new THREE.AnimationMixer(root);
    mixerRef.current = mixer;

    return () => {
      mixer.stopAllAction();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character]);

  // ---- attach clip -----------------------------------------------------------
  useEffect(() => {
    const mixer = mixerRef.current;
    if (!mixer) return;
    mixer.stopAllAction();
    actionRef.current = null;
    setPlaying(false);
    setScrub(0);

    if (!clip || clip.clip.tracks.length === 0) {
      setDuration(0);
      return;
    }

    const action = mixer.clipAction(clip.clip);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.timeScale = speed;
    action.reset();
    action.play();
    action.paused = true;
    actionRef.current = action;
    setDuration(clip.clip.duration);
  }, [clip, loop, speed]);

  // live-update speed / loop without restarting
  useEffect(() => {
    if (actionRef.current) actionRef.current.timeScale = speed;
  }, [speed]);

  useEffect(() => {
    if (!actionRef.current) return;
    actionRef.current.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    actionRef.current.clampWhenFinished = !loop;
  }, [loop]);

  useEffect(() => {
    if (skeletonHelperRef.current) skeletonHelperRef.current.visible = options.showSkeleton;
  }, [options.showSkeleton]);

  const togglePlay = useCallback(() => {
    const action = actionRef.current;
    if (!action) return;
    setPlaying((prev) => {
      const next = !prev;
      action.paused = !next;
      return next;
    });
  }, []);

  const stop = useCallback(() => {
    const action = actionRef.current;
    if (!action) return;
    action.stop();
    action.reset();
    action.paused = true;
    action.play();
    setPlaying(false);
    setScrub(0);
  }, []);

  const onScrub = useCallback((value: number) => {
    const action = actionRef.current;
    if (!action) return;
    // Setting the action time and letting the render loop apply it is enough;
    // calling mixer.setTime(0) here would reset the pose to the bind pose.
    action.paused = true;
    action.time = value;
    setPlaying(false);
    setScrub(value);
    mixerRef.current?.update(0);
  }, []);

  const resetCamera = useCallback(() => {
    if (!character) return;
    const box = new THREE.Box3().setFromObject(character.sceneRoot);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!cam || !controls) return;
    cam.position.set(center.x + maxDim * 1.4, center.y + maxDim * 0.35, center.z + maxDim * 2.1);
    controls.target.copy(center);
    controls.update();
  }, [character]);

  const goFullscreen = useCallback(() => {
    const el = mountRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  }, []);

  const progressPct = duration > 0 ? (scrub / duration) * 100 : 0;

  const statusText = useMemo(() => {
    if (loading) return 'Loading character…';
    if (error) return error;
    if (!character) return 'No character loaded yet.';
    if (!clip) return 'Character ready — pick an animation.';
    if (clip.clip.tracks.length === 0) return 'This clip produced no usable tracks.';
    return `${clipLabel} · ${clip.sampledFrames} frames @ ${clip.fps}fps${clip.inPlace ? ' · in-place' : ''}`;
  }, [loading, error, character, clip, clipLabel]);

  return (
    <section className="preview-panel" aria-label="3D animation preview">
      <div className="preview-stage" ref={mountRef} data-testid="preview-stage" />

      <div className="preview-overlay">
        {!character && !loading && (
          <div className="preview-empty">
            <p>Select a character to begin.</p>
          </div>
        )}
        {loading && <div className="preview-empty"><p>⏳ Loading repository character…</p></div>}
        {error && <div className="preview-empty error"><p>{error}</p></div>}
      </div>

      <div className="transport">
        <div className="transport-row">
          <button type="button" className="btn btn-primary" onClick={togglePlay} disabled={!clip || duration === 0}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button type="button" className="btn" onClick={stop} disabled={!clip}>
            ⏹ Stop
          </button>
          <button type="button" className="btn" onClick={resetCamera}>
            ⟲ Reset camera
          </button>
          <button type="button" className="btn" onClick={goFullscreen}>
            ⛶ Fullscreen
          </button>
        </div>

        <div className="transport-row scrub-row">
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.001)}
            step={0.01}
            value={scrub}
            onChange={(e) => onScrub(Number(e.target.value))}
            disabled={!clip || duration === 0}
            aria-label="Timeline scrubber"
            style={{ ['--progress' as string]: `${progressPct}%` }}
          />
          <span className="muted mono">
            {scrub.toFixed(2)}s / {duration.toFixed(2)}s
          </span>
        </div>

        <div className="transport-row wrap">
          <span className="muted">Speed</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${speed === s ? 'chip-active' : ''}`}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
          <label className="check">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
            Loop
          </label>
          <span className="muted small">{statusText}</span>
        </div>
      </div>
    </section>
  );
}
