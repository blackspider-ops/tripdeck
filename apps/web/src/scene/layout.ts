// Where the viewer looks (O2-034): the chart room's framing, shared by the Stage, the laptop view and the Gallery.
import * as THREE from "three";

/** A little above the chart's centre: the default camera target on a laptop and in the Gallery. */
export const TABLE_TARGET: Readonly<THREE.Vector3> = new THREE.Vector3(0, 0.1, 0);
