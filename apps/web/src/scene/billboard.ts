// Paper flags and labels that turn to face the viewer (O2-054). `Object3D.lookAt` recomputes the object's whole
// ancestor chain every call (6 parents per globe pin, ~8 labels per cloche), and every piece read the camera's world
// position again. The director now reads the camera once per frame, and this aims from the matrices the renderer
// computed last frame (a moving parent lags by one frame, which is invisible), with no chain walk.
import * as THREE from "three";

const _pos = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/**
 * Turn `obj` so its +Z faces `camPos` (world space), like `obj.lookAt(camPos)` for a non-camera object. `parent`
 * is the object whose world matrix `obj`'s transform is relative to (its scene parent by default).
 */
export function billboard(obj: THREE.Object3D, camPos: THREE.Vector3, parent: THREE.Object3D | null = obj.parent) {
  if (!parent) return;
  _pos.copy(obj.position).applyMatrix4(parent.matrixWorld);
  _m.lookAt(camPos, _pos, obj.up);
  obj.quaternion.setFromRotationMatrix(_m);
  _q.setFromRotationMatrix(_m.extractRotation(parent.matrixWorld));
  obj.quaternion.premultiply(_q.invert());
}
