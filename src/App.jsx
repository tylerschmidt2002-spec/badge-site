// src/App.jsx
import * as THREE from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, extend, useFrame, useThree } from "@react-three/fiber";
import { Environment, useGLTF, useTexture } from "@react-three/drei";
import {
  BallCollider,
  CuboidCollider,
  Physics,
  RigidBody,
  useRopeJoint,
  useSphericalJoint,
} from "@react-three/rapier";
import { MeshLineGeometry, MeshLineMaterial } from "meshline";

extend({ MeshLineGeometry, MeshLineMaterial });

useGLTF.preload("/finalbaseballcard.glb");
useTexture.preload("/band.jpg");

export default function App() {
  return (
    <div style={{ width: "100vw", height: "100vh", touchAction: "none" }}>
      <Canvas
        style={{ width: "100%", height: "100%", touchAction: "none" }} // IMPORTANT for iframe + touch
        camera={{ position: [0, 0.3, 13], fov: 25 }}
      >
        <color attach="background" args={["#597d70"]} />

        <ambientLight intensity={0.9} />
        <directionalLight position={[6, 10, 6]} intensity={1.2} />
        <directionalLight position={[-6, 5, -6]} intensity={0.7} />
        <Environment preset="city" />

        <Physics gravity={[0, -40, 0]} timeStep={1 / 60} interpolate>
          <BandAndCard />
        </Physics>
      </Canvas>
    </div>
  );
}

/**
 * Small components so Rapier joint hooks are NOT called in a loop in the same component.
 * (Hook rules stay clean + stable.)
 */
function RopeLink({ a, b, length }) {
  useRopeJoint(a, b, [[0, 0, 0], [0, 0, 0], length]);
  return null;
}
function SphericalLink({ a, b, anchorA, anchorB }) {
  useSphericalJoint(a, b, [anchorA, anchorB]);
  return null;
}

