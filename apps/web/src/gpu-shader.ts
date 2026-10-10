/** raytrace-v1 evaluated on independent pixels. Sensitive f32 boundary pixels are repaired by the CPU. */
export const animationShader = /* wgsl */ `
struct Sphere {
  centerRadius: vec4<f32>,
  colorReflection: vec4<f32>,
  roughness: vec4<f32>,
}
struct Parameters {
  dimensions: vec4<u32>,
  quality: vec4<u32>,
  camera: vec4<f32>,
  forward: vec4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
  light: vec4<f32>,
  spheres: array<Sphere, 5>,
}
struct PixelResult { rgba: u32, repair: u32 }
@group(0) @binding(0) var<uniform> scene: Parameters;
@group(0) @binding(1) var<storage, read_write> pixels: array<PixelResult>;
var<private> seed: u32;
var<private> needsRepair: bool;
const EPSILON: f32 = 0.0001;
const FIELD_OF_VIEW: f32 = 0.3249196962329063;

fn random() -> f32 {
  seed = seed * 1664525u + 1013904223u;
  return f32(seed) / 4294967296.0;
}
fn environment(direction: vec3<f32>) -> vec3<f32> {
  let sky = clamp(direction.y * 0.75 + 0.2, 0.0, 1.0);
  let panel = pow(max(0.0, -direction.x * 0.4 + direction.y * 0.65 + direction.z * 0.65), 36.0) * 2.4;
  return vec3<f32>(0.16, 0.25, 0.4) * (1.0 - sky) + vec3<f32>(0.018, 0.045, 0.1) * sky + vec3<f32>(panel);
}
fn sphereHit(origin: vec3<f32>, direction: vec3<f32>, sphere: Sphere) -> f32 {
  let offset = origin - sphere.centerRadius.xyz;
  let halfB = dot(offset, direction);
  let distanceSquared = dot(offset, offset);
  let radiusSquared = sphere.centerRadius.w * sphere.centerRadius.w;
  let discriminant = halfB * halfB - (distanceSquared - radiusSquared);
  // Near tangent rays can choose a different object in f32. Repair the complete pixel in f64.
  let uncertainty = 0.0001 * (halfB * halfB + distanceSquared + radiusSquared + 1.0);
  if (abs(discriminant) < uncertainty) { needsRepair = true; }
  if (discriminant <= 0.0) { return -1.0; }
  let distance = -halfB - sqrt(discriminant);
  if (abs(distance - EPSILON) < 0.000025) { needsRepair = true; }
  return distance;
}
fn shadowed(origin: vec3<f32>, direction: vec3<f32>, distance: f32) -> bool {
  for (var index = 0u; index < 5u; index += 1u) {
    let hit = sphereHit(origin, direction, scene.spheres[index]);
    if (abs(hit - distance) < 0.0002) { needsRepair = true; }
    if (hit > EPSILON && hit < distance) { return true; }
  }
  return false;
}
fn trace(initialDirection: vec3<f32>) -> vec3<f32> {
  let previousRepair = needsRepair;
  needsRepair = false;
  var direction = initialDirection;
  var origin = scene.camera.xyz;
  var primaryDistance = 0.0;
  var throughput = vec3<f32>(1.0);
  var accumulated = vec3<f32>(0.0);
  for (var bounce = 0u; bounce < scene.quality.y; bounce += 1u) {
    var closest = 1e30;
    if (abs(direction.y + EPSILON) < 0.00001) { needsRepair = true; }
    if (direction.y < -EPSILON) {
      let planeDistance = -origin.y / direction.y;
      if (planeDistance > EPSILON) { closest = planeDistance; }
    }
    var object = -1;
    for (var index = 0u; index < 5u; index += 1u) {
      let distance = sphereHit(origin, direction, scene.spheres[index]);
      if (abs(distance - closest) < 0.0002) { needsRepair = true; }
      if (distance > EPSILON && distance < closest) { closest = distance; object = i32(index); }
    }
    if (closest == 1e30) {
      accumulated += throughput * environment(direction);
      throughput = vec3<f32>(0.0);
      break;
    }
    if (bounce == 0u) { primaryDistance = closest; }
    let position = origin + direction * closest;
    var normal = vec3<f32>(0.0, 1.0, 0.0);
    var color = vec3<f32>(0.0);
    var reflection = 0.17;
    var roughness = 0.025;
    if (object < 0) {
      let tx = position.x * 0.85;
      let tz = position.z * 0.85;
      // Checkerboard discontinuities amplify tiny position errors, especially near the horizon.
      let tolerance = min(0.1, 0.0001 * (1.0 + abs(closest)));
      if ((bounce != 0u || closest < 150.0) &&
        (min(fract(tx), 1.0 - fract(tx)) < tolerance || min(fract(tz), 1.0 - fract(tz)) < tolerance)) {
        needsRepair = true;
      }
      let tile = (i32(floor(tx)) + i32(floor(tz))) & 1;
      color = select(vec3<f32>(0.07, 0.095, 0.14), vec3<f32>(0.045, 0.06, 0.09), tile != 0);
    } else {
      let sphere = scene.spheres[u32(object)];
      normal = (position - sphere.centerRadius.xyz) / sphere.centerRadius.w;
      color = sphere.colorReflection.xyz;
      reflection = sphere.colorReflection.w;
      roughness = sphere.roughness.x;
    }
    let lightX = scene.light.x + (random() - 0.5) * 2.0;
    let lightZ = scene.light.z + (random() - 0.5) * 2.0;
    let lightOffset = vec3<f32>(lightX, scene.light.y, lightZ) - position;
    let lightDistance = length(lightOffset);
    let lightDirection = lightOffset / lightDistance;
    var diffuse = max(0.0, dot(normal, lightDirection));
    var isShadowed = false;
    if (diffuse > 0.0) { isShadowed = shadowed(position + normal * EPSILON, lightDirection, lightDistance); }
    if (isShadowed) { diffuse = 0.0; }
    let falloff = 85.0 / (lightDistance * lightDistance + 20.0);
    let illumination = 0.16 + 0.12 * max(0.0, normal.y) + diffuse * falloff;
    let facing = max(0.0, -dot(direction, normal));
    // WGSL pow() is undefined for negative bases; f32 surface normals can make facing slightly > 1.
    let grazing = 1.0 - facing;
    reflection += (1.0 - reflection) * grazing * grazing * grazing * grazing * grazing * 0.8;
    let specularBase = max(0.0, -dot(direction, 2.0 * diffuse * normal - lightDirection));
    let specular = select(pow(specularBase, 80.0) * falloff * 0.45, 0.0, isShadowed);
    accumulated += throughput * (color * illumination * (1.0 - reflection) + vec3<f32>(specular));
    throughput *= reflection * select(0.3 + color * 0.7, vec3<f32>(0.95), object < 0);
    let normalDot = dot(direction, normal);
    let jitterX = (random() - 0.5) * roughness;
    let jitterY = (random() - 0.5) * roughness;
    let jitterZ = (random() - 0.5) * roughness;
    direction = normalize(direction - 2.0 * normalDot * normal + vec3<f32>(jitterX, jitterY, jitterZ));
    origin = position + normal * EPSILON;
  }
  if (throughput.x > 0.0) { accumulated += throughput * environment(direction); }
  let fog = 1.0 - exp(-max(0.0, primaryDistance - 14.0) / 35.0);
  // Distant floor discontinuities have negligible contrast after fog; keep repairing the
  // scene's finite geometry where divergent branches can affect the displayed pixel.
  needsRepair = previousRepair || (needsRepair && primaryDistance < 150.0);
  return accumulated * (1.0 - fog) + environment(initialDirection) * fog;
}
fn channel(linear: f32) -> u32 {
  let exposed = max(0.0, linear) * 1.35;
  return u32(floor(255.0 * sqrt(exposed / (1.0 + exposed)) + 0.5));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let width = scene.dimensions.x;
  let height = scene.dimensions.y;
  if (index >= width * scene.quality.w) { return; }
  let x = index % width;
  let y = scene.quality.z + index / width;
  seed = ((x + 1u) * 1973u) ^ ((y + 1u) * 9277u) ^ ((scene.dimensions.w + 1u) * 26699u);
  needsRepair = false;
  var color = vec3<f32>(0.0);
  for (var sample = 0u; sample < scene.quality.x; sample += 1u) {
    let horizontal = ((f32(x) + random()) / f32(width) * 2.0 - 1.0) * f32(width) / f32(height) * FIELD_OF_VIEW;
    let vertical = (1.0 - (f32(y) + random()) / f32(height) * 2.0) * FIELD_OF_VIEW;
    let direction = normalize(scene.forward.xyz + scene.right.xyz * horizontal + scene.up.xyz * vertical);
    color += trace(direction);
  }
  color /= f32(scene.quality.x);
  let packed = channel(color.x) | (channel(color.y) << 8u) | (channel(color.z) << 16u) | 0xff000000u;
  pixels[index] = PixelResult(packed, select(0u, 1u, needsRepair));
}
`;