function BandAndCard({
  // Rope tuning
  segmentLength = 0.7,
  segments = 7,
  rigY = 6.2,

  // Smoothing
  maxSpeed = 45,
  minSpeed = 12,
}) {
  // ---- refs ----
  const band = useRef();
  const fixed = useRef();
  const joints = useRef([]);
  const card = useRef();

  // layout anchor (pure layout, NOT inside the GLB)
  const layoutAnchor = useRef();

  // rigid strap stub at clip
  const strapStub = useRef();
  const strapStubGeo = useMemo(() => new THREE.PlaneGeometry(0.16, 0.4), []);

  // flip
  const modelGroup = useRef();
  const [flipped, setFlipped] = useState(false);
  const targetRotY = useRef(0);

  // drag
  const [dragged, drag] = useState(false);
  const [hovered, hover] = useState(false);

  const pointerDown = useRef(false);
  const dragStarted = useRef(false);
  const downXY = useRef([0, 0]);
  const dragOffset = useRef(new THREE.Vector3());
  const CLICK_DRAG_THRESHOLD = 6;

  // temp vectors
  const vec = useMemo(() => new THREE.Vector3(), []);
  const dir = useMemo(() => new THREE.Vector3(), []);
  const ang = useMemo(() => new THREE.Vector3(), []);
  const rot = useMemo(() => new THREE.Vector3(), []);
  const hookWorld = useMemo(() => new THREE.Vector3(), []);
  const tmpA = useMemo(() => new THREE.Vector3(), []);
  const tmpB = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const q = useMemo(() => new THREE.Quaternion(), []);

  // ---- assets ----
  const { size, viewport } = useThree();
  const { width, height } = size;
  const { scene } = useGLTF("/finalbaseballcard.glb");
  const texture = useTexture("/band.jpg");
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;

  // ---- responsive positioning ----
  const RIGHT_MARGIN = 2.2;
  const rigX = viewport.width / 2 - RIGHT_MARGIN;

  // ---- curve for meshline ----
  const [curve] = useState(
    () =>
      new THREE.CatmullRomCurve3(
        Array.from({ length: segments + 2 }, () => new THREE.Vector3())
      )
  );
  curve.curveType = "centripetal";

  // ---- physics props ----
  const segmentProps = {
    type: "dynamic",
    canSleep: true,
    colliders: false,
    angularDamping: 5,
    linearDamping: 5,
  };

  const nearHookProps = {
    ...segmentProps,
    angularDamping: 14,
    linearDamping: 10,
  };

  const nearCardProps = {
    ...segmentProps,
    angularDamping: 10,
    linearDamping: 8,
  };

  // Ensure stable number of refs
  if (joints.current.length !== segments) {
    joints.current = Array.from({ length: segments }, () => ({ current: null }));
  }

  // Cursor feedback
  useEffect(() => {
    if (!hovered) return;
    document.body.style.cursor = dragged ? "grabbing" : "grab";
    return () => (document.body.style.cursor = "auto");
  }, [hovered, dragged]);

  /**
   * RESET (layout-driven)
   * IMPORTANT FIX: guard against 0/very small size during initial iframe/prod layout.
   */
  useEffect(() => {
    if (!fixed.current || !card.current) return;
    if (!joints.current?.length) return;

    // IMPORTANT: prevents the “falls off” / wrong spawn during first production layout tick
    if (width < 10 || height < 10) return;

    const ax = rigX;
    const ay = rigY;
    const az = 0;

    // fixed
    fixed.current.setTranslation({ x: ax, y: ay, z: az }, true);
    fixed.current.setLinvel({ x: 0, y: 0, z: 0 }, true);
    fixed.current.setAngvel({ x: 0, y: 0, z: 0 }, true);

    // joints
    joints.current.forEach((ref, i) => {
      const j = ref.current;
      if (!j) return;

      j.setTranslation({ x: ax, y: ay - (i + 1) * segmentLength, z: az }, true);
      j.setLinvel({ x: 0, y: 0, z: 0 }, true);
      j.setAngvel({ x: 0, y: 0, z: 0 }, true);
      j.lerped = undefined;
    });

    // card
    card.current.setTranslation(
      { x: ax, y: ay - (segments + 1) * segmentLength - 0.4, z: az },
      true
    );
    card.current.setLinvel({ x: 0, y: 0, z: 0 }, true);
    card.current.setAngvel({ x: 0, y: 0, z: 0 }, true);

    fixed.current.wakeUp();
    joints.current.forEach((r) => r.current?.wakeUp());
    card.current.wakeUp();
  }, [width, height, rigX, rigY, segments, segmentLength]);

  // Pointer helpers (DOM element capture — required for iframes)
  const capturePointer = (e) => {
    const el = e?.nativeEvent?.target;
    if (el?.setPointerCapture) el.setPointerCapture(e.pointerId);
  };
  const releasePointer = (e) => {
    const el = e?.nativeEvent?.target;
    if (el?.releasePointerCapture) el.releasePointerCapture(e.pointerId);
  };

  useFrame((state, delta) => {
    // 1) GLUE PHYSICS ANCHOR TO *LAYOUT* ANCHOR
    if (layoutAnchor.current && fixed.current) {
      layoutAnchor.current.getWorldPosition(hookWorld);

      fixed.current.setTranslation(
        { x: hookWorld.x, y: hookWorld.y, z: hookWorld.z },
        true
      );
      fixed.current.setLinvel({ x: 0, y: 0, z: 0 }, true);
      fixed.current.setAngvel({ x: 0, y: 0, z: 0 }, true);
      fixed.current.wakeUp();
    }

    // 2) Dragging
    if (dragged) {
      vec.set(state.pointer.x, state.pointer.y, 0.5).unproject(state.camera);
      dir.copy(vec).sub(state.camera.position).normalize();
      vec.add(dir.multiplyScalar(state.camera.position.length()));

      [card, fixed, ...joints.current].forEach((r) => r.current?.wakeUp());

      card.current?.setNextKinematicTranslation({
        x: vec.x - dragged.x,
        y: vec.y - dragged.y,
        z: vec.z - dragged.z,
      });
    }

    // 3) Smooth joints + update strap curve
    if (fixed.current && card.current && band.current) {
      joints.current.forEach((ref, idx) => {
        if (!ref.current) return;

        if (!ref.current.lerped) {
          ref.current.lerped = new THREE.Vector3().copy(ref.current.translation());
        }

        const isMiddle = idx > 0 && idx < segments - 1;
        if (!isMiddle) return;

        const d = ref.current.lerped.distanceTo(ref.current.translation());
        const clamped = Math.max(0.1, Math.min(1, d));
        ref.current.lerped.lerp(
          ref.current.translation(),
          delta * (minSpeed + clamped * (maxSpeed - minSpeed))
        );
      });

      if (!fixed.current.lerped) {
        fixed.current.lerped = new THREE.Vector3().copy(fixed.current.translation());
      }
      fixed.current.lerped.lerp(
        fixed.current.translation(),
        1 - Math.pow(0.001, delta)
      );

      const top = fixed.current.lerped;
      const first = joints.current[0].current;
      const last = joints.current[segments - 1].current;
      if (!first || !last) return;

      tmpA.copy(last.translation());

      const aboveRB = joints.current[segments - 2]?.current;
      if (aboveRB) tmpB.copy(aboveRB.translation());
      else tmpB.copy(tmpA).addScaledVector(up, 0.001);

      dir.copy(tmpB).sub(tmpA);
      if (dir.lengthSq() > 1e-6) dir.normalize();
      else dir.copy(up);

      const STUB_LEN = 0.22;

      const start = vec.copy(tmpA).addScaledVector(dir, STUB_LEN);
      curve.points[0].copy(start);

      if (strapStub.current) {
        strapStub.current.position.copy(tmpA).addScaledVector(dir, STUB_LEN * 0.5);
        q.setFromUnitVectors(up, dir);
        strapStub.current.quaternion.copy(q);
      }

      for (let i = 1; i <= segments - 1; i++) {
        const j = joints.current[segments - 1 - i]?.current;
        if (!j) break;
        curve.points[i].copy(j.lerped ?? j.translation());
      }

      const underHook = curve.points[segments];
      underHook.copy(first.translation()).lerp(top, 0.5);

      curve.points[segments + 1].copy(top);

      band.current.geometry.setPoints(curve.getPoints(90));

      ang.copy(card.current.angvel());
      rot.copy(card.current.rotation());
      card.current.setAngvel({ x: ang.x, y: ang.y - rot.y * 0.25, z: ang.z });
    }

    // 4) Flip animation
    if (modelGroup.current) {
      modelGroup.current.rotation.y = THREE.MathUtils.lerp(
        modelGroup.current.rotation.y,
        targetRotY.current,
        1 - Math.pow(0.001, delta)
      );
    }
  });

  // initial positions
  const initialAx = rigX;
  const initialAy = rigY;
  const initialAz = 0;

  return (
    <>
      {/* PURE LAYOUT ANCHOR (drives physics anchor) */}
      <group ref={layoutAnchor} position={[rigX, rigY, 0]} />

      {/* Fixed hook/anchor (physics) */}
      <RigidBody
        ref={fixed}
        type="fixed"
        position={[initialAx, initialAy, initialAz]}
        {...nearHookProps}
      />

      {/* Rope segment bodies */}
      {joints.current.map((ref, i) => (
        <RigidBody
          key={i}
          ref={ref}
          position={[initialAx, initialAy - (i + 1) * segmentLength, initialAz]}
          {...(i <= 1
            ? nearHookProps
            : i >= segments - 2
            ? nearCardProps
            : segmentProps)}
        >
          <BallCollider args={[0.08]} />
        </RigidBody>
      ))}

      {/* Joints */}
      {joints.current.map((ref, i) => {
        const a = i === 0 ? fixed : joints.current[i - 1];
        const b = joints.current[i];
        return <RopeLink key={`rope-${i}`} a={a} b={b} length={segmentLength} />;
      })}
      <SphericalLink
        a={joints.current[segments - 1]}
        b={card}
        anchorA={[0, 0, 0]}
        anchorB={[0, 1.85, 0]}
      />

      {/* Badge rigid body */}
      <RigidBody
        ref={card}
        position={[
          initialAx,
          initialAy - (segments + 1) * segmentLength - 0.4,
          initialAz,
        ]}
        {...nearCardProps}
        angularDamping={14}
        linearDamping={4}
        type={dragged ? "kinematicPosition" : "dynamic"}
      >
        <CuboidCollider args={[0.8, 1.125, 0.06]} />

        {/* IMPORTANT FIX:
            Use an invisible "hitbox" mesh for pointer events (reliable in iframe).
            The visible GLB stays unchanged underneath.
        */}
        <group scale={2.25} position={[0, -0.9, 0]}>
          {/* Invisible hitbox for grabbing + clicking */}
          <mesh
            position={[0, 0.2, 0.05]}
            onPointerOver={() => hover(true)}
            onPointerOut={() => hover(false)}
            onPointerDown={(e) => {
              e.stopPropagation();
              capturePointer(e);

              pointerDown.current = true;
              dragStarted.current = false;
              downXY.current = [e.clientX, e.clientY];

              dragOffset.current
                .copy(e.point)
                .sub(vec.copy(card.current.translation()));
            }}
            onPointerMove={(e) => {
              if (!pointerDown.current) return;

              const [sx, sy] = downXY.current;
              const dx = e.clientX - sx;
              const dy = e.clientY - sy;

              if (!dragStarted.current && Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD) {
                dragStarted.current = true;
                drag(dragOffset.current.clone());
              }
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              releasePointer(e);

              if (!dragStarted.current) {
                const next = !flipped;
                setFlipped(next);
                targetRotY.current = next ? Math.PI : 0;
              }

              pointerDown.current = false;
              dragStarted.current = false;
              drag(false);
            }}
          >
            {/* Sized so: after scale(2.25), it becomes ~ (1.62 x 2.25) which matches your collider */}
            <planeGeometry args={[0.72, 1.0]} />
            <meshBasicMaterial transparent opacity={0} />
          </mesh>

          {/* Visible model */}
          <group ref={modelGroup}>
            <primitive object={scene} />
          </group>
        </group>
      </RigidBody>

      {/* Rigid rectangle strap stub right at the clip */}
      <mesh ref={strapStub} geometry={strapStubGeo} renderOrder={10}>
        <meshStandardMaterial map={texture} transparent side={THREE.DoubleSide} />
      </mesh>

      {/* Strap (meshline) */}
      <mesh ref={band}>
        <meshLineGeometry />
        <meshLineMaterial
          color="white"
          depthTest={false}
          resolution={[width, height]}
          useMap
          map={texture}
          repeat={[-3, 1]}
          lineWidth={0.6}
        />
      </mesh>
    </>
  );
}